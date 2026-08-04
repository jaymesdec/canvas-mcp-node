import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { buildMockCanvas, buildToolHarness, parseJsonResult, type ToolResponse } from "../_helpers/mockCanvas.js";
import { registerAssignmentTools } from "../../src/tools/assignments.js";
import { Anonymizer } from "../../src/anonymizer.js";

async function tempRoot(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), "canvas-anon-assign-"));
}

let anonRoot: string;
let anonymizer: Anonymizer;
beforeEach(async () => {
  anonRoot = await tempRoot();
  anonymizer = new Anonymizer({ rootDir: anonRoot });
  await anonymizer.init();
});
afterEach(async () => {
  await fs.rm(anonRoot, { recursive: true, force: true });
});

describe("registerAssignmentTools", () => {
  it("registers all three assignment tools", () => {
    const { client } = buildMockCanvas([]);
    const harness = buildToolHarness();
    registerAssignmentTools(harness.server as never, client, anonymizer);
    expect([...harness.tools.keys()].sort()).toEqual([
      "get_assignment_details",
      "get_assignment_rubric_details",
      "list_assignments",
    ]);
  });

  it("list_assignments paginates and threads include[] params", async () => {
    const { client, requests } = buildMockCanvas([
      { status: 200, data: [{ id: 1, name: "HW1" }, { id: 2, name: "HW2" }] },
    ]);
    const harness = buildToolHarness();
    registerAssignmentTools(harness.server as never, client, anonymizer);

    const result = (await harness.call("list_assignments", {
      course_identifier: 60366,
      include: ["all_dates"],
    })) as ToolResponse;
    expect(result.isError).toBeFalsy();
    expect(requests[0]?.url).toBe("/api/v1/courses/60366/assignments");
    expect(requests[0]?.params).toMatchObject({ "include[]": ["all_dates"] });
    expect(parseJsonResult(result).count).toBe(2);
  });

  it("list_assignments returns the exact trimmed key set and omits description by default", async () => {
    const { client } = buildMockCanvas([
      {
        status: 200,
        data: [
          {
            id: 1,
            name: "HW1",
            description: "<p>Big HTML description</p>",
            due_at: "2026-06-01T23:59:00Z",
            unlock_at: null,
            lock_at: null,
            points_possible: 10,
            published: true,
            workflow_state: "published",
            submission_types: ["online_upload"],
            rubric: [{ id: "_1", description: "Clarity" }],
            all_dates: [{ due_at: "2026-06-01T23:59:00Z" }],
            html_url: "https://canvas.example.com/assignments/1",
          },
          { id: 2, name: "HW2", published: false, workflow_state: "unpublished" },
        ],
      },
    ]);
    const harness = buildToolHarness();
    registerAssignmentTools(harness.server as never, client, anonymizer);

    const result = (await harness.call("list_assignments", { course_identifier: 60366 })) as ToolResponse;
    const assignments = parseJsonResult(result).assignments as Array<Record<string, unknown>>;
    expect(Object.keys(assignments[0]!).sort()).toEqual(
      [
        "id",
        "name",
        "due_at",
        "unlock_at",
        "lock_at",
        "points_possible",
        "published",
        "workflow_state",
        "submission_types",
        "has_rubric",
      ].sort(),
    );
    expect(assignments[0]?.has_rubric).toBe(true);
    expect(assignments[1]?.has_rubric).toBe(false);
    expect(JSON.stringify(parseJsonResult(result))).not.toContain("Big HTML description");
  });

  it("list_assignments includes description when include_description=true", async () => {
    const { client } = buildMockCanvas([
      { status: 200, data: [{ id: 1, name: "HW1", description: "<p>Big HTML description</p>" }] },
    ]);
    const harness = buildToolHarness();
    registerAssignmentTools(harness.server as never, client, anonymizer);

    const result = (await harness.call("list_assignments", {
      course_identifier: 60366,
      include_description: true,
    })) as ToolResponse;
    const assignments = parseJsonResult(result).assignments as Array<Record<string, unknown>>;
    expect(assignments[0]?.description).toBe("<p>Big HTML description</p>");
  });

  it("list_assignments published_only=true filters out unpublished assignments client-side", async () => {
    const { client } = buildMockCanvas([
      {
        status: 200,
        data: [
          { id: 1, name: "HW1", published: true, workflow_state: "published" },
          { id: 2, name: "Draft HW", published: false, workflow_state: "unpublished" },
          { id: 3, name: "HW3", workflow_state: "published" },
        ],
      },
    ]);
    const harness = buildToolHarness();
    registerAssignmentTools(harness.server as never, client, anonymizer);

    const result = (await harness.call("list_assignments", {
      course_identifier: 60366,
      published_only: true,
    })) as ToolResponse;
    expect(parseJsonResult(result).count).toBe(2);
    const assignments = parseJsonResult(result).assignments as Array<{ id: number }>;
    expect(assignments.map((assignment) => assignment.id)).toEqual([1, 3]);
  });

  it("list_assignments with include=submission anonymizes embedded student data when anonymous=true (default)", async () => {
    const { client } = buildMockCanvas([
      {
        status: 200,
        data: [
          {
            id: 1,
            name: "HW1",
            submission: {
              id: 99,
              user_id: 1001,
              user: { id: 1001, name: "Alice Real", role: "student" },
            },
          },
        ],
      },
    ]);
    const harness = buildToolHarness();
    registerAssignmentTools(harness.server as never, client, anonymizer);

    const result = (await harness.call("list_assignments", {
      course_identifier: 60366,
      include: ["submission"],
    })) as ToolResponse;
    expect(result.isError).toBeFalsy();
    expect(parseJsonResult(result).anonymized).toBe(true);
    const assignments = parseJsonResult(result).assignments as Array<{
      submission: { user: { name: string } };
    }>;
    expect(assignments[0]?.submission.user.name).toBe("Student 1");
  });

  it("list_assignments anonymous=false without operator env opt-in: silently anonymizes + warns", async () => {
    const previousEnv = process.env.CANVAS_MCP_ALLOW_DEANONYMIZE;
    delete process.env.CANVAS_MCP_ALLOW_DEANONYMIZE;
    try {
      const { client } = buildMockCanvas([
        {
          status: 200,
          data: [
            {
              id: 1,
              name: "HW1",
              submission: { id: 99, user_id: 1001, user: { id: 1001, name: "Alice Real", role: "student" } },
            },
          ],
        },
      ]);
      const harness = buildToolHarness();
      registerAssignmentTools(harness.server as never, client, anonymizer);

      const result = (await harness.call("list_assignments", {
        course_identifier: 60366,
        include: ["submission"],
        anonymous: false,
      })) as ToolResponse;
      expect(parseJsonResult(result).anonymized).toBe(true);
      const assignments = parseJsonResult(result).assignments as Array<{
        submission: { user: { name: string } };
      }>;
      expect(assignments[0]?.submission.user.name).toBe("Student 1");
      const warnings = parseJsonResult(result).warnings as string[];
      expect(warnings?.[0]).toMatch(/CANVAS_MCP_ALLOW_DEANONYMIZE/);
    } finally {
      if (previousEnv === undefined) delete process.env.CANVAS_MCP_ALLOW_DEANONYMIZE;
      else process.env.CANVAS_MCP_ALLOW_DEANONYMIZE = previousEnv;
    }
  });

  it("list_assignments anonymous=false WITH operator env opt-in: leaves embedded submissions untouched", async () => {
    const previousEnv = process.env.CANVAS_MCP_ALLOW_DEANONYMIZE;
    process.env.CANVAS_MCP_ALLOW_DEANONYMIZE = "true";
    try {
      const { client } = buildMockCanvas([
        {
          status: 200,
          data: [
            {
              id: 1,
              name: "HW1",
              submission: { id: 99, user_id: 1001, user: { id: 1001, name: "Alice Real", role: "student" } },
            },
          ],
        },
      ]);
      const harness = buildToolHarness();
      registerAssignmentTools(harness.server as never, client, anonymizer);

      const result = (await harness.call("list_assignments", {
        course_identifier: 60366,
        include: ["submission"],
        anonymous: false,
      })) as ToolResponse;
      expect(parseJsonResult(result).anonymized).toBe(false);
      const assignments = parseJsonResult(result).assignments as Array<{
        submission: { user: { name: string } };
      }>;
      expect(assignments[0]?.submission.user.name).toBe("Alice Real");
    } finally {
      if (previousEnv === undefined) delete process.env.CANVAS_MCP_ALLOW_DEANONYMIZE;
      else process.env.CANVAS_MCP_ALLOW_DEANONYMIZE = previousEnv;
    }
  });

  it("get_assignment_details returns the raw assignment", async () => {
    const { client, requests } = buildMockCanvas([
      { status: 200, data: { id: 999, name: "Project", due_at: "2026-06-01T23:59:00Z" } },
    ]);
    const harness = buildToolHarness();
    registerAssignmentTools(harness.server as never, client, anonymizer);

    const result = (await harness.call("get_assignment_details", {
      course_identifier: 60366,
      assignment_id: 999,
    })) as ToolResponse;
    expect(result.isError).toBeFalsy();
    expect(requests[0]?.url).toBe("/api/v1/courses/60366/assignments/999");
    expect(parseJsonResult(result).id).toBe(999);
  });

  it("get_assignment_rubric_details surfaces a clean message when no rubric is attached", async () => {
    const { client } = buildMockCanvas([
      { status: 200, data: { id: 999, name: "Project", rubric: null } },
    ]);
    const harness = buildToolHarness();
    registerAssignmentTools(harness.server as never, client, anonymizer);

    const result = (await harness.call("get_assignment_rubric_details", {
      course_identifier: 60366,
      assignment_id: 999,
    })) as ToolResponse;
    expect(result.isError).toBeFalsy();
    expect(parseJsonResult(result).rubric).toBeNull();
    expect(parseJsonResult(result).message).toMatch(/No rubric/);
  });

  it("get_assignment_rubric_details returns criterion list when rubric is attached", async () => {
    const { client } = buildMockCanvas([
      {
        status: 200,
        data: {
          id: 999,
          rubric: [
            { id: "_8027", description: "Clarity", points: 4, ratings: [] },
            { id: "_8028", description: "Depth", points: 4, ratings: [] },
          ],
          rubric_settings: { points_possible: 8 },
        },
      },
    ]);
    const harness = buildToolHarness();
    registerAssignmentTools(harness.server as never, client, anonymizer);

    const result = (await harness.call("get_assignment_rubric_details", {
      course_identifier: 60366,
      assignment_id: 999,
    })) as ToolResponse;
    const rubric = parseJsonResult(result).rubric as Array<{ id: string }>;
    expect(rubric).toHaveLength(2);
    expect(rubric[0]?.id).toBe("_8027");
    expect(parseJsonResult(result).rubric_settings).toMatchObject({ points_possible: 8 });
  });
});
