import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { buildMockCanvas, buildToolHarness, parseJsonResult, type ToolResponse } from "../_helpers/mockCanvas.js";
import { Anonymizer } from "../../src/anonymizer.js";
import { registerUserTools } from "../../src/tools/users.js";
import { registerAssignmentTools } from "../../src/tools/assignments.js";

/**
 * Cross-tool integration: confirm that a given student receives the SAME pseudonym
 * whether they show up in list_users or as the submitter on list_assignments(include=submission).
 * This is the contract Unit 4.2 underwrites for Phase 3 to inherit (list_submissions, grading)
 * without re-implementing the policy.
 */
describe("anonymization wiring across tools (Unit 4.2)", () => {
  let anonRoot: string;
  let anonymizer: Anonymizer;

  beforeEach(async () => {
    anonRoot = await fs.mkdtemp(path.join(os.tmpdir(), "canvas-anon-wiring-"));
    anonymizer = new Anonymizer({ rootDir: anonRoot });
    await anonymizer.init();
  });
  afterEach(async () => {
    await fs.rm(anonRoot, { recursive: true, force: true });
  });

  it("same student gets identical pseudonym across list_users and list_assignments(submission)", async () => {
    const { client } = buildMockCanvas([
      // list_users response
      {
        status: 200,
        data: [
          {
            id: 1001,
            name: "Alice Real",
            email: "alice@school.edu",
            enrollments: [{ type: "StudentEnrollment" }],
          },
          {
            id: 1002,
            name: "Bob Real",
            email: "bob@school.edu",
            enrollments: [{ type: "StudentEnrollment" }],
          },
        ],
      },
      // list_assignments response
      {
        status: 200,
        data: [
          {
            id: 1,
            name: "HW1",
            submission: {
              id: 99,
              user_id: 1002,
              user: { id: 1002, name: "Bob Real", role: "student" },
            },
          },
        ],
      },
    ]);
    const harness = buildToolHarness();
    registerUserTools(harness.server as never, client, anonymizer);
    registerAssignmentTools(harness.server as never, client, anonymizer);

    const usersResult = (await harness.call("list_users", {
      course_identifier: 60366,
    })) as ToolResponse;
    const users = parseJsonResult(usersResult).users as Array<{ id: number; name: string }>;
    const bobPseudonym = users.find((user) => user.id === 1002)?.name;
    expect(bobPseudonym).toMatch(/^Student \d+$/);

    const assignmentsResult = (await harness.call("list_assignments", {
      course_identifier: 60366,
      include: ["submission"],
    })) as ToolResponse;
    const assignments = parseJsonResult(assignmentsResult).assignments as Array<{
      submission: { user: { name: string; id: number } };
    }>;
    expect(assignments[0]?.submission.user.id).toBe(1002);
    expect(assignments[0]?.submission.user.name).toBe(bobPseudonym);
  });

  it("pseudonym persists across tool calls and respects per-course isolation", async () => {
    const { client } = buildMockCanvas([
      // list_users for course A
      {
        status: 200,
        data: [{ id: 1001, name: "Alice", enrollments: [{ type: "StudentEnrollment" }] }],
      },
      // list_users for course B (same student id; should be a fresh "Student 1" in that course's map)
      {
        status: 200,
        data: [{ id: 1001, name: "Alice", enrollments: [{ type: "StudentEnrollment" }] }],
      },
    ]);
    const harness = buildToolHarness();
    registerUserTools(harness.server as never, client, anonymizer);

    const resultA = (await harness.call("list_users", { course_identifier: 100 })) as ToolResponse;
    const resultB = (await harness.call("list_users", { course_identifier: 200 })) as ToolResponse;
    const usersA = parseJsonResult(resultA).users as Array<{ name: string }>;
    const usersB = parseJsonResult(resultB).users as Array<{ name: string }>;
    // Both are "Student 1" in their respective courses — text matches but they're independent allocations.
    expect(usersA[0]?.name).toBe("Student 1");
    expect(usersB[0]?.name).toBe("Student 1");
    // Two distinct files on disk
    expect(await fs.stat(path.join(anonRoot, "100.json"))).toBeDefined();
    expect(await fs.stat(path.join(anonRoot, "200.json"))).toBeDefined();
  });
});
