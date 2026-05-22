import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { Anonymizer } from "../../src/anonymizer.js";
import * as adapter from "../../src/code_api/anonymizer.js";

let anonRoot: string;
beforeEach(async () => {
  anonRoot = await fs.mkdtemp(path.join(os.tmpdir(), "canvas-anon-adapter-"));
  process.env.ANON_MAP_DIR = anonRoot;
});
afterEach(async () => {
  delete process.env.ANON_MAP_DIR;
  await fs.rm(anonRoot, { recursive: true, force: true });
});

describe("code_api/anonymizer adapter", () => {
  it("exposes the four anonymize functions and classifyRole", () => {
    expect(typeof adapter.anonymizeUser).toBe("function");
    expect(typeof adapter.anonymizeUsers).toBe("function");
    expect(typeof adapter.anonymizeSubmission).toBe("function");
    expect(typeof adapter.anonymizeSubmissions).toBe("function");
    expect(typeof adapter.classifyRole).toBe("function");
  });

  it("falls back to ANON_MAP_DIR env when no workerData is provided (main-thread import)", async () => {
    // Seed via the main Anonymizer
    const main = new Anonymizer({ rootDir: anonRoot });
    await main.mergeIntoMap(60366, [{ id: 1001, name: "Alice", role: "student" }]);

    // Now call through the adapter — it should see the same on-disk state
    // because both instances point at the same rootDir.
    const result = await adapter.anonymizeUser(60366, {
      id: 1001,
      name: "Alice",
      role: "student",
    });
    expect(result.name).toBe("Student 1");
  });

  it("preserves teachers verbatim through the adapter", async () => {
    const result = await adapter.anonymizeUser(60366, {
      id: 5000,
      name: "Mr. Smith",
      role: "teacher",
    });
    expect(result.name).toBe("Mr. Smith");
  });

  it("anonymizes batches consistently with the main thread's allocations", async () => {
    const main = new Anonymizer({ rootDir: anonRoot });
    const seed = [
      { id: 1001, name: "Alice", role: "student" as const },
      { id: 1002, name: "Bob", role: "student" as const },
    ];
    await main.mergeIntoMap(60366, seed);
    const fromAdapter = await adapter.anonymizeUsers(60366, seed);
    expect(fromAdapter.map((user) => user.name)).toEqual(["Student 1", "Student 2"]);
  });
});
