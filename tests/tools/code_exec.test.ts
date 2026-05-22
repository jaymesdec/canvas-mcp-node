import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { buildToolHarness } from "../_helpers/mockCanvas.js";
import { Anonymizer } from "../../src/anonymizer.js";
import { registerCodeExecutionTools } from "../../src/tools/code_exec.js";

interface ToolResponse {
  content?: Array<{ type: string; text: string }>;
  isError?: boolean;
  structuredContent?: Record<string, unknown>;
}

let anonRoot: string;
let anonymizer: Anonymizer;
let originalEnv: NodeJS.ProcessEnv;

beforeEach(async () => {
  originalEnv = { ...process.env };
  anonRoot = await fs.mkdtemp(path.join(os.tmpdir(), "canvas-anon-codeexec-"));
  anonymizer = new Anonymizer({ rootDir: anonRoot });
  await anonymizer.init();
  // Ensure the network guard doesn't blackhole the test's own runtime —
  // we never set TS_SANDBOX_BLOCK_OUTBOUND in the parent, so it doesn't matter.
  process.env.CANVAS_API_URL = process.env.CANVAS_API_URL ?? "https://canvas.example.com";
  process.env.CANVAS_API_TOKEN = process.env.CANVAS_API_TOKEN ?? "test-fake-token-do-not-use";
});

afterEach(async () => {
  process.env = originalEnv;
  await fs.rm(anonRoot, { recursive: true, force: true });
});

describe("registerCodeExecutionTools", () => {
  it("registers execute_typescript and list_code_api_modules", () => {
    const harness = buildToolHarness();
    registerCodeExecutionTools(harness.server as never, anonymizer);
    expect([...harness.tools.keys()].sort()).toEqual([
      "execute_typescript",
      "list_code_api_modules",
    ]);
  });

  it("list_code_api_modules returns the importable module catalog", async () => {
    const harness = buildToolHarness();
    registerCodeExecutionTools(harness.server as never, anonymizer);
    const result = (await harness.call("list_code_api_modules")) as ToolResponse;
    expect(result.isError).toBeFalsy();
    const modules = result.structuredContent?.modules as Array<{ module: string; exports: string[] }>;
    expect(modules.some((entry) => entry.module === "./anonymizer.js")).toBe(true);
    expect(modules.some((entry) => entry.module === "./canvas/grading/bulkGrade.js")).toBe(true);
    expect(result.structuredContent?.ferpa_note).toMatch(/anonymizer\.js/);
  });

  describe("execute_typescript (real worker)", () => {
    it("runs console.log and returns stdout", async () => {
      const harness = buildToolHarness();
      registerCodeExecutionTools(harness.server as never, anonymizer);
      const result = (await harness.call("execute_typescript", {
        code: 'console.log("hello from worker", 1 + 2);',
        timeout_seconds: 30,
      })) as ToolResponse;
      expect(result.isError).toBeFalsy();
      expect(result.structuredContent?.ok).toBe(true);
      expect(result.structuredContent?.stdout).toContain("hello from worker 3");
      const text = result.content?.[0]?.text ?? "";
      expect(text).toContain("✅");
    }, 30_000);

    it("syntax error returns a structured error result without crashing the harness", async () => {
      const harness = buildToolHarness();
      registerCodeExecutionTools(harness.server as never, anonymizer);
      const result = (await harness.call("execute_typescript", {
        code: "this is not valid typescript;",
        timeout_seconds: 30,
      })) as ToolResponse;
      expect(result.isError).toBeFalsy(); // it's a tool RESULT, just with ok:false
      expect(result.structuredContent?.ok).toBe(false);
      const text = result.content?.[0]?.text ?? "";
      expect(text).toContain("❌");
    }, 30_000);

    it("infinite loop is terminated at the timeout", async () => {
      const harness = buildToolHarness();
      registerCodeExecutionTools(harness.server as never, anonymizer);
      const result = (await harness.call("execute_typescript", {
        code: "while (true) { /* spin */ }",
        timeout_seconds: 2,
      })) as ToolResponse;
      expect(result.structuredContent?.timed_out).toBe(true);
      expect(result.content?.[0]?.text).toContain("timed out");
    }, 15_000);

    it("network guard blocks an outbound fetch to a non-allowlisted host", async () => {
      process.env.TS_SANDBOX_BLOCK_OUTBOUND = "true";
      // Explicitly set allowlist to nothing useful so example.com is blocked.
      process.env.TS_SANDBOX_ALLOWLIST_HOSTS = "canvas.example.com";
      const harness = buildToolHarness();
      registerCodeExecutionTools(harness.server as never, anonymizer);
      const result = (await harness.call("execute_typescript", {
        code: `
          try {
            await fetch("https://example.com/secret");
            console.log("FETCH_SUCCEEDED");
          } catch (e: any) {
            console.log("CAUGHT:", e.name, e.message);
          }
        `,
        timeout_seconds: 15,
      })) as ToolResponse;
      const stdout = (result.structuredContent?.stdout as string) ?? "";
      expect(stdout).toContain("SANDBOX_NETWORK_BLOCKED");
      expect(stdout).not.toContain("FETCH_SUCCEEDED");
    }, 30_000);

    it("user code can import the code_api anonymizer adapter and pseudonymize", async () => {
      // Pre-seed the on-disk map so the worker's anonymizer sees Student 1 → 1001 etc.
      await anonymizer.mergeIntoMap(60366, [
        { id: 1001, name: "Alice Real", role: "student" },
        { id: 1002, name: "Bob Real", role: "student" },
      ]);

      const harness = buildToolHarness();
      registerCodeExecutionTools(harness.server as never, anonymizer);

      const result = (await harness.call("execute_typescript", {
        code: `
          import { anonymizeUsers } from "./anonymizer.js";
          const users = [
            { id: 1001, name: "Alice Real", role: "student" },
            { id: 1002, name: "Bob Real",   role: "student" },
          ];
          const anonymized = await anonymizeUsers(60366, users);
          console.log(JSON.stringify(anonymized.map((u: any) => u.name)));
        `,
        timeout_seconds: 30,
      })) as ToolResponse;
      expect(result.structuredContent?.ok).toBe(true);
      const stdout = (result.structuredContent?.stdout as string) ?? "";
      expect(stdout).toContain('"Student 1"');
      expect(stdout).toContain('"Student 2"');
      expect(stdout).not.toContain("Alice Real");
    }, 30_000);

    it("scrubs the CANVAS_API_TOKEN value from stdout/stderr if user code logs it", async () => {
      process.env.CANVAS_API_TOKEN = "very-secret-token-1234567890";
      const harness = buildToolHarness();
      registerCodeExecutionTools(harness.server as never, anonymizer);
      const result = (await harness.call("execute_typescript", {
        code: 'console.log("token is:", process.env.CANVAS_API_TOKEN);',
        timeout_seconds: 15,
      })) as ToolResponse;
      const stdout = (result.structuredContent?.stdout as string) ?? "";
      expect(stdout).not.toContain("very-secret-token-1234567890");
      expect(stdout).toContain("***REDACTED***");
    }, 30_000);
  });
});
