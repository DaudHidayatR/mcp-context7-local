/**
 * Tests for Cloudflare Worker — get_project_context handler
 *
 * Uses a simple KV mock (no npm deps needed for testing the logic).
 * These tests verify the correct sections are returned per task_type.
 */

import {
  handleGetProjectContext,
  TASK_TYPE_SECTIONS,
  truncateContext,
  isValidTaskType,
} from "./index";
import type { TaskType } from "./index";

// ---------------------------------------------------------------------------
// KV Mock
// ---------------------------------------------------------------------------

class MockKV {
  private store: Map<string, string>;

  constructor(data: Record<string, string> = {}) {
    this.store = new Map(Object.entries(data));
  }

  async get(key: string, _type?: string): Promise<string | null> {
    return this.store.get(key) ?? null;
  }

  async put(key: string, value: string): Promise<void> {
    this.store.set(key, value);
  }

  async delete(key: string): Promise<void> {
    this.store.delete(key);
  }

  async list(): Promise<{ keys: { name: string }[] }> {
    return { keys: Array.from(this.store.keys()).map((name) => ({ name })) };
  }

  async getWithMetadata(
    key: string,
    _type?: string
  ): Promise<{ value: string | null; metadata: unknown }> {
    return { value: this.store.get(key) ?? null, metadata: null };
  }
}

// ---------------------------------------------------------------------------
// Test data
// ---------------------------------------------------------------------------

const FULL_KV_DATA: Record<string, string> = {
  "prd:meta": JSON.stringify({
    name: "MyProject",
    version: "2.0",
    team: "platform",
  }),
  "prd:goals": JSON.stringify({
    primary: "Unified MCP server",
    milestones: ["alpha", "beta", "ga"],
  }),
  "prd:constraints": JSON.stringify({
    budget: "limited",
    timeline: "Q2 2026",
    security: "SOC2 compliant",
  }),
  "prd:architecture": JSON.stringify({
    components: ["worker", "rag", "memory"],
    adrs: [
      { id: 1, title: "Use CF Workers" },
      { id: 2, title: "Go for VPS" },
      { id: 3, title: "Postgres for memory" },
      { id: 4, title: "ChromaDB for RAG" },
      { id: 5, title: "KV for PRD" },
      { id: 6, title: "JSON-RPC 2.0" },
      { id: 7, title: "Bearer auth" },
    ],
  }),
  "prd:sops": JSON.stringify({
    incident_response: "Page oncall → diagnose → mitigate → postmortem",
    deployment: "CI/CD with canary",
  }),
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

interface TestCase {
  name: string;
  taskType: TaskType;
  kvData: Record<string, string>;
  expectedSections: string[];
  missingSection?: string;
}

const testCases: TestCase[] = [
  {
    name: "feature_dev returns meta + goals + architecture",
    taskType: "feature_dev",
    kvData: FULL_KV_DATA,
    expectedSections: ["meta", "goals", "architecture"],
  },
  {
    name: "security_review returns meta + constraints + sops",
    taskType: "security_review",
    kvData: FULL_KV_DATA,
    expectedSections: ["meta", "constraints", "sops"],
  },
  {
    name: "incident returns meta + sops + constraints",
    taskType: "incident",
    kvData: FULL_KV_DATA,
    expectedSections: ["meta", "sops", "constraints"],
  },
  {
    name: "general returns meta + goals",
    taskType: "general",
    kvData: FULL_KV_DATA,
    expectedSections: ["meta", "goals"],
  },
  {
    name: "feature_dev omits missing architecture silently",
    taskType: "feature_dev",
    kvData: {
      "prd:meta": FULL_KV_DATA["prd:meta"],
      "prd:goals": FULL_KV_DATA["prd:goals"],
      // prd:architecture is missing
    },
    expectedSections: ["meta", "goals"],
    missingSection: "architecture",
  },
  {
    name: "incident omits missing sops silently",
    taskType: "incident",
    kvData: {
      "prd:meta": FULL_KV_DATA["prd:meta"],
      "prd:constraints": FULL_KV_DATA["prd:constraints"],
      // prd:sops is missing
    },
    expectedSections: ["meta", "constraints"],
    missingSection: "sops",
  },
];

// ---------------------------------------------------------------------------
// Test runner (no framework — runs in any TS/JS runtime)
// ---------------------------------------------------------------------------

let passed = 0;
let failed = 0;

function assert(condition: boolean, message: string): void {
  if (!condition) {
    throw new Error(`Assertion failed: ${message}`);
  }
}

async function runTest(tc: TestCase): Promise<void> {
  const kv = new MockKV(tc.kvData) as unknown as KVNamespace;
  const result = await handleGetProjectContext(
    { task_type: tc.taskType },
    kv
  );

  const projectContext = (result as Record<string, unknown>)
    .project_context as Record<string, unknown>;

  assert(
    projectContext !== undefined,
    `${tc.name}: project_context should exist`
  );

  // Each expected section should be present
  for (const section of tc.expectedSections) {
    assert(
      projectContext[section] !== undefined,
      `${tc.name}: section '${section}' should be present`
    );
  }

  // feature_dev should NOT have constraints or sops
  if (tc.taskType === "feature_dev") {
    assert(
      projectContext["constraints"] === undefined,
      `${tc.name}: constraints should not be in feature_dev`
    );
    assert(
      projectContext["sops"] === undefined,
      `${tc.name}: sops should not be in feature_dev`
    );
  }

  // general should NOT have constraints, architecture, or sops
  if (tc.taskType === "general") {
    assert(
      projectContext["constraints"] === undefined,
      `${tc.name}: constraints should not be in general`
    );
    assert(
      projectContext["architecture"] === undefined,
      `${tc.name}: architecture should not be in general`
    );
    assert(
      projectContext["sops"] === undefined,
      `${tc.name}: sops should not be in general`
    );
  }

  // security_review should NOT have goals or architecture
  if (tc.taskType === "security_review") {
    assert(
      projectContext["goals"] === undefined,
      `${tc.name}: goals should not be in security_review`
    );
    assert(
      projectContext["architecture"] === undefined,
      `${tc.name}: architecture should not be in security_review`
    );
  }

  // Missing section should be omitted silently (not throw)
  if (tc.missingSection) {
    assert(
      projectContext[tc.missingSection] === undefined,
      `${tc.name}: missing '${tc.missingSection}' should be silently omitted`
    );
  }
}

async function testTruncateAdrs(): Promise<void> {
  const context: Record<string, unknown> = {
    architecture: {
      components: ["a", "b"],
      adrs: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10],
    },
  };

  const truncated = truncateContext(context);
  const arch = truncated.architecture as Record<string, unknown>;
  assert(
    Array.isArray(arch.adrs) && arch.adrs.length === 5,
    `ADRs should be truncated to 5, got ${(arch.adrs as unknown[]).length}`
  );
}

async function testInvalidTaskType(): Promise<void> {
  const kv = new MockKV({}) as unknown as KVNamespace;
  let threw = false;
  try {
    await handleGetProjectContext({ task_type: "invalid" }, kv);
  } catch {
    threw = true;
  }
  assert(threw, "Should throw on invalid task_type");
}

async function testIsValidTaskType(): Promise<void> {
  assert(isValidTaskType("feature_dev") === true, "feature_dev should be valid");
  assert(isValidTaskType("security_review") === true, "security_review should be valid");
  assert(isValidTaskType("incident") === true, "incident should be valid");
  assert(isValidTaskType("general") === true, "general should be valid");
  assert(isValidTaskType("invalid") === false, "invalid should not be valid");
  assert(isValidTaskType(42) === false, "number should not be valid");
  assert(isValidTaskType(null) === false, "null should not be valid");
}

// Run all tests
async function main(): Promise<void> {
  const allTests: { name: string; fn: () => Promise<void> }[] = [
    ...testCases.map((tc) => ({ name: tc.name, fn: () => runTest(tc) })),
    { name: "truncates ADRs to 5 items", fn: testTruncateAdrs },
    { name: "rejects invalid task_type", fn: testInvalidTaskType },
    { name: "isValidTaskType validates correctly", fn: testIsValidTaskType },
  ];

  for (const test of allTests) {
    try {
      await test.fn();
      console.log(`  ✓ ${test.name}`);
      passed++;
    } catch (err) {
      console.error(`  ✗ ${test.name}: ${(err as Error).message}`);
      failed++;
    }
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) {
    process.exit(1);
  }
}

main();
