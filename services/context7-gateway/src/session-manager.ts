import { spawn } from "bun";
import type { GatewayConfig } from "./config";

const encoder = new TextEncoder();

type StreamController = ReadableStreamDefaultController<Uint8Array>;
type PipedSubprocess = Bun.Subprocess<"pipe", "pipe", "pipe">;

type SessionFailureKind =
  | "child_exited"
  | "session_destroyed"
  | "timed_out_before_response"
  | "timed_out_waiting_for_response";

interface PendingRequest {
  reject: (error: Error) => void;
  resolve: (line: string) => void;
  timer: ReturnType<typeof setTimeout>;
}

interface SessionExitInfo {
  code: number;
  exitedAt: number;
}

interface StreamSubscriber {
  closeOnMatch: boolean;
  controller: StreamController;
  destroySessionOnClose: boolean;
  onClose?: () => void;
  targetRpcId: string | null;
}

interface Session {
  createdAt: number;
  exitInfo: SessionExitInfo | null;
  firstStdoutAt: number | null;
  id: string;
  lastActivityAt: number;
  legacyBuffer: string[];
  legacySubscriber: StreamSubscriber | null;
  pending: Map<string, PendingRequest>;
  proc: PipedSubprocess;
  reapTimer: ReturnType<typeof setTimeout>;
  sawJsonRpcResponse: boolean;
  streamSubscribers: Set<StreamSubscriber>;
  stdoutLineCount: number;
}

export interface SessionSnapshot {
  ageMs: number;
  id: string;
  idleMs: number;
  pendingRequests: number;
}

interface RpcStreamOptions {
  destroyOnClose: boolean;
  targetRpcId: string | null;
}

interface WriteAndAwaitOptions {
  destroyOnTimeoutBeforeResponse?: boolean;
}

export class SessionFailure extends Error {
  constructor(
    message: string,
    readonly kind: SessionFailureKind,
  ) {
    super(message);
    this.name = "SessionFailure";
  }
}

function jsonRpcIdOf(line: string): string | null {
  try {
    const parsed = JSON.parse(line) as { id?: string | number | null };
    if (parsed.id === undefined || parsed.id === null) return null;
    return String(parsed.id);
  } catch {
    return null;
  }
}

function sessionLabel(id: string): string {
  return id.slice(0, 8);
}

export class SessionManager {
  private readonly sessions = new Map<string, Session>();

  constructor(
    private readonly config: GatewayConfig,
    private readonly env: Record<string, string | undefined>,
  ) {}

  sessionCount(): number {
    return this.sessions.size;
  }

  sessionSnapshots(): SessionSnapshot[] {
    const now = Date.now();
    return [...this.sessions.values()].map((session) => ({
      ageMs: now - session.createdAt,
      id: session.id,
      idleMs: now - session.lastActivityAt,
      pendingRequests: session.pending.size,
    }));
  }

  get(id: string): Session | undefined {
    return this.sessions.get(id);
  }

  getOrCreate(id?: string): Session {
    if (id) {
      const existing = this.sessions.get(id);
      if (existing) return existing;
      return this.create(id);
    }

    return this.create(crypto.randomUUID());
  }

  destroy(id: string): void {
    const session = this.sessions.get(id);
    if (!session) return;

    clearTimeout(session.reapTimer);
    this.sessions.delete(id);

    try {
      session.proc.kill();
    } catch {
      // ignore already-exited children
    }

    this.closeSessionStreams(session);
    session.legacySubscriber = null;

    for (const pending of session.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new SessionFailure("Session destroyed", "session_destroyed"));
    }
    session.pending.clear();
  }

  shutdown(): void {
    for (const id of [...this.sessions.keys()]) {
      this.destroy(id);
    }
  }

  createLegacyStream(session: Session, endpointUrl: string): ReadableStream<Uint8Array> {
    return new ReadableStream<Uint8Array>({
      start: (controller) => {
        const subscriber = this.createSubscriber(controller, {
          closeOnMatch: false,
          destroySessionOnClose: false,
          onClose: () => {
            if (session.legacySubscriber === subscriber) {
              session.legacySubscriber = null;
            }
          },
          targetRpcId: null,
        });
        session.legacySubscriber = subscriber;

        for (const buffered of session.legacyBuffer) {
          controller.enqueue(encoder.encode(buffered));
        }
        session.legacyBuffer = [];

        controller.enqueue(encoder.encode(`event: endpoint\ndata: ${endpointUrl}\n\n`));
      },
      cancel: () => {
        this.destroy(session.id);
      },
    });
  }

  createRpcStream(session: Session, options: RpcStreamOptions): ReadableStream<Uint8Array> {
    return new ReadableStream<Uint8Array>({
      start: (controller) => {
        const subscriber = this.createSubscriber(controller, {
          closeOnMatch: options.targetRpcId !== null,
          destroySessionOnClose: options.destroyOnClose,
          onClose: () => {
            session.streamSubscribers.delete(subscriber);
            if (subscriber.destroySessionOnClose) {
              this.destroy(session.id);
            }
          },
          targetRpcId: options.targetRpcId,
        });
        session.streamSubscribers.add(subscriber);
      },
      cancel: () => {
        for (const subscriber of [...session.streamSubscribers]) {
          if (subscriber.targetRpcId === options.targetRpcId && subscriber.destroySessionOnClose === options.destroyOnClose) {
            session.streamSubscribers.delete(subscriber);
            this.closeSubscriber(subscriber);
            return;
          }
        }
      },
    });
  }

  async write(session: Session, body: string): Promise<void> {
    session.lastActivityAt = Date.now();
    this.scheduleReap(session);
    session.proc.stdin.write(encoder.encode(`${body.trim()}\n`));
    await session.proc.stdin.flush();
  }

  async writeAndAwait(
    session: Session,
    body: string,
    rpcId: string,
    options: WriteAndAwaitOptions = {},
  ): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => {
        session.pending.delete(rpcId);
        const error = this.timeoutFailure(session, rpcId);
        if (options.destroyOnTimeoutBeforeResponse && !session.sawJsonRpcResponse) {
          this.destroy(session.id);
        }
        reject(error);
      }, this.config.requestTimeoutMs);

      session.pending.set(rpcId, { reject, resolve, timer });
      this.write(session, body).catch((error) => {
        session.pending.delete(rpcId);
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error(String(error)));
      });
    });
  }

  private buildChildEnv(): Record<string, string> {
    const childEnv: Record<string, string> = {};

    for (const key of this.config.childEnvAllowlist) {
      const value = this.env[key];
      if (value !== undefined) childEnv[key] = value;
    }

    return childEnv;
  }

  private create(id: string): Session {
    const proc: PipedSubprocess = spawn({
      cmd: this.config.childCommand,
      env: this.buildChildEnv(),
      stderr: "pipe",
      stdin: "pipe",
      stdout: "pipe",
    });

    const session: Session = {
      createdAt: Date.now(),
      exitInfo: null,
      firstStdoutAt: null,
      id,
      lastActivityAt: Date.now(),
      legacyBuffer: [],
      legacySubscriber: null,
      pending: new Map(),
      proc,
      reapTimer: setTimeout(() => undefined, this.config.sessionTimeoutMs),
      sawJsonRpcResponse: false,
      streamSubscribers: new Set(),
      stdoutLineCount: 0,
    };

    this.sessions.set(id, session);
    this.logSessionEvent(session, "child_spawned", {
      childCommand: this.config.childCommand.join(" "),
    });
    this.scheduleReap(session);
    void this.observeExit(session);
    void this.pumpStderr(session);
    void this.pumpStdout(session);
    return session;
  }

  private dispatchLine(session: Session, line: string): void {
    session.lastActivityAt = Date.now();
    session.stdoutLineCount += 1;
    this.scheduleReap(session);

    if (session.firstStdoutAt === null) {
      session.firstStdoutAt = Date.now();
      this.logSessionEvent(session, "child_first_stdout", {
        linePreview: line.slice(0, 160),
      });
    }

    const rpcId = jsonRpcIdOf(line);
    if (rpcId) {
      session.sawJsonRpcResponse = true;
      const pending = session.pending.get(rpcId);
      if (pending) {
        clearTimeout(pending.timer);
        session.pending.delete(rpcId);
        pending.resolve(line);
      }
    }

    const sseMessage = `data: ${line}\n\n`;

    if (session.legacySubscriber) {
      this.enqueueMessage(session.legacySubscriber, sseMessage);
    } else {
      session.legacyBuffer.push(sseMessage);
      if (session.legacyBuffer.length > 500) session.legacyBuffer.shift();
    }

    for (const subscriber of [...session.streamSubscribers]) {
      this.enqueueMessage(subscriber, sseMessage);
      if (subscriber.closeOnMatch && subscriber.targetRpcId !== null && subscriber.targetRpcId === rpcId) {
        session.streamSubscribers.delete(subscriber);
        this.closeSubscriber(subscriber);
      }
    }
  }

  private async observeExit(session: Session): Promise<void> {
    const code = await session.proc.exited;
    session.exitInfo = {
      code,
      exitedAt: Date.now(),
    };

    if (!this.sessions.has(session.id)) {
      return;
    }

    this.logSessionEvent(session, "child_exited", {
      code,
      sawJsonRpcResponse: session.sawJsonRpcResponse,
      stdoutLineCount: session.stdoutLineCount,
    });

    const pending = [...session.pending.values()];
    session.pending.clear();
    for (const entry of pending) {
      clearTimeout(entry.timer);
      entry.reject(this.childExitFailure(session));
    }

    this.destroy(session.id);
  }

  private childExitFailure(session: Session): SessionFailure {
    const exitCode = session.exitInfo?.code ?? -1;
    return new SessionFailure(
      session.sawJsonRpcResponse
        ? `Session child exited with code ${exitCode} while requests were still pending`
        : `Session child exited with code ${exitCode} before responding to the initial request`,
      "child_exited",
    );
  }

  private timeoutFailure(session: Session, rpcId: string): SessionFailure {
    if (session.exitInfo) {
      return new SessionFailure(
        `RPC ${rpcId} failed because the child exited with code ${session.exitInfo.code} before responding`,
        "child_exited",
      );
    }

    if (session.firstStdoutAt === null) {
      return new SessionFailure(
        `RPC ${rpcId} timed out after ${this.config.requestTimeoutMs}ms before the child produced any stdout`,
        "timed_out_before_response",
      );
    }

    if (!session.sawJsonRpcResponse) {
      return new SessionFailure(
        `RPC ${rpcId} timed out after ${this.config.requestTimeoutMs}ms before the child produced a JSON-RPC response`,
        "timed_out_before_response",
      );
    }

    return new SessionFailure(
      `RPC ${rpcId} timed out after ${this.config.requestTimeoutMs}ms waiting for a JSON-RPC response`,
      "timed_out_waiting_for_response",
    );
  }

  private createSubscriber(
    controller: StreamController,
    subscriber: Omit<StreamSubscriber, "controller">,
  ): StreamSubscriber {
    return {
      controller,
      ...subscriber,
    };
  }

  private closeSessionStreams(session: Session): void {
    this.closeSubscriber(session.legacySubscriber, false);
    for (const subscriber of [...session.streamSubscribers]) {
      session.streamSubscribers.delete(subscriber);
      this.closeSubscriber(subscriber, false);
    }
  }

  private enqueueMessage(subscriber: StreamSubscriber, message: string): void {
    try {
      subscriber.controller.enqueue(encoder.encode(message));
    } catch {
      this.closeSubscriber(subscriber);
    }
  }

  private closeSubscriber(subscriber: StreamSubscriber | null, runOnClose = true): void {
    if (!subscriber) return;

    try {
      subscriber.controller.close();
    } catch {
      // ignore already-closed streams
    }

    if (runOnClose) {
      subscriber.onClose?.();
    }
  }

  private logSessionEvent(session: Session, event: string, details: Record<string, unknown>): void {
    console.log(`[gateway] ${JSON.stringify({
      event,
      sessionId: sessionLabel(session.id),
      ...details,
    })}`);
  }

  private async pumpStdout(session: Session): Promise<void> {
    const reader = session.proc.stdout.getReader();
    const decoder = new TextDecoder();
    let partial = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        if (this.sessions.has(session.id)) {
          this.logSessionEvent(session, "child_stdout_closed", {
            sawJsonRpcResponse: session.sawJsonRpcResponse,
            stdoutLineCount: session.stdoutLineCount,
          });
        }
        return;
      }

      partial += decoder.decode(value, { stream: true });
      const lines = partial.split("\n");
      partial = lines.pop() ?? "";

      for (const rawLine of lines) {
        const line = rawLine.trim();
        if (!line) continue;
        this.dispatchLine(session, line);
      }
    }
  }

  private async pumpStderr(session: Session): Promise<void> {
    const reader = session.proc.stderr.getReader();
    const decoder = new TextDecoder();

    while (true) {
      const { done, value } = await reader.read();
      if (done) return;
      process.stderr.write(`[session:${sessionLabel(session.id)}] ${decoder.decode(value)}`);
    }
  }

  private scheduleReap(session: Session): void {
    clearTimeout(session.reapTimer);
    session.reapTimer = setTimeout(() => {
      this.destroy(session.id);
    }, this.config.sessionTimeoutMs);
  }
}

export function parseJsonRpcId(body: string): string | null {
  return jsonRpcIdOf(body);
}
