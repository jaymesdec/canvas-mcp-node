import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { buildMockCanvas, buildToolHarness, parseJsonResult, type ToolResponse } from "../_helpers/mockCanvas.js";
import { registerAssignmentTools } from "../../src/tools/assignments.js";
import { Anonymizer } from "../../src/anonymizer.js";
import type { SchoolConfig } from "../../src/schoolConfig.js";

const templatedConfig: SchoolConfig = {
  schoolName: "Test School",
  pageTemplates: {
    default: {
      description: "Generic header wrap",
      html: "<div class=\"wrap\"><h1>{{title}}</h1>{{body}}</div>",
    },
    assessment: {
      description: "Assessment layout with named slots",
      html:
        "<article class=\"assessment\"><h2>{{title}}</h2>" +
        "<section class=\"req\">{{slot:requirements}}</section>" +
        "<section class=\"grading\">{{slot:grading}}</section></article>",
      slots: {
        requirements: { description: "What students must do" },
        grading: { description: "How it's graded" },
      },
    },
  },
};

const assignmentGroupsResponse = {
  status: 200,
  data: [
    { id: 101, name: "Project", position: 1, group_weight: 15, rules: {} },
    { id: 202, name: "Homework", position: 2, group_weight: 25, rules: {} },
  ],
};

const titleFormatConfig: SchoolConfig = {
  schoolName: "Test School",
  academicCalendar: {
    weeks: [
      { week: 27, start: "2027-03-01" },
      { week: 28, start: "2027-03-08" },
      // deliberate gap 2027-03-15..21 — models a school break
      { week: 29, start: "2027-03-22" },
    ],
  },
  pageTemplates: {
    assessment: {
      description: "Assessment layout",
      titleFormat: "{type}: {name} [Week {week}] {percent}% {fair_flag}{final_flag}ASMT",
      html:
        "<article class=\"assessment\"><h2>{{title}}</h2>" +
        "<section class=\"req\">{{slot:requirements}}</section></article>",
      slots: { requirements: { description: "What students must do" } },
    },
  },
};

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
  it("registers all six assignment tools", () => {
    const { client } = buildMockCanvas([]);
    const harness = buildToolHarness();
    registerAssignmentTools(harness.server as never, client, anonymizer);
    expect([...harness.tools.keys()].sort()).toEqual([
      "create_assignment",
      "get_assignment_details",
      "get_assignment_rubric_details",
      "list_assignment_groups",
      "list_assignments",
      "update_assignment",
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

  it("list_assignments pseudonymizes role-less non-staff comment authors on embedded submissions", async () => {
    const { client, requests } = buildMockCanvas([
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
              submission_comments: [
                // Role-less UserDisplay author (production shape) — NOT in the staff set
                {
                  id: 10,
                  author_id: 2002,
                  author_name: "Charlie Peer",
                  author: { id: 2002, display_name: "Charlie Peer" },
                  comment: "Peer feedback",
                },
                {
                  id: 11,
                  author_id: 5000,
                  author_name: "Mr. Smith",
                  author: { id: 5000, display_name: "Mr. Smith" },
                  comment: "Teacher feedback",
                },
              ],
            },
          },
        ],
      },
      // staff roster fetch (buildStaffIdSet) — only issued because comments exist
      { status: 200, data: [{ id: 5000, name: "Mr. Smith" }] },
    ]);
    const harness = buildToolHarness();
    registerAssignmentTools(harness.server as never, client, anonymizer);

    const result = (await harness.call("list_assignments", {
      course_identifier: 60366,
      include: ["submission"],
    })) as ToolResponse;
    expect(result.isError).toBeFalsy();
    expect(requests[1]?.url).toBe("/api/v1/courses/60366/users");
    expect(requests[1]?.params).toMatchObject({ "enrollment_type[]": ["teacher", "ta", "designer"] });

    const payload = parseJsonResult(result);
    const serialized = JSON.stringify(payload);
    expect(serialized).not.toContain("Charlie Peer");
    expect(serialized).toContain("Mr. Smith");
    const assignments = payload.assignments as Array<{
      submission: { submission_comments: Array<{ author_id: number; author_name: string }> };
    }>;
    const comments = assignments[0]!.submission.submission_comments;
    expect(comments[0]?.author_id).toBe(2002);
    expect(comments[0]?.author_name).toMatch(/^Student \d+$/);
    expect(comments[1]?.author_name).toBe("Mr. Smith");
  });

  it("list_assignments skips the staff-roster fetch when no embedded submission has comments", async () => {
    const { client, requests } = buildMockCanvas([
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
    })) as ToolResponse;
    expect(result.isError).toBeFalsy();
    expect(requests).toHaveLength(1);
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

  it("create_assignment POSTs published:false plus only the provided fields", async () => {
    const { client, requests } = buildMockCanvas([
      {
        status: 200,
        data: {
          id: 555,
          name: "New Project",
          due_at: "2026-09-01T23:59:00Z",
          points_possible: 20,
          published: false,
          workflow_state: "unpublished",
        },
      },
    ]);
    const harness = buildToolHarness();
    registerAssignmentTools(harness.server as never, client, anonymizer);

    const result = (await harness.call("create_assignment", {
      course_identifier: 60366,
      name: "New Project",
      due_at: "2026-09-01T23:59:00Z",
      points_possible: 20,
    })) as ToolResponse;
    expect(result.isError).toBeFalsy();
    expect(requests[0]?.method).toBe("POST");
    expect(requests[0]?.url).toBe("/api/v1/courses/60366/assignments");
    expect(requests[0]?.data).toEqual({
      assignment: {
        name: "New Project",
        due_at: "2026-09-01T23:59:00Z",
        points_possible: 20,
        published: false,
      },
    });
    const payload = parseJsonResult(result);
    expect((payload.assignment as Record<string, unknown>).id).toBe(555);
    expect(result.content?.[0]?.text).toContain("draft");
    expect(result.content?.[0]?.text).toContain("unpublished");
  });

  describe("description templates", () => {
    it("create_assignment wraps the description in the 'default' template when a school config is loaded", async () => {
      const { client, requests } = buildMockCanvas([
        { status: 200, data: { id: 700, name: "Essay 1", published: false, workflow_state: "unpublished" } },
      ]);
      const harness = buildToolHarness();
      registerAssignmentTools(harness.server as never, client, anonymizer, templatedConfig);

      const result = (await harness.call("create_assignment", {
        course_identifier: 60366,
        name: "Essay 1",
        description: "<p>Write an essay.</p>",
      })) as ToolResponse;
      expect(result.isError).toBeFalsy();
      const payload = (requests[0]?.data as { assignment: { description: string } }).assignment;
      expect(payload.description).toBe('<div class="wrap"><h1>Essay 1</h1><p>Write an essay.</p></div>');
      expect(parseJsonResult(result).template_applied).toBe("default");
      expect(parseJsonResult(result)).not.toHaveProperty("suggested_title_flags");
    });

    it("create_assignment with template='assessment' substitutes slot content", async () => {
      const { client, requests } = buildMockCanvas([
        assignmentGroupsResponse,
        { status: 200, data: { id: 701, name: "Watershed ASMT", published: false } },
      ]);
      const harness = buildToolHarness();
      registerAssignmentTools(harness.server as never, client, anonymizer, templatedConfig);

      const result = (await harness.call("create_assignment", {
        course_identifier: 60366,
        name: "Watershed ASMT",
        template: "assessment",
        final_asmt: false,
        fair_asmt: false,
        assignment_group: "Project",
        slots: {
          requirements: "<p>20 multiple-choice questions.</p>",
          grading: "<p>1 point each.</p>",
        },
      })) as ToolResponse;
      expect(result.isError).toBeFalsy();
      expect(requests[0]?.url).toBe("/api/v1/courses/60366/assignment_groups");
      const payload = (requests[1]?.data as { assignment: { description: string; assignment_group_id: number } })
        .assignment;
      expect(payload.assignment_group_id).toBe(101);
      expect(payload.description).toContain("<h2>Watershed ASMT</h2>");
      expect(payload.description).toContain('<section class="req"><p>20 multiple-choice questions.</p></section>');
      expect(payload.description).toContain('<section class="grading"><p>1 point each.</p></section>');
      expect(payload.description).not.toContain("{{slot:");
      expect(parseJsonResult(result).template_applied).toBe("assessment");
      expect(parseJsonResult(result).suggested_title_flags).toBe("");
      expect(parseJsonResult(result).resolved_percent).toBe(15);
      expect(parseJsonResult(result)).not.toHaveProperty("suggested_title");
      expect(parseJsonResult(result)).not.toHaveProperty("warnings");
    });

    it("create_assignment with template='none' sends the description verbatim", async () => {
      const { client, requests } = buildMockCanvas([
        { status: 200, data: { id: 702, name: "Raw", published: false } },
      ]);
      const harness = buildToolHarness();
      registerAssignmentTools(harness.server as never, client, anonymizer, templatedConfig);

      const result = (await harness.call("create_assignment", {
        course_identifier: 60366,
        name: "Raw",
        description: "<p>Untouched</p>",
        template: "none",
      })) as ToolResponse;
      const payload = (requests[0]?.data as { assignment: { description: string } }).assignment;
      expect(payload.description).toBe("<p>Untouched</p>");
      expect(parseJsonResult(result).template_applied).toBeNull();
    });

    it("create_assignment with neither description nor slots skips templating entirely (no chrome-only descriptions)", async () => {
      const { client, requests } = buildMockCanvas([
        { status: 200, data: { id: 703, name: "No Description", published: false } },
      ]);
      const harness = buildToolHarness();
      registerAssignmentTools(harness.server as never, client, anonymizer, templatedConfig);

      const result = (await harness.call("create_assignment", {
        course_identifier: 60366,
        name: "No Description",
        points_possible: 5,
      })) as ToolResponse;
      expect(result.isError).toBeFalsy();
      const payload = (requests[0]?.data as { assignment: Record<string, unknown> }).assignment;
      expect(payload).not.toHaveProperty("description");
      expect(parseJsonResult(result)).not.toHaveProperty("template_applied");
    });

    it("create_assignment sends the description verbatim when no school config is loaded (generic mode)", async () => {
      const { client, requests } = buildMockCanvas([
        { status: 200, data: { id: 704, name: "Plain", published: false } },
      ]);
      const harness = buildToolHarness();
      registerAssignmentTools(harness.server as never, client, anonymizer, null);

      const result = (await harness.call("create_assignment", {
        course_identifier: 60366,
        name: "Plain",
        description: "<p>Plain description</p>",
      })) as ToolResponse;
      const payload = (requests[0]?.data as { assignment: { description: string } }).assignment;
      expect(payload.description).toBe("<p>Plain description</p>");
      expect(parseJsonResult(result).template_applied).toBeNull();
    });

    it("update_assignment stays in simple mode (verbatim description) when no template args are passed", async () => {
      const { client, requests } = buildMockCanvas([
        { status: 200, data: { id: 555, name: "HW1", description: "<p>raw update</p>" } },
      ]);
      const harness = buildToolHarness();
      registerAssignmentTools(harness.server as never, client, anonymizer, templatedConfig);

      const result = (await harness.call("update_assignment", {
        course_identifier: 60366,
        assignment_id: 555,
        description: "<p>raw update</p>",
      })) as ToolResponse;
      expect(result.isError).toBeFalsy();
      expect(requests[0]?.method).toBe("PUT");
      expect(requests[0]?.data).toEqual({ assignment: { description: "<p>raw update</p>" } });
      expect(parseJsonResult(result)).not.toHaveProperty("template_applied");
    });

    it("update_assignment with template+slots rebuilds the description (name provided, no extra assignment GET)", async () => {
      const { client, requests } = buildMockCanvas([
        assignmentGroupsResponse,
        { status: 200, data: { id: 555, name: "Watershed ASMT v2", published: false } },
      ]);
      const harness = buildToolHarness();
      registerAssignmentTools(harness.server as never, client, anonymizer, templatedConfig);

      const result = (await harness.call("update_assignment", {
        course_identifier: 60366,
        assignment_id: 555,
        name: "Watershed ASMT v2",
        template: "assessment",
        final_asmt: false,
        fair_asmt: false,
        assignment_group: "Project",
        slots: {
          requirements: "<p>Updated requirements.</p>",
          grading: "<p>Updated grading.</p>",
        },
      })) as ToolResponse;
      expect(result.isError).toBeFalsy();
      expect(requests).toHaveLength(2);
      expect(requests[0]?.url).toBe("/api/v1/courses/60366/assignment_groups");
      expect(requests[1]?.method).toBe("PUT");
      const payload = (requests[1]?.data as { assignment: { name: string; description: string } }).assignment;
      expect(payload.name).toBe("Watershed ASMT v2");
      expect(payload.description).toContain("<h2>Watershed ASMT v2</h2>");
      expect(payload.description).toContain("<p>Updated requirements.</p>");
      expect(payload.description).toContain("<p>Updated grading.</p>");
      expect(parseJsonResult(result).template_applied).toBe("assessment");
    });

    it("update_assignment fetches the existing name for {{title}} when name is not being updated", async () => {
      const { client, requests } = buildMockCanvas([
        assignmentGroupsResponse,
        // GET assignment to resolve the name for the {{title}} token
        { status: 200, data: { id: 555, name: "Existing ASMT Name", published: false } },
        // PUT response
        { status: 200, data: { id: 555, name: "Existing ASMT Name", published: false } },
      ]);
      const harness = buildToolHarness();
      registerAssignmentTools(harness.server as never, client, anonymizer, templatedConfig);

      const result = (await harness.call("update_assignment", {
        course_identifier: 60366,
        assignment_id: 555,
        template: "assessment",
        final_asmt: false,
        fair_asmt: false,
        assignment_group: 101,
        slots: { requirements: "<p>r</p>", grading: "<p>g</p>" },
      })) as ToolResponse;
      expect(result.isError).toBeFalsy();
      expect(requests[0]?.url).toBe("/api/v1/courses/60366/assignment_groups");
      expect(requests[1]?.method).toBe("GET");
      expect(requests[1]?.url).toBe("/api/v1/courses/60366/assignments/555");
      const putRequest = requests.at(-1);
      expect(putRequest?.method).toBe("PUT");
      const payload = (putRequest?.data as { assignment: Record<string, unknown> }).assignment;
      // Name was fetched only to fill {{title}} — the Canvas name field is not updated.
      expect(payload).not.toHaveProperty("name");
      expect(payload.description).toContain("<h2>Existing ASMT Name</h2>");
    });
  });

  describe("FAIR/FINAL assessment flags", () => {
    it("create_assignment with template='assessment' but no flags fails closed with zero Canvas calls", async () => {
      const { client, requests } = buildMockCanvas([]);
      const harness = buildToolHarness();
      registerAssignmentTools(harness.server as never, client, anonymizer, templatedConfig);

      const result = (await harness.call("create_assignment", {
        course_identifier: 60366,
        name: "Watershed ASMT",
        template: "assessment",
        slots: { requirements: "<p>r</p>", grading: "<p>g</p>" },
      })) as ToolResponse;
      expect(result.isError).toBe(true);
      expect(result.content?.[0]?.text).toContain("final_asmt");
      expect(result.content?.[0]?.text).toContain("fair_asmt");
      expect(result.content?.[0]?.text).toMatch(/[Aa]sk the teacher/);
      expect(requests).toHaveLength(0);
    });

    it("create_assignment with only one flag still fails closed", async () => {
      const { client, requests } = buildMockCanvas([]);
      const harness = buildToolHarness();
      registerAssignmentTools(harness.server as never, client, anonymizer, templatedConfig);

      const result = (await harness.call("create_assignment", {
        course_identifier: 60366,
        name: "Watershed ASMT",
        template: "assessment",
        final_asmt: true,
        slots: { requirements: "<p>r</p>", grading: "<p>g</p>" },
      })) as ToolResponse;
      expect(result.isError).toBe(true);
      expect(result.content?.[0]?.text).toContain("fair_asmt");
      expect(requests).toHaveLength(0);
    });

    it("create_assignment with both flags true suggests 'FAIR FINAL ' and warns when the name lacks both tags", async () => {
      const { client } = buildMockCanvas([
        assignmentGroupsResponse,
        { status: 200, data: { id: 710, name: "Watershed ASMT", published: false } },
      ]);
      const harness = buildToolHarness();
      registerAssignmentTools(harness.server as never, client, anonymizer, templatedConfig);

      const result = (await harness.call("create_assignment", {
        course_identifier: 60366,
        name: "Watershed ASMT",
        template: "assessment",
        final_asmt: true,
        fair_asmt: true,
        assignment_group: "Project",
        slots: { requirements: "<p>r</p>", grading: "<p>g</p>" },
      })) as ToolResponse;
      expect(result.isError).toBeFalsy();
      const payload = parseJsonResult(result);
      expect(payload.suggested_title_flags).toBe("FAIR FINAL ");
      const warnings = payload.warnings as string[];
      expect(warnings).toHaveLength(2);
      expect(warnings.some((warning) => warning.includes("FINAL"))).toBe(true);
      expect(warnings.some((warning) => warning.includes("FAIR"))).toBe(true);
    });

    it("create_assignment warns when the assessment name is missing the ASMT suffix", async () => {
      const { client } = buildMockCanvas([
        assignmentGroupsResponse,
        { status: 200, data: { id: 711, name: "Watershed Test", published: false } },
      ]);
      const harness = buildToolHarness();
      registerAssignmentTools(harness.server as never, client, anonymizer, templatedConfig);

      const result = (await harness.call("create_assignment", {
        course_identifier: 60366,
        name: "Watershed Test",
        template: "assessment",
        final_asmt: false,
        fair_asmt: false,
        assignment_group: "Project",
        slots: { requirements: "<p>r</p>", grading: "<p>g</p>" },
      })) as ToolResponse;
      expect(result.isError).toBeFalsy();
      const warnings = parseJsonResult(result).warnings as string[];
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toMatch(/does not end with "ASMT"/);
    });

    it("create_assignment warns when fair_asmt is false but the name contains FAIR", async () => {
      const { client } = buildMockCanvas([
        assignmentGroupsResponse,
        { status: 200, data: { id: 712, name: "Unit 1 FAIR ASMT", published: false } },
      ]);
      const harness = buildToolHarness();
      registerAssignmentTools(harness.server as never, client, anonymizer, templatedConfig);

      const result = (await harness.call("create_assignment", {
        course_identifier: 60366,
        name: "Unit 1 FAIR ASMT",
        template: "assessment",
        final_asmt: false,
        fair_asmt: false,
        assignment_group: "Project",
        slots: { requirements: "<p>r</p>", grading: "<p>g</p>" },
      })) as ToolResponse;
      expect(result.isError).toBeFalsy();
      const warnings = parseJsonResult(result).warnings as string[];
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toMatch(/fair_asmt is false/);
      expect(warnings[0]).toContain("FAIR");
    });

    it("create_assignment with a correctly tagged FINAL-only title has no warnings and suggests 'FINAL '", async () => {
      const { client } = buildMockCanvas([
        assignmentGroupsResponse,
        { status: 200, data: { id: 713, name: "Quiz: Watershed [Week 12] 10% FINAL ASMT", published: false } },
      ]);
      const harness = buildToolHarness();
      registerAssignmentTools(harness.server as never, client, anonymizer, templatedConfig);

      const result = (await harness.call("create_assignment", {
        course_identifier: 60366,
        name: "Quiz: Watershed [Week 12] 10% FINAL ASMT",
        template: "assessment",
        final_asmt: true,
        fair_asmt: false,
        assignment_group: "Project",
        slots: { requirements: "<p>r</p>", grading: "<p>g</p>" },
      })) as ToolResponse;
      expect(result.isError).toBeFalsy();
      const payload = parseJsonResult(result);
      expect(payload.suggested_title_flags).toBe("FINAL ");
      expect(payload).not.toHaveProperty("warnings");
    });

    it("update_assignment re-applying template='assessment' without flags fails closed with zero Canvas calls", async () => {
      const { client, requests } = buildMockCanvas([]);
      const harness = buildToolHarness();
      registerAssignmentTools(harness.server as never, client, anonymizer, templatedConfig);

      const result = (await harness.call("update_assignment", {
        course_identifier: 60366,
        assignment_id: 555,
        template: "assessment",
        slots: { requirements: "<p>r</p>", grading: "<p>g</p>" },
      })) as ToolResponse;
      expect(result.isError).toBe(true);
      expect(result.content?.[0]?.text).toContain("final_asmt");
      expect(result.content?.[0]?.text).toContain("fair_asmt");
      expect(requests).toHaveLength(0);
    });

    it("update_assignment checks the existing name against the flags on update-without-rename", async () => {
      const { client } = buildMockCanvas([
        assignmentGroupsResponse,
        { status: 200, data: { id: 555, name: "Project: Watershed [Week 3] 20% ASMT", published: false } },
        { status: 200, data: { id: 555, name: "Project: Watershed [Week 3] 20% ASMT", published: false } },
      ]);
      const harness = buildToolHarness();
      registerAssignmentTools(harness.server as never, client, anonymizer, templatedConfig);

      const result = (await harness.call("update_assignment", {
        course_identifier: 60366,
        assignment_id: 555,
        template: "assessment",
        final_asmt: true,
        fair_asmt: false,
        assignment_group: "Project",
        slots: { requirements: "<p>r</p>", grading: "<p>g</p>" },
      })) as ToolResponse;
      expect(result.isError).toBeFalsy();
      const payload = parseJsonResult(result);
      expect(payload.suggested_title_flags).toBe("FINAL ");
      const warnings = payload.warnings as string[];
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toMatch(/final_asmt is true/);
    });

    it("non-assessment templates are unaffected by absent flags", async () => {
      const { client } = buildMockCanvas([
        { status: 200, data: { id: 714, name: "Essay 2", published: false } },
      ]);
      const harness = buildToolHarness();
      registerAssignmentTools(harness.server as never, client, anonymizer, templatedConfig);

      const result = (await harness.call("create_assignment", {
        course_identifier: 60366,
        name: "Essay 2",
        description: "<p>Write.</p>",
      })) as ToolResponse;
      expect(result.isError).toBeFalsy();
      expect(parseJsonResult(result)).not.toHaveProperty("suggested_title_flags");
      expect(parseJsonResult(result)).not.toHaveProperty("warnings");
    });
  });

  describe("assignment groups and suggested_title", () => {
    it("list_assignment_groups returns trimmed groups and notes when weights are not applied", async () => {
      const { client, requests } = buildMockCanvas([
        assignmentGroupsResponse,
        { status: 200, data: { id: 60366, name: "DTC 9", apply_assignment_group_weights: false } },
      ]);
      const harness = buildToolHarness();
      registerAssignmentTools(harness.server as never, client, anonymizer, templatedConfig);

      const result = (await harness.call("list_assignment_groups", {
        course_identifier: 60366,
      })) as ToolResponse;
      expect(result.isError).toBeFalsy();
      expect(requests[0]?.url).toBe("/api/v1/courses/60366/assignment_groups");
      const payload = parseJsonResult(result);
      expect(payload.apply_assignment_group_weights).toBe(false);
      expect(payload.assignment_groups).toEqual([
        { id: 101, name: "Project", position: 1, group_weight: 15 },
        { id: 202, name: "Homework", position: 2, group_weight: 25 },
      ]);
      expect(result.content?.[0]?.text).toContain("NOT applied");
    });

    it("create_assignment fails closed when template='assessment' has no assignment_group, listing the course's groups", async () => {
      const { client, requests } = buildMockCanvas([assignmentGroupsResponse]);
      const harness = buildToolHarness();
      registerAssignmentTools(harness.server as never, client, anonymizer, templatedConfig);

      const result = (await harness.call("create_assignment", {
        course_identifier: 60366,
        name: "Watershed ASMT",
        template: "assessment",
        final_asmt: true,
        fair_asmt: false,
        slots: { requirements: "<p>r</p>", grading: "<p>g</p>" },
      })) as ToolResponse;
      expect(result.isError).toBe(true);
      expect(result.content?.[0]?.text).toContain("assignment_group");
      expect(result.content?.[0]?.text).toContain('"Project" (id 101, weight 15%)');
      expect(result.content?.[0]?.text).toContain('"Homework" (id 202, weight 25%)');
      expect(requests).toHaveLength(1);
    });

    it("create_assignment rejects an unknown assignment_group with the group list and zero writes", async () => {
      const { client, requests } = buildMockCanvas([assignmentGroupsResponse]);
      const harness = buildToolHarness();
      registerAssignmentTools(harness.server as never, client, anonymizer, templatedConfig);

      const result = (await harness.call("create_assignment", {
        course_identifier: 60366,
        name: "Watershed ASMT",
        template: "assessment",
        final_asmt: false,
        fair_asmt: false,
        assignment_group: "Portfolio",
        slots: { requirements: "<p>r</p>", grading: "<p>g</p>" },
      })) as ToolResponse;
      expect(result.isError).toBe(true);
      expect(result.content?.[0]?.text).toContain("does not match any assignment group");
      expect(result.content?.[0]?.text).toContain('"Project" (id 101');
      expect(requests).toHaveLength(1);
    });

    it("composes suggested_title from the titleFormat with group name, group weight, and due-date week", async () => {
      const { client } = buildMockCanvas([
        assignmentGroupsResponse,
        { status: 200, data: { id: 720, name: "MCP Server Build", published: false } },
      ]);
      const harness = buildToolHarness();
      registerAssignmentTools(harness.server as never, client, anonymizer, titleFormatConfig);

      const result = (await harness.call("create_assignment", {
        course_identifier: 60366,
        name: "MCP Server Build",
        template: "assessment",
        final_asmt: true,
        fair_asmt: true,
        assignment_group: "project",
        due_at: "2027-03-10T23:59:00Z",
        slots: { requirements: "<p>r</p>" },
      })) as ToolResponse;
      expect(result.isError).toBeFalsy();
      const payload = parseJsonResult(result);
      expect(payload.suggested_title).toBe("Project: MCP Server Build [Week 28] 15% FAIR FINAL ASMT");
      expect(payload.resolved_percent).toBe(15);
      expect(payload.assignment_group).toEqual({ id: 101, name: "Project", group_weight: 15 });
    });

    it("substitutes '?' for the week and warns when the due date falls outside the calendar", async () => {
      const { client } = buildMockCanvas([
        assignmentGroupsResponse,
        { status: 200, data: { id: 721, name: "Summer ASMT", published: false } },
      ]);
      const harness = buildToolHarness();
      registerAssignmentTools(harness.server as never, client, anonymizer, titleFormatConfig);

      const result = (await harness.call("create_assignment", {
        course_identifier: 60366,
        name: "Summer ASMT",
        template: "assessment",
        final_asmt: false,
        fair_asmt: false,
        assignment_group: 101,
        due_at: "2027-07-01T23:59:00Z",
        slots: { requirements: "<p>r</p>" },
      })) as ToolResponse;
      expect(result.isError).toBeFalsy();
      const payload = parseJsonResult(result);
      expect(payload.suggested_title).toContain("[Week ?]");
      const warnings = payload.warnings as string[];
      expect(warnings.some((warning) => warning.includes("after the school year's last configured week"))).toBe(true);
      expect(warnings.some((warning) => warning.includes("Week 29 ends 2027-03-28"))).toBe(true);
    });

    it("names the surrounding weeks when the due date falls during a school break", async () => {
      const { client } = buildMockCanvas([
        assignmentGroupsResponse,
        { status: 200, data: { id: 724, name: "Break ASMT", published: false } },
      ]);
      const harness = buildToolHarness();
      registerAssignmentTools(harness.server as never, client, anonymizer, titleFormatConfig);

      const result = (await harness.call("create_assignment", {
        course_identifier: 60366,
        name: "Break ASMT",
        template: "assessment",
        final_asmt: false,
        fair_asmt: false,
        assignment_group: "Project",
        due_at: "2027-03-17T23:59:00Z",
        slots: { requirements: "<p>r</p>" },
      })) as ToolResponse;
      expect(result.isError).toBeFalsy();
      const payload = parseJsonResult(result);
      expect(payload.suggested_title).toContain("[Week ?]");
      const warnings = payload.warnings as string[];
      const breakWarning = warnings.find((warning) => warning.includes("SCHOOL BREAK"));
      expect(breakWarning).toBeDefined();
      expect(breakWarning).toContain("Week 28 (ends 2027-03-14)");
      expect(breakWarning).toContain("Week 29 (begins 2027-03-22)");
      expect(breakWarning).toContain("Do NOT estimate a week number yourself");
    });

    it("requires asmt_percent when the group has no usable weight, then uses it in the title", async () => {
      const weightlessGroups = {
        status: 200,
        data: [{ id: 301, name: "Unweighted", position: 1, group_weight: 0, rules: {} }],
      };
      const { client, requests } = buildMockCanvas([weightlessGroups]);
      const harness = buildToolHarness();
      registerAssignmentTools(harness.server as never, client, anonymizer, titleFormatConfig);

      const failed = (await harness.call("create_assignment", {
        course_identifier: 60366,
        name: "Weightless ASMT",
        template: "assessment",
        final_asmt: false,
        fair_asmt: false,
        assignment_group: "Unweighted",
        slots: { requirements: "<p>r</p>" },
      })) as ToolResponse;
      expect(failed.isError).toBe(true);
      expect(failed.content?.[0]?.text).toContain("asmt_percent");
      expect(requests).toHaveLength(1);

      const { client: client2 } = buildMockCanvas([
        weightlessGroups,
        { status: 200, data: { id: 722, name: "Weightless ASMT", published: false } },
      ]);
      const harness2 = buildToolHarness();
      registerAssignmentTools(harness2.server as never, client2, anonymizer, titleFormatConfig);

      const result = (await harness2.call("create_assignment", {
        course_identifier: 60366,
        name: "Weightless ASMT",
        template: "assessment",
        final_asmt: false,
        fair_asmt: false,
        assignment_group: "Unweighted",
        asmt_percent: 12,
        due_at: "2027-03-10T23:59:00Z",
        slots: { requirements: "<p>r</p>" },
      })) as ToolResponse;
      expect(result.isError).toBeFalsy();
      const payload = parseJsonResult(result);
      expect(payload.resolved_percent).toBe(12);
      expect(payload.suggested_title).toContain("12%");
    });

    it("warns when asmt_percent disagrees with the Canvas group weight (Canvas wins)", async () => {
      const { client } = buildMockCanvas([
        assignmentGroupsResponse,
        { status: 200, data: { id: 723, name: "Mismatch ASMT", published: false } },
      ]);
      const harness = buildToolHarness();
      registerAssignmentTools(harness.server as never, client, anonymizer, titleFormatConfig);

      const result = (await harness.call("create_assignment", {
        course_identifier: 60366,
        name: "Mismatch ASMT",
        template: "assessment",
        final_asmt: false,
        fair_asmt: false,
        assignment_group: "Project",
        asmt_percent: 40,
        due_at: "2027-03-10T23:59:00Z",
        slots: { requirements: "<p>r</p>" },
      })) as ToolResponse;
      expect(result.isError).toBeFalsy();
      const payload = parseJsonResult(result);
      expect(payload.resolved_percent).toBe(15);
      expect(payload.suggested_title).toContain("15%");
      const warnings = payload.warnings as string[];
      expect(warnings.some((warning) => warning.includes("group_weight 15"))).toBe(true);
    });

    it("update_assignment in simple mode regroups via assignment_group without template machinery", async () => {
      const { client, requests } = buildMockCanvas([
        assignmentGroupsResponse,
        { status: 200, data: { id: 555, name: "HW1", published: false } },
      ]);
      const harness = buildToolHarness();
      registerAssignmentTools(harness.server as never, client, anonymizer, templatedConfig);

      const result = (await harness.call("update_assignment", {
        course_identifier: 60366,
        assignment_id: 555,
        assignment_group: "homework",
      })) as ToolResponse;
      expect(result.isError).toBeFalsy();
      const putRequest = requests.at(-1);
      expect(putRequest?.method).toBe("PUT");
      expect((putRequest?.data as { assignment: Record<string, unknown> }).assignment).toEqual({
        assignment_group_id: 202,
      });
      expect(parseJsonResult(result)).not.toHaveProperty("suggested_title");
    });
  });

  it("create_assignment surfaces a Canvas 403 via errorResult with tool context", async () => {
    const { client } = buildMockCanvas([
      { status: 403, data: { errors: [{ message: "unauthorized" }] } },
    ]);
    const harness = buildToolHarness();
    registerAssignmentTools(harness.server as never, client, anonymizer);

    const result = (await harness.call("create_assignment", {
      course_identifier: 60366,
      name: "Forbidden",
    })) as ToolResponse;
    expect(result.isError).toBe(true);
    expect(result.content?.[0]?.text).toContain("create_assignment");
    expect(result.content?.[0]?.text).toContain("403");
  });

  it("update_assignment PUTs a partial payload and never sends published", async () => {
    const { client, requests } = buildMockCanvas([
      {
        status: 200,
        data: { id: 555, name: "Renamed", published: true, workflow_state: "published" },
      },
    ]);
    const harness = buildToolHarness();
    registerAssignmentTools(harness.server as never, client, anonymizer);

    const result = (await harness.call("update_assignment", {
      course_identifier: 60366,
      assignment_id: 555,
      name: "Renamed",
    })) as ToolResponse;
    expect(result.isError).toBeFalsy();
    expect(requests[0]?.method).toBe("PUT");
    expect(requests[0]?.url).toBe("/api/v1/courses/60366/assignments/555");
    expect(requests[0]?.data).toEqual({ assignment: { name: "Renamed" } });
  });

  it("update_assignment with zero updatable fields errors without any HTTP call", async () => {
    const { client, requests } = buildMockCanvas([]);
    const harness = buildToolHarness();
    registerAssignmentTools(harness.server as never, client, anonymizer);

    const result = (await harness.call("update_assignment", {
      course_identifier: 60366,
      assignment_id: 555,
    })) as ToolResponse;
    expect(result.isError).toBe(true);
    expect(result.content?.[0]?.text).toMatch(/provide at least one field/);
    expect(requests).toHaveLength(0);
  });

  it("update_assignment warns when Canvas silently ignores a submission_types change", async () => {
    const { client } = buildMockCanvas([
      {
        status: 200,
        data: { id: 555, name: "HW1", submission_types: ["online_text_entry"] },
      },
    ]);
    const harness = buildToolHarness();
    registerAssignmentTools(harness.server as never, client, anonymizer);

    const result = (await harness.call("update_assignment", {
      course_identifier: 60366,
      assignment_id: 555,
      submission_types: ["online_upload"],
    })) as ToolResponse;
    expect(result.isError).toBeFalsy();
    const warnings = parseJsonResult(result).warnings as string[];
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/submission_types/);
    expect(warnings[0]).toMatch(/student submissions/);
  });

  it("update_assignment with a matching submission_types echo has no warnings key", async () => {
    const { client } = buildMockCanvas([
      {
        status: 200,
        data: { id: 555, name: "HW1", submission_types: ["online_upload", "online_url"] },
      },
    ]);
    const harness = buildToolHarness();
    registerAssignmentTools(harness.server as never, client, anonymizer);

    const result = (await harness.call("update_assignment", {
      course_identifier: 60366,
      assignment_id: 555,
      submission_types: ["online_url", "online_upload"],
    })) as ToolResponse;
    expect(result.isError).toBeFalsy();
    expect(parseJsonResult(result)).not.toHaveProperty("warnings");
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
