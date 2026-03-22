import { afterEach, describe, expect, test } from "bun:test";
import { InMemoryStore, handleMemoryWrite } from "../../apps/runner/src/tools/memory";

const tempResources: Array<() => void> = [];

afterEach(() => {
  while (tempResources.length > 0) {
    const restore = tempResources.pop();
    restore?.();
  }
});

function mockDateNow(value: number): void {
  const original = Object.getOwnPropertyDescriptor(Date, "now");
  Object.defineProperty(Date, "now", {
    configurable: true,
    value: () => value,
  });
  tempResources.push(() => {
    if (original) {
      Object.defineProperty(Date, "now", original);
    }
  });
}

describe("runner memory tools", () => {
  test("overwriting a key resets the age timestamp", () => {
    const store = new InMemoryStore();

    mockDateNow(1_000_000);
    store.write("project", "alpha", "decision", { step: 1 }, [], null);

    mockDateNow(1_050_000);
    store.write("project", "alpha", "decision", { step: 2 }, [], null);

    mockDateNow(1_050_000);
    const result = store.read("project", "alpha", "decision");

    expect(result).toEqual({
      age_seconds: 0,
      found: true,
      value: { step: 2 },
      version: 2,
    });
  });

  test("remote writes preserve JSON shape", async () => {
    const calls: Array<{ body: unknown; url: string }> = [];

    const result = await handleMemoryWrite(
      {
        key: "config",
        namespace: "alpha",
        scope: "project",
        tags: ["init"],
        ttl_seconds: null,
        value: { nested: { enabled: true } },
      },
      {
        memoryUrl: "http://memory.example:8082",
        proxyToMemory: async (url, body) => {
          calls.push({ body, url });
          return { ok: true };
        },
        store: new InMemoryStore(),
      },
    );

    expect(calls).toEqual([
      {
        body: {
          key: "config",
          namespace: "alpha",
          scope: "project",
          tags: ["init"],
          ttl_seconds: null,
          value: { nested: { enabled: true } },
        },
        url: "http://memory.example:8082/write",
      },
    ]);
    expect(result).toEqual({ ok: true });
  });
});
