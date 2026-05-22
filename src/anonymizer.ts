import { promises as fs } from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import type { AnonMapEntry, AnonMapFile, CanvasUserLite } from "./types.js";

export interface AnonymizerOptions {
  /** Defaults to $ANON_MAP_DIR or ~/.canvas-mcp/anon-maps/. */
  rootDir?: string;
}

/** Sentinel for "treat unknown role as": student → safe-anonymize, teacher → preserve attribution. */
export type UnknownRolePolicy = "student" | "teacher";

const DEFAULT_DIR_MODE = 0o700;
const DEFAULT_FILE_MODE = 0o600;
const CURRENT_VERSION = 1;

/** Canvas enrollment roles that should NOT be anonymized (teacher attribution preserved). */
const STAFF_ROLES = new Set([
  "teacher",
  "ta",
  "admin",
  "designer",
  "teacherenrollment",
  "taenrollment",
  "adminenrollment",
  "designerenrollment",
]);

const STUDENT_ROLES = new Set(["student", "studentenrollment", "studentviewenrollment"]);

/**
 * Best-effort role classifier. Checks user.role and user.enrollments[].type/role.
 * Returns:
 *   "student" — known student
 *   "staff"   — known teacher/admin/ta/designer
 *   "unknown" — caller decides via UnknownRolePolicy
 */
export function classifyRole(user: CanvasUserLite | null | undefined): "student" | "staff" | "unknown" {
  if (!user) return "unknown";
  const candidates: string[] = [];
  if (typeof user.role === "string") candidates.push(user.role);
  const enrollments = user.enrollments;
  if (Array.isArray(enrollments)) {
    for (const enrollment of enrollments) {
      if (enrollment && typeof enrollment === "object") {
        const type = (enrollment as { type?: unknown }).type;
        const role = (enrollment as { role?: unknown }).role;
        if (typeof type === "string") candidates.push(type);
        if (typeof role === "string") candidates.push(role);
      }
    }
  }
  for (const candidate of candidates) {
    const normalized = candidate.toLowerCase();
    if (STAFF_ROLES.has(normalized)) return "staff";
    if (STUDENT_ROLES.has(normalized)) return "student";
  }
  return "unknown";
}

export function defaultAnonMapDir(): string {
  const fromEnv = process.env.ANON_MAP_DIR?.trim();
  if (fromEnv) return path.resolve(fromEnv);
  return path.join(os.homedir(), ".canvas-mcp", "anon-maps");
}

interface InMemoryMap {
  courseId: number;
  generatedAt: string;
  students: Map<string, AnonMapEntry>;
  /** Counter for next "Student N" allocation; never decreases (no reuse). */
  highestAllocated: number;
}

export class Anonymizer {
  readonly rootDir: string;
  private readonly memo = new Map<number, InMemoryMap>();
  /** Per-course async lock so concurrent allocations can't double-assign a pseudonym. */
  private readonly locks = new Map<number, Promise<unknown>>();
  private initPromise: Promise<void> | null = null;

  constructor(options: AnonymizerOptions = {}) {
    this.rootDir = options.rootDir ?? defaultAnonMapDir();
  }

  /** Idempotent — caller may invoke multiple times; only runs mkdir once. */
  async init(): Promise<void> {
    if (this.initPromise) return this.initPromise;
    this.initPromise = (async () => {
      await fs.mkdir(this.rootDir, { recursive: true, mode: DEFAULT_DIR_MODE });
      // Best-effort tighten in case the directory pre-existed with looser permissions.
      await fs.chmod(this.rootDir, DEFAULT_DIR_MODE).catch(() => undefined);
    })();
    return this.initPromise;
  }

  private filePath(courseId: number): string {
    return path.join(this.rootDir, `${courseId}.json`);
  }

  /** Read a course map from disk; returns null if the file does not yet exist. */
  async loadMap(courseId: number): Promise<AnonMapFile | null> {
    await this.init();
    const filePath = this.filePath(courseId);
    let raw: string;
    try {
      raw = await fs.readFile(filePath, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
    const parsed = JSON.parse(raw) as AnonMapFile;
    if (parsed.version !== CURRENT_VERSION) {
      throw new Error(
        `Anonymizer: unsupported map version ${parsed.version} in ${filePath}; expected ${CURRENT_VERSION}`,
      );
    }
    return parsed;
  }

  /** List every course id that has a JSON file on disk, with each entry's stats. */
  async listMaps(): Promise<Array<{ courseId: number; entries: number; generatedAt: string; filePath: string }>> {
    await this.init();
    let entries: string[];
    try {
      entries = await fs.readdir(this.rootDir);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
    const result: Array<{ courseId: number; entries: number; generatedAt: string; filePath: string }> = [];
    for (const entry of entries) {
      const match = entry.match(/^(\d+)\.json$/);
      if (!match) continue;
      const courseId = Number(match[1]);
      try {
        const map = await this.loadMap(courseId);
        if (!map) continue;
        result.push({
          courseId,
          entries: Object.keys(map.students).length,
          generatedAt: map.generatedAt,
          filePath: this.filePath(courseId),
        });
      } catch {
        // skip unreadable/corrupt files
      }
    }
    result.sort((a, b) => a.courseId - b.courseId);
    return result;
  }

  /**
   * Look up or allocate a pseudonym for `user` under `courseId`.
   * Serialized per-course so concurrent allocations don't collide.
   * Persists to disk on first allocation before resolving.
   */
  async getOrAllocate(
    courseId: number,
    user: CanvasUserLite,
  ): Promise<{ pseudonym: string; anonymizedEmail: string }> {
    if (user.id === undefined || user.id === null) {
      throw new Error("Anonymizer.getOrAllocate: user.id is required");
    }
    const userId = String(user.id);

    return this.withLock(courseId, async () => {
      const inMemory = await this.loadIntoMemo(courseId);
      const existing = inMemory.students.get(userId);
      if (existing) {
        return { pseudonym: existing.pseudonym, anonymizedEmail: existing.anonymizedEmail };
      }
      const allocated = this.allocate(inMemory, userId);
      await this.persist(courseId);
      return { pseudonym: allocated.pseudonym, anonymizedEmail: allocated.anonymizedEmail };
    });
  }

  /**
   * Anonymize a single user. Returns a shallow clone with `name`, `short_name`,
   * `sortable_name`, `email`, `login_id` replaced when the user looks like a student
   * (per UnknownRolePolicy). Teachers/admins/TAs are always returned verbatim.
   *
   * Default policy: unknown → student (safe-anonymize). Override for contexts where
   * preserving attribution matters more than worst-case FERPA conservatism.
   */
  async anonymizeUser(
    courseId: number,
    user: CanvasUserLite,
    options: { unknownRolePolicy?: UnknownRolePolicy } = {},
  ): Promise<CanvasUserLite> {
    const policy = options.unknownRolePolicy ?? "student";
    const role = classifyRole(user);
    const treatAsStudent = role === "student" || (role === "unknown" && policy === "student");
    if (!treatAsStudent) return user;

    const { pseudonym, anonymizedEmail } = await this.getOrAllocate(courseId, user);
    return {
      ...user,
      name: pseudonym,
      short_name: pseudonym,
      sortable_name: pseudonym,
      email: anonymizedEmail,
      login_id: anonymizedEmail,
    };
  }

  /**
   * Anonymize a submission object. The submitter (`submission.user`) is always treated
   * as a student (default-anonymize). Comment authors are preserved by default — only
   * comments whose author is explicitly tagged as a student get anonymized. This keeps
   * teacher attribution in pedagogical artifacts.
   */
  async anonymizeSubmission(
    courseId: number,
    submission: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const clone: Record<string, unknown> = { ...submission };

    const submitter = submission.user as CanvasUserLite | undefined;
    if (submitter) {
      clone.user = await this.anonymizeUser(courseId, submitter, { unknownRolePolicy: "student" });
    }

    const comments = submission.submission_comments;
    if (Array.isArray(comments)) {
      const anonymized = await Promise.all(
        comments.map(async (rawComment) => {
          if (!rawComment || typeof rawComment !== "object") return rawComment;
          const comment = rawComment as Record<string, unknown>;
          const author = comment.author as CanvasUserLite | undefined;
          if (!author) return comment;
          // Comment authors: preserve unless KNOWN student (teacher attribution defaults to preserved).
          const transformedAuthor = await this.anonymizeUser(courseId, author, {
            unknownRolePolicy: "teacher",
          });
          if (transformedAuthor === author) return comment;
          return {
            ...comment,
            author: transformedAuthor,
            author_id: transformedAuthor.id,
            author_name: transformedAuthor.name,
          };
        }),
      );
      clone.submission_comments = anonymized;
    }

    return clone;
  }

  /**
   * Bulk-load a roster snapshot. Allocates pseudonyms for any new userIds (in their
   * original order), and marks any prior-active entries not in `students` as historical.
   * Never renumbers or reuses pseudonyms; idempotent under repeated identical calls.
   */
  async mergeIntoMap(
    courseId: number,
    students: CanvasUserLite[],
  ): Promise<{ newlyAllocated: number; totalActive: number; totalHistorical: number; map: AnonMapFile }> {
    return this.withLock(courseId, async () => {
      const inMemory = await this.loadIntoMemo(courseId);
      const newRosterIds = new Set<string>();
      let newlyAllocated = 0;

      for (const student of students) {
        if (student.id === undefined || student.id === null) continue;
        const userId = String(student.id);
        newRosterIds.add(userId);
        const existing = inMemory.students.get(userId);
        if (existing) {
          if (existing.status !== "active") existing.status = "active";
          // Refresh anonymized email if it was empty (legacy entries)
          if (!existing.anonymizedEmail) {
            existing.anonymizedEmail = this.makeAnonEmail(existing.pseudonym);
          }
        } else {
          this.allocate(inMemory, userId);
          newlyAllocated += 1;
        }
      }

      // Mark prior actives not in the new roster as historical.
      let totalHistorical = 0;
      let totalActive = 0;
      for (const [, entry] of inMemory.students) {
        if (!newRosterIds.has(this.findUserIdForEntry(inMemory, entry))) {
          if (entry.status === "active") entry.status = "historical";
        }
        if (entry.status === "active") totalActive += 1;
        else totalHistorical += 1;
      }

      await this.persist(courseId);
      const map = await this.loadMap(courseId);
      return {
        newlyAllocated,
        totalActive,
        totalHistorical,
        map: map ?? this.snapshotToFile(courseId, inMemory),
      };
    });
  }

  /** Reset in-memory cache (testing aid). */
  resetMemo(): void {
    this.memo.clear();
  }

  // -------- internal helpers --------

  private async withLock<T>(courseId: number, fn: () => Promise<T>): Promise<T> {
    const previous = this.locks.get(courseId) ?? Promise.resolve();
    const result = previous.then(fn);
    // Replace with a tolerant chain so the next waiter isn't poisoned by failures.
    this.locks.set(
      courseId,
      result.catch(() => undefined),
    );
    return result;
  }

  /** Load a course's map into the memo cache (or create an empty one). */
  private async loadIntoMemo(courseId: number): Promise<InMemoryMap> {
    let entry = this.memo.get(courseId);
    if (entry) return entry;

    const file = await this.loadMap(courseId);
    if (file) {
      const students = new Map<string, AnonMapEntry>();
      let highest = 0;
      for (const [userId, mapEntry] of Object.entries(file.students)) {
        students.set(userId, { ...mapEntry });
        const number = pseudonymNumber(mapEntry.pseudonym);
        if (number !== null && number > highest) highest = number;
      }
      entry = {
        courseId,
        generatedAt: file.generatedAt,
        students,
        highestAllocated: highest,
      };
    } else {
      entry = {
        courseId,
        generatedAt: new Date().toISOString(),
        students: new Map(),
        highestAllocated: 0,
      };
    }
    this.memo.set(courseId, entry);
    return entry;
  }

  private allocate(inMemory: InMemoryMap, userId: string): AnonMapEntry {
    const number = inMemory.highestAllocated + 1;
    const pseudonym = `Student ${number}`;
    const entry: AnonMapEntry = {
      pseudonym,
      anonymizedEmail: this.makeAnonEmail(pseudonym),
      status: "active",
    };
    inMemory.students.set(userId, entry);
    inMemory.highestAllocated = number;
    return entry;
  }

  private makeAnonEmail(pseudonym: string): string {
    return `${pseudonym.toLowerCase().replace(/\s+/g, "")}@anonymized.local`;
  }

  /** Serialize the in-memory map to disk via tmp+rename atomic write. */
  private async persist(courseId: number): Promise<void> {
    const inMemory = this.memo.get(courseId);
    if (!inMemory) return;

    const file = this.snapshotToFile(courseId, inMemory);
    const finalPath = this.filePath(courseId);
    const tmpPath = path.join(
      path.dirname(finalPath),
      `.${path.basename(finalPath)}.${process.pid}.${Date.now()}.tmp`,
    );

    const payload = JSON.stringify(file, null, 2);
    await fs.writeFile(tmpPath, payload, { mode: DEFAULT_FILE_MODE });
    try {
      await fs.rename(tmpPath, finalPath);
    } catch (error) {
      // Best-effort cleanup; rethrow original.
      await fs.unlink(tmpPath).catch(() => undefined);
      throw error;
    }
    // Some umasks neuter the writeFile mode; enforce here.
    await fs.chmod(finalPath, DEFAULT_FILE_MODE).catch(() => undefined);
  }

  private snapshotToFile(courseId: number, inMemory: InMemoryMap): AnonMapFile {
    const students: Record<string, AnonMapEntry> = {};
    for (const [userId, entry] of inMemory.students) {
      students[userId] = { ...entry };
    }
    return {
      version: CURRENT_VERSION,
      courseId,
      generatedAt: inMemory.generatedAt,
      students,
    };
  }

  /** Reverse-lookup userId for an entry inside an in-memory map. */
  private findUserIdForEntry(inMemory: InMemoryMap, target: AnonMapEntry): string {
    for (const [userId, candidate] of inMemory.students) {
      if (candidate === target) return userId;
    }
    return "";
  }
}

function pseudonymNumber(pseudonym: string): number | null {
  const match = pseudonym.match(/^Student\s+(\d+)$/);
  if (!match) return null;
  const number = Number(match[1]);
  return Number.isFinite(number) ? number : null;
}
