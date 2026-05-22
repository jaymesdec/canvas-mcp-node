/**
 * FERPA-safe Anonymizer adapter for execute_typescript user code.
 *
 * User code in execute_typescript imports this module instead of bypassing
 * anonymization. The adapter binds to an Anonymizer instance that reads/writes
 * the SAME on-disk pseudonym map files as the main thread's Anonymizer, so a
 * given student receives the same Student N pseudonym whether you reach them
 * through the typed list_users tool or through a custom execute_typescript
 * snippet.
 *
 * Singleton pattern: workerData passes the anonymizer rootDir at worker spawn;
 * we lazily construct a worker-local Anonymizer on first use. When imported
 * outside a worker (e.g., from tests or main-thread code), we fall back to the
 * env-default rootDir.
 */
import { workerData } from "node:worker_threads";

import {
  Anonymizer as AnonymizerCore,
  classifyRole as classifyRoleCore,
  defaultAnonMapDir,
} from "../anonymizer.js";
import type { CanvasUserLite } from "../types.js";

let instance: AnonymizerCore | null = null;
let initPromise: Promise<void> | null = null;
let initializedFor: string | null = null;

function resolveRootDir(): string {
  const fromWorker = (workerData as { anonRootDir?: string } | undefined)?.anonRootDir;
  if (fromWorker && fromWorker.length > 0) return fromWorker;
  return defaultAnonMapDir();
}

function getInstance(): AnonymizerCore {
  const wanted = resolveRootDir();
  // Recreate when the rootDir changes (matters in tests that swap ANON_MAP_DIR
  // between cases; in normal MCP runtime the dir is set once and never changes).
  if (!instance || instance.rootDir !== wanted) {
    instance = new AnonymizerCore({ rootDir: wanted });
    initPromise = null;
    initializedFor = null;
  }
  return instance;
}

async function ensureInit(): Promise<void> {
  const anonymizer = getInstance();
  if (initializedFor === anonymizer.rootDir && initPromise) return initPromise;
  initPromise = anonymizer.init();
  initializedFor = anonymizer.rootDir;
  return initPromise;
}

export type { CanvasUserLite } from "../types.js";

/** Anonymize a single user with the same policy the typed list_users tool uses. */
export async function anonymizeUser(
  courseId: number,
  user: CanvasUserLite,
): Promise<CanvasUserLite> {
  await ensureInit();
  return getInstance().anonymizeUser(courseId, user);
}

/** Anonymize many users — same pseudonyms list_users would produce. */
export async function anonymizeUsers(
  courseId: number,
  users: CanvasUserLite[],
): Promise<CanvasUserLite[]> {
  await ensureInit();
  const anonymizer = getInstance();
  return Promise.all(users.map((user) => anonymizer.anonymizeUser(courseId, user)));
}

/** Anonymize a single submission (submitter + student comment authors). */
export async function anonymizeSubmission(
  courseId: number,
  submission: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  await ensureInit();
  return getInstance().anonymizeSubmission(courseId, submission);
}

/** Anonymize many submissions — matches list_submissions default behavior. */
export async function anonymizeSubmissions(
  courseId: number,
  submissions: Record<string, unknown>[],
): Promise<Record<string, unknown>[]> {
  await ensureInit();
  const anonymizer = getInstance();
  return Promise.all(
    submissions.map((submission) => anonymizer.anonymizeSubmission(courseId, submission)),
  );
}

/** Re-export role classifier so user code can inspect roles without copy-pasting the rules. */
export const classifyRole = classifyRoleCore;
