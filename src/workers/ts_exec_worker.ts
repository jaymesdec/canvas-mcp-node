/**
 * Worker thread entry for execute_typescript.
 *
 * Receives user TypeScript via workerData, applies env, captures stdout/stderr,
 * runs the code, posts back { ok, stdout, stderr } or { ok: false, error, stack }.
 * Token-scrubs the literal CANVAS_API_TOKEN value out of any text before posting.
 *
 * The user code is written to a temp .ts file under code_api/ so its relative
 * imports (`./canvas/...`, `./anonymizer.js`) resolve. The first line of that
 * temp file is an import of the network guard, which monkey-patches outbound
 * I/O before any user import takes references.
 */
import { parentPort, workerData } from "node:worker_threads";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

interface WorkerInput {
  code: string;
  env: Record<string, string>;
  anonRootDir?: string;
}

interface WorkerResult {
  ok: boolean;
  stdout: string;
  stderr: string;
  error?: string;
  errorName?: string;
  stack?: string;
  durationMs: number;
}

const HERE = fileURLToPath(import.meta.url);
const WORKER_DIR = path.dirname(HERE);
const CODE_API_DIR = path.resolve(WORKER_DIR, "..", "code_api");

function formatValue(value: unknown): string {
  if (typeof value === "string") return value;
  if (value instanceof Error) return value.stack ?? value.message;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function scrubToken(text: string, token: string | undefined): string {
  if (!token || token.length < 8) return text;
  const escaped = token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return text.replace(new RegExp(escaped, "g"), "***REDACTED***");
}

async function run(): Promise<void> {
  const startedAt = Date.now();
  const input = workerData as WorkerInput;

  if (!parentPort) {
    throw new Error("ts_exec_worker: must be spawned as a worker thread");
  }
  if (!input || typeof input.code !== "string") {
    parentPort.postMessage({
      ok: false,
      stdout: "",
      stderr: "",
      error: "ts_exec_worker: missing workerData.code",
      durationMs: 0,
    } satisfies WorkerResult);
    return;
  }

  // Apply env BEFORE the network guard is imported — the guard reads
  // TS_SANDBOX_ALLOWLIST_HOSTS at module-init time.
  Object.assign(process.env, input.env ?? {});

  const stdoutChunks: string[] = [];
  const stderrChunks: string[] = [];
  const originalLog = console.log;
  const originalError = console.error;
  const originalWarn = console.warn;
  const originalInfo = console.info;
  console.log = (...args) => {
    stdoutChunks.push(args.map(formatValue).join(" "));
  };
  console.info = (...args) => {
    stdoutChunks.push(args.map(formatValue).join(" "));
  };
  console.error = (...args) => {
    stderrChunks.push(args.map(formatValue).join(" "));
  };
  console.warn = (...args) => {
    stderrChunks.push(args.map(formatValue).join(" "));
  };

  const guardUrl = pathToFileURL(path.resolve(WORKER_DIR, "network_guard.ts")).href;
  // ESM imports of .ts work under tsx; if the worker is running compiled JS,
  // network_guard.js is right next to ts_exec_worker.js so the same .ts URL
  // gets remapped by tsx OR we fall through to .js — try both.
  const guardJsUrl = pathToFileURL(path.resolve(WORKER_DIR, "network_guard.js")).href;
  const preludeUrl = (await fileExists(path.resolve(WORKER_DIR, "network_guard.ts"))) ? guardUrl : guardJsUrl;

  const tempFile = path.join(
    CODE_API_DIR,
    `__user_${process.pid}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}.ts`,
  );
  const prelude = `import "${preludeUrl}";\n`;
  const finalSource = `${prelude}\n${input.code}\n`;

  let result: WorkerResult;
  const writtenAt = await safeWrite(tempFile, finalSource);
  try {
    if (!writtenAt) {
      throw new Error(`ts_exec_worker: could not write temp file at ${tempFile}`);
    }
    const tempUrl = pathToFileURL(tempFile).href;
    await import(tempUrl);
    result = {
      ok: true,
      stdout: stdoutChunks.join("\n"),
      stderr: stderrChunks.join("\n"),
      durationMs: Date.now() - startedAt,
    };
  } catch (error) {
    const err = error instanceof Error ? error : new Error(String(error));
    result = {
      ok: false,
      stdout: stdoutChunks.join("\n"),
      stderr: stderrChunks.join("\n"),
      error: err.message,
      errorName: err.name,
      stack: err.stack,
      durationMs: Date.now() - startedAt,
    };
  } finally {
    console.log = originalLog;
    console.error = originalError;
    console.warn = originalWarn;
    console.info = originalInfo;
    await fs.unlink(tempFile).catch(() => undefined);
  }

  // Scrub the token from anything we're about to send back.
  const token = input.env?.CANVAS_API_TOKEN ?? process.env.CANVAS_API_TOKEN;
  if (token) {
    result.stdout = scrubToken(result.stdout, token);
    result.stderr = scrubToken(result.stderr, token);
    if (result.error) result.error = scrubToken(result.error, token);
    if (result.stack) result.stack = scrubToken(result.stack, token);
  }

  parentPort.postMessage(result);
}

async function fileExists(target: string): Promise<boolean> {
  try {
    await fs.access(target);
    return true;
  } catch {
    return false;
  }
}

async function safeWrite(target: string, contents: string): Promise<boolean> {
  try {
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, contents, "utf8");
    return true;
  } catch {
    return false;
  }
}

run().catch((error) => {
  const message = error instanceof Error ? error.stack ?? error.message : String(error);
  parentPort?.postMessage({
    ok: false,
    stdout: "",
    stderr: "",
    error: `ts_exec_worker fatal: ${message}`,
    durationMs: 0,
  } satisfies WorkerResult);
});
