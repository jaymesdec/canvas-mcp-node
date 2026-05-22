import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { Anonymizer, classifyRole, defaultAnonMapDir } from "../src/anonymizer.js";
import type { AnonMapFile, CanvasUserLite } from "../src/types.js";

const isPosix = process.platform !== "win32";

async function makeTempRoot(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), "canvas-anon-test-"));
}

async function rmRoot(root: string): Promise<void> {
  await fs.rm(root, { recursive: true, force: true });
}

describe("classifyRole", () => {
  it("returns 'staff' for known teacher/admin/ta enrollments", () => {
    expect(classifyRole({ id: 1, role: "teacher" })).toBe("staff");
    expect(classifyRole({ id: 1, role: "Admin" })).toBe("staff");
    expect(
      classifyRole({ id: 1, enrollments: [{ type: "TaEnrollment" }] }),
    ).toBe("staff");
  });

  it("returns 'student' for explicit student tags", () => {
    expect(classifyRole({ id: 1, role: "student" })).toBe("student");
    expect(
      classifyRole({ id: 1, enrollments: [{ type: "StudentEnrollment" }] }),
    ).toBe("student");
  });

  it("returns 'unknown' for null/undefined/empty role", () => {
    expect(classifyRole({ id: 1 })).toBe("unknown");
    expect(classifyRole(null)).toBe("unknown");
    expect(classifyRole(undefined)).toBe("unknown");
    expect(classifyRole({ id: 1, role: undefined })).toBe("unknown");
  });
});

describe("defaultAnonMapDir", () => {
  it("respects $ANON_MAP_DIR when set", () => {
    const previous = process.env.ANON_MAP_DIR;
    process.env.ANON_MAP_DIR = "/tmp/custom/anon";
    try {
      expect(defaultAnonMapDir()).toBe(path.resolve("/tmp/custom/anon"));
    } finally {
      if (previous === undefined) delete process.env.ANON_MAP_DIR;
      else process.env.ANON_MAP_DIR = previous;
    }
  });
});

describe("Anonymizer.init", () => {
  let root: string;
  beforeEach(async () => {
    root = await makeTempRoot();
    // Use a non-existent subdir so we can verify fresh-install path
    root = path.join(root, "nested", "subdir");
  });
  afterEach(async () => {
    const parent = path.dirname(path.dirname(root));
    if (parent.includes("canvas-anon-test-")) await rmRoot(parent);
  });

  it("creates the root directory on first call (fresh install) with 0o700 mode", async () => {
    const anonymizer = new Anonymizer({ rootDir: root });
    await anonymizer.init();
    const stat = await fs.stat(root);
    expect(stat.isDirectory()).toBe(true);
    if (isPosix) {
      expect(stat.mode & 0o777).toBe(0o700);
    }
  });

  it("is idempotent across multiple calls", async () => {
    const anonymizer = new Anonymizer({ rootDir: root });
    await anonymizer.init();
    await anonymizer.init();
    await expect(fs.stat(root)).resolves.toBeDefined();
  });
});

describe("Anonymizer.getOrAllocate", () => {
  let root: string;
  beforeEach(async () => {
    root = await makeTempRoot();
  });
  afterEach(async () => {
    await rmRoot(root);
  });

  const student = (id: number): CanvasUserLite => ({
    id,
    name: `Real Person ${id}`,
    email: `real${id}@school.edu`,
    role: "student",
  });

  it("allocates Student 1 on first call and persists the file with mode 0o600", async () => {
    const anonymizer = new Anonymizer({ rootDir: root });
    const result = await anonymizer.getOrAllocate(60366, student(1001));
    expect(result.pseudonym).toBe("Student 1");
    expect(result.anonymizedEmail).toBe("student1@anonymized.local");

    const filePath = path.join(root, "60366.json");
    const fileStat = await fs.stat(filePath);
    expect(fileStat.isFile()).toBe(true);
    if (isPosix) {
      expect(fileStat.mode & 0o777).toBe(0o600);
    }
    const raw = await fs.readFile(filePath, "utf8");
    const parsed = JSON.parse(raw) as AnonMapFile;
    expect(parsed.version).toBe(1);
    expect(parsed.courseId).toBe(60366);
    expect(parsed.students["1001"]).toMatchObject({
      pseudonym: "Student 1",
      anonymizedEmail: "student1@anonymized.local",
      status: "active",
    });
  });

  it("returns the same pseudonym for the same user in the same process", async () => {
    const anonymizer = new Anonymizer({ rootDir: root });
    const first = await anonymizer.getOrAllocate(60366, student(1001));
    const second = await anonymizer.getOrAllocate(60366, student(1001));
    expect(second).toEqual(first);
  });

  it("survives a process restart — fresh Anonymizer reads the same pseudonym from disk", async () => {
    const writer = new Anonymizer({ rootDir: root });
    const allocated = await writer.getOrAllocate(60366, student(1001));

    const reader = new Anonymizer({ rootDir: root });
    const fromDisk = await reader.getOrAllocate(60366, student(1001));
    expect(fromDisk).toEqual(allocated);
  });

  it("keeps per-course separation: Student 1 in course A != Student 1 in course B for same userId", async () => {
    const anonymizer = new Anonymizer({ rootDir: root });
    const aliceInA = await anonymizer.getOrAllocate(100, student(7));
    const aliceInB = await anonymizer.getOrAllocate(200, student(7));
    // Same pseudonym text "Student 1" but allocated independently per course.
    expect(aliceInA.pseudonym).toBe("Student 1");
    expect(aliceInB.pseudonym).toBe("Student 1");
    // Verify they came from independent files
    expect(await fs.stat(path.join(root, "100.json"))).toBeDefined();
    expect(await fs.stat(path.join(root, "200.json"))).toBeDefined();
  });

  it("allocates 50 distinct pseudonyms under concurrent calls for the same course", async () => {
    const anonymizer = new Anonymizer({ rootDir: root });
    const userIds = Array.from({ length: 50 }, (_, index) => 2000 + index);
    const results = await Promise.all(
      userIds.map((id) => anonymizer.getOrAllocate(60366, student(id))),
    );
    const pseudonyms = new Set(results.map((entry) => entry.pseudonym));
    expect(pseudonyms.size).toBe(50);
    // Pseudonyms should be exactly Student 1..Student 50
    for (let count = 1; count <= 50; count += 1) {
      expect(pseudonyms.has(`Student ${count}`)).toBe(true);
    }
  });

  it("never silently de-anonymizes on write failure", async () => {
    const readonlyRoot = path.join(root, "readonly");
    await fs.mkdir(readonlyRoot, { recursive: true });
    const anonymizer = new Anonymizer({ rootDir: readonlyRoot });
    await anonymizer.init();
    // Drop write permission on the directory after init (so mkdir succeeds but writeFile fails).
    if (isPosix) {
      await fs.chmod(readonlyRoot, 0o500);
      try {
        await expect(anonymizer.getOrAllocate(60366, student(1001))).rejects.toBeInstanceOf(Error);
      } finally {
        await fs.chmod(readonlyRoot, 0o700);
      }
    }
  });
});

describe("Anonymizer.anonymizeUser", () => {
  let root: string;
  beforeEach(async () => {
    root = await makeTempRoot();
  });
  afterEach(async () => {
    await rmRoot(root);
  });

  it("replaces name/email for explicit student", async () => {
    const anonymizer = new Anonymizer({ rootDir: root });
    const result = await anonymizer.anonymizeUser(60366, {
      id: 1001,
      name: "Alice Real",
      email: "alice@school.edu",
      role: "student",
    });
    expect(result.name).toBe("Student 1");
    expect(result.email).toBe("student1@anonymized.local");
  });

  it("preserves teacher identity verbatim", async () => {
    const anonymizer = new Anonymizer({ rootDir: root });
    const teacher = {
      id: 5000,
      name: "Mr. Smith",
      email: "smith@school.edu",
      role: "teacher",
    } satisfies CanvasUserLite;
    const result = await anonymizer.anonymizeUser(60366, teacher);
    expect(result).toEqual(teacher);
    // No file written for a teacher-only call.
    await expect(fs.stat(path.join(root, "60366.json"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("treats unknown role as student by default (FERPA-safe)", async () => {
    const anonymizer = new Anonymizer({ rootDir: root });
    const result = await anonymizer.anonymizeUser(60366, {
      id: 1001,
      name: "Unknown Person",
      email: "unknown@school.edu",
      // no role field
    });
    expect(result.name).toBe("Student 1");
  });
});

describe("Anonymizer.anonymizeSubmission", () => {
  let root: string;
  beforeEach(async () => {
    root = await makeTempRoot();
  });
  afterEach(async () => {
    await rmRoot(root);
  });

  it("anonymizes the submitter but preserves teacher comment authors verbatim", async () => {
    const anonymizer = new Anonymizer({ rootDir: root });
    const submission = {
      id: 9999,
      user_id: 1001,
      user: { id: 1001, name: "Alice Real", role: "student" },
      submission_comments: [
        {
          id: 1,
          author_id: 5000,
          author_name: "Mr. Smith",
          author: { id: 5000, name: "Mr. Smith", role: "teacher" },
          comment: "Nice work",
        },
        {
          id: 2,
          author_id: 1001,
          author_name: "Alice Real",
          author: { id: 1001, name: "Alice Real", role: "student" },
          comment: "Thanks!",
        },
      ],
    };

    const result = await anonymizer.anonymizeSubmission(60366, submission);
    expect((result.user as { name?: string }).name).toBe("Student 1");

    const comments = result.submission_comments as Array<Record<string, unknown>>;
    // Teacher comment: untouched
    expect(comments[0]).toMatchObject({
      author_id: 5000,
      author_name: "Mr. Smith",
      comment: "Nice work",
    });
    expect((comments[0]?.author as { name?: string }).name).toBe("Mr. Smith");

    // Student self-comment: anonymized to Student 1 (same as the submitter)
    expect(comments[1]?.author_id).toBe(1001);
    expect((comments[1]?.author as { name?: string }).name).toBe("Student 1");
    expect(comments[1]?.author_name).toBe("Student 1");
  });

  it("preserves unknown-role comment authors (default teacher-policy for comments)", async () => {
    const anonymizer = new Anonymizer({ rootDir: root });
    const submission = {
      user: { id: 1001, role: "student", name: "Alice" },
      submission_comments: [
        {
          author: { id: 7777, name: "Visiting Guest" }, // no role field
          comment: "Hello",
        },
      ],
    };
    const result = await anonymizer.anonymizeSubmission(60366, submission);
    const comments = result.submission_comments as Array<Record<string, unknown>>;
    // Unknown-role comment author defaults to preserved (teacher attribution path).
    expect((comments[0]?.author as { name?: string }).name).toBe("Visiting Guest");
  });
});

describe("Anonymizer.mergeIntoMap", () => {
  let root: string;
  beforeEach(async () => {
    root = await makeTempRoot();
  });
  afterEach(async () => {
    await rmRoot(root);
  });

  it("allocates only newly-added students on second invocation (idempotent)", async () => {
    const anonymizer = new Anonymizer({ rootDir: root });
    const initialRoster: CanvasUserLite[] = [
      { id: 1, role: "student" },
      { id: 2, role: "student" },
      { id: 3, role: "student" },
    ];
    const first = await anonymizer.mergeIntoMap(60366, initialRoster);
    expect(first.newlyAllocated).toBe(3);
    expect(first.totalActive).toBe(3);

    const second = await anonymizer.mergeIntoMap(60366, initialRoster);
    expect(second.newlyAllocated).toBe(0);
    expect(second.totalActive).toBe(3);

    const expanded = [...initialRoster, { id: 4, role: "student" }];
    const third = await anonymizer.mergeIntoMap(60366, expanded);
    expect(third.newlyAllocated).toBe(1);
    expect(third.totalActive).toBe(4);
    // The new student gets Student 4 — no renumbering of prior assignments.
    const file = await anonymizer.loadMap(60366);
    expect(file?.students["4"]?.pseudonym).toBe("Student 4");
  });

  it("marks a removed student as historical without renumbering or reusing the pseudonym", async () => {
    const anonymizer = new Anonymizer({ rootDir: root });
    const fullRoster: CanvasUserLite[] = [
      { id: 1, role: "student" },
      { id: 2, role: "student" },
      { id: 3, role: "student" },
    ];
    await anonymizer.mergeIntoMap(60366, fullRoster);
    const shrunk = [
      { id: 1, role: "student" },
      { id: 3, role: "student" }, // id 2 removed
    ];
    const result = await anonymizer.mergeIntoMap(60366, shrunk);
    expect(result.totalActive).toBe(2);
    expect(result.totalHistorical).toBe(1);

    const file = await anonymizer.loadMap(60366);
    expect(file?.students["2"]?.status).toBe("historical");
    expect(file?.students["2"]?.pseudonym).toBe("Student 2");
    // Student 3 keeps its original number; not renumbered.
    expect(file?.students["3"]?.pseudonym).toBe("Student 3");
  });
});

describe("Anonymizer.listMaps", () => {
  let root: string;
  beforeEach(async () => {
    root = await makeTempRoot();
  });
  afterEach(async () => {
    await rmRoot(root);
  });

  it("returns an empty list when no maps exist", async () => {
    const anonymizer = new Anonymizer({ rootDir: root });
    await expect(anonymizer.listMaps()).resolves.toEqual([]);
  });

  it("lists each course map with its entry count", async () => {
    const anonymizer = new Anonymizer({ rootDir: root });
    await anonymizer.mergeIntoMap(100, [{ id: 1, role: "student" }]);
    await anonymizer.mergeIntoMap(200, [
      { id: 1, role: "student" },
      { id: 2, role: "student" },
    ]);
    const maps = await anonymizer.listMaps();
    expect(maps).toEqual([
      expect.objectContaining({ courseId: 100, entries: 1 }),
      expect.objectContaining({ courseId: 200, entries: 2 }),
    ]);
  });
});
