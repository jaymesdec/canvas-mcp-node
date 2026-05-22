import { Worker } from "node:worker_threads";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import type { Anonymizer } from "../anonymizer.js";
import { jsonResult, safeHandler, textResult } from "./toolHelpers.js";

interface WorkerResult {
  ok: boolean;
  stdout: string;
  stderr: string;
  error?: string;
  errorName?: string;
  stack?: string;
  durationMs: number;
}

const DEFAULT_TIMEOUT_S = 120;
const MAX_TIMEOUT_S = 600;
const DEFAULT_MEMORY_MB = 512;

const EXECUTE_TYPESCRIPT_INPUT = {
  code: z
    .string()
    .min(1)
    .describe(
      "TypeScript source. Can import from ./canvas/grading/bulkGrade.js, ./anonymizer.js (FERPA-safe), and other code_api/ modules. Runs in a worker_thread; the MCP keeps serving other tools.",
    ),
  timeout_seconds: z
    .number()
    .int()
    .positive()
    .max(MAX_TIMEOUT_S)
    .optional()
    .describe(`Per-execution timeout. Defaults to ${DEFAULT_TIMEOUT_S}s; max ${MAX_TIMEOUT_S}s.`),
  memory_mb: z
    .number()
    .int()
    .positive()
    .max(4096)
    .optional()
    .describe(`Old-generation heap cap in MB. Defaults to ${DEFAULT_MEMORY_MB}. Note: Buffer/ArrayBuffer use external memory and are NOT bounded by this; rely on the timeout for those.`),
};

const HERE = fileURLToPath(import.meta.url);
const TOOL_DIR = path.dirname(HERE);
const WORKER_FILE_TS = path.resolve(TOOL_DIR, "..", "workers", "ts_exec_worker.ts");
const WORKER_FILE_JS = path.resolve(TOOL_DIR, "..", "workers", "ts_exec_worker.js");

const CODE_API_MODULES = [
  { module: "./canvas/courses/listCourses.js", exports: ["listCourses"] },
  { module: "./canvas/courses/getCourseDetails.js", exports: ["getCourseDetails"] },
  { module: "./canvas/assignments/listSubmissions.js", exports: ["listSubmissions"] },
  { module: "./canvas/grading/gradeWithRubric.js", exports: ["gradeWithRubric"] },
  { module: "./canvas/grading/bulkGrade.js", exports: ["bulkGrade"] },
  { module: "./anonymizer.js", exports: ["anonymizeUser", "anonymizeUsers", "anonymizeSubmission", "anonymizeSubmissions", "classifyRole"] },
  { module: "./client.js", exports: ["canvasGet", "canvasPost", "canvasPut", "canvasDelete", "canvasPutForm", "fetchAllPaginated", "initializeCanvasClient"] },
];

function formatHumanReadable(result: WorkerResult, options: { timedOut?: boolean }): string {
  const lines: string[] = [];
  if (options.timedOut) {
    lines.push("❌ Execution timed out");
  } else if (result.ok) {
    lines.push(`✅ Execution completed in ${result.durationMs}ms`);
  } else {
    lines.push(`❌ Execution failed: ${result.errorName ?? "Error"}: ${result.error ?? "unknown error"}`);
  }
  if (result.stdout) {
    lines.push("", "── stdout ──", result.stdout);
  }
  if (result.stderr) {
    lines.push("", "── stderr ──", result.stderr);
  }
  if (!result.ok && result.stack) {
    lines.push("", "── stack ──", result.stack);
  }
  return lines.join("\n");
}

function pickEnvForWorker(): Record<string, string> {
  // Pass only the keys user code legitimately needs. Do NOT leak the parent's
  // full process.env (which may contain unrelated secrets).
  const allowed = [
    "CANVAS_API_URL",
    "CANVAS_API_TOKEN",
    "TS_SANDBOX_BLOCK_OUTBOUND",
    "TS_SANDBOX_ALLOWLIST_HOSTS",
    "ANON_MAP_DIR",
  ];
  const env: Record<string, string> = {};
  for (const key of allowed) {
    const value = process.env[key];
    if (typeof value === "string" && value.length > 0) env[key] = value;
  }
  // Ensure the Canvas host is in the allowlist (unless explicitly cleared).
  if (env.TS_SANDBOX_ALLOWLIST_HOSTS === undefined && env.CANVAS_API_URL) {
    try {
      const host = new URL(env.CANVAS_API_URL).hostname;
      env.TS_SANDBOX_ALLOWLIST_HOSTS = host;
    } catch {
      // ignore malformed URL — guard will block all hosts
    }
  }
  return env;
}

export function registerCodeExecutionTools(server: McpServer, anonymizer: Anonymizer): void {
  server.registerTool(
    "execute_typescript",
    {
      description:
        "Run a snippet of TypeScript in an isolated worker_thread. User code can import from the lifted code_api/ modules — including the FERPA-safe ./anonymizer.js adapter that pseudonymizes student data the same way the typed tools do. Network outbound is blocked by default except to the Canvas host (set via TS_SANDBOX_ALLOWLIST_HOSTS). Crashes, infinite loops, and OOM stay isolated to the worker and never take down the MCP.",
      inputSchema: EXECUTE_TYPESCRIPT_INPUT,
    },
    async (input) => {
      const args = input as z.infer<z.ZodObject<typeof EXECUTE_TYPESCRIPT_INPUT>>;
      return safeHandler("execute_typescript", async () => {
        const timeoutMs = Math.min((args.timeout_seconds ?? DEFAULT_TIMEOUT_S) * 1000, MAX_TIMEOUT_S * 1000);
        const memoryMb = args.memory_mb ?? DEFAULT_MEMORY_MB;
        const env = pickEnvForWorker();

        const workerFile = await resolveWorkerFile();
        const worker = new Worker(workerFile, {
          workerData: {
            code: args.code,
            env,
            anonRootDir: anonymizer.rootDir,
          },
          // Register tsx in the worker so it can import .ts files (the lifted
          // code_api/, the user temp file, and the network guard).
          execArgv: ["--import", "tsx/esm"],
          resourceLimits: {
            maxOldGenerationSizeMb: memoryMb,
          },
        });

        const result = await runWorker(worker, timeoutMs);
        const text = formatHumanReadable(result.payload, { timedOut: result.timedOut });
        const structured = result.timedOut
          ? {
              ok: false,
              timed_out: true,
              timeout_seconds: args.timeout_seconds ?? DEFAULT_TIMEOUT_S,
              memory_mb: memoryMb,
            }
          : {
              ok: result.payload.ok,
              timed_out: false,
              duration_ms: result.payload.durationMs,
              stdout: result.payload.stdout,
              stderr: result.payload.stderr,
              ...(result.payload.error
                ? { error: result.payload.error, error_name: result.payload.errorName, stack: result.payload.stack }
                : {}),
            };
        return { ...textResult(text), structuredContent: structured };
      });
    },
  );

  server.registerTool(
    "list_code_api_modules",
    {
      description:
        "List the modules importable from inside execute_typescript user code (and the symbols they export). Use this to discover what's available before writing a snippet.",
      inputSchema: {},
    },
    async () => {
      return safeHandler("list_code_api_modules", async () => {
        return jsonResult(
          {
            base_path: "./",
            modules: CODE_API_MODULES,
            ferpa_note:
              "Always prefer ./anonymizer.js for any student-facing transformation in user code. It binds to the SAME on-disk pseudonym map as the typed tools (e.g., list_users, list_submissions).",
          },
          {
            summary: `${CODE_API_MODULES.length} module(s) importable from execute_typescript user code.`,
          },
        );
      });
    },
  );
}

async function resolveWorkerFile(): Promise<string> {
  const { promises: fs } = await import("node:fs");
  // Prefer the .js (built) file when present; fall back to .ts for dev (tsx).
  try {
    await fs.access(WORKER_FILE_JS);
    return WORKER_FILE_JS;
  } catch {
    return WORKER_FILE_TS;
  }
}

interface RunResult {
  payload: WorkerResult;
  timedOut: boolean;
}

function runWorker(worker: Worker, timeoutMs: number): Promise<RunResult> {
  return new Promise<RunResult>((resolve) => {
    let settled = false;
    let received: WorkerResult | null = null;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      worker.terminate().catch(() => undefined);
      resolve({
        payload: { ok: false, stdout: "", stderr: "", durationMs: timeoutMs },
        timedOut: true,
      });
    }, timeoutMs);

    worker.on("message", (message: WorkerResult) => {
      received = message;
    });
    worker.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        payload: {
          ok: false,
          stdout: "",
          stderr: "",
          error: error instanceof Error ? error.message : String(error),
          errorName: error instanceof Error ? error.name : "Error",
          stack: error instanceof Error ? error.stack : undefined,
          durationMs: 0,
        },
        timedOut: false,
      });
    });
    worker.on("exit", (exitCode) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (received) {
        resolve({ payload: received, timedOut: false });
      } else {
        resolve({
          payload: {
            ok: false,
            stdout: "",
            stderr: "",
            error: `worker exited with code ${exitCode} before posting a result`,
            errorName: "WorkerExitedEarly",
            durationMs: 0,
          },
          timedOut: false,
        });
      }
    });
  });
}
