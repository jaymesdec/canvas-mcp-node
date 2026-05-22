import { describe, expect, it } from "vitest";

import { buildMockCanvas, buildToolHarness } from "../_helpers/mockCanvas.js";
import { registerRubricTools } from "../../src/tools/rubrics.js";

interface ToolResponse {
  content?: Array<{ type: string; text: string }>;
  isError?: boolean;
  structuredContent?: Record<string, unknown>;
}

describe("registerRubricTools", () => {
  it("registers list_all_rubrics and get_rubric_details", () => {
    const { client } = buildMockCanvas([]);
    const harness = buildToolHarness();
    registerRubricTools(harness.server as never, client);
    expect([...harness.tools.keys()].sort()).toEqual(["get_rubric_details", "list_all_rubrics"]);
  });

  it("list_all_rubrics returns id/title/points/criteria per rubric", async () => {
    const { client, requests } = buildMockCanvas([
      {
        status: 200,
        data: [
          {
            id: 555,
            title: "Project Rubric",
            points_possible: 12,
            data: [{ id: "_8027", description: "Clarity", points: 4, ratings: [] }],
          },
        ],
      },
    ]);
    const harness = buildToolHarness();
    registerRubricTools(harness.server as never, client);

    const result = (await harness.call("list_all_rubrics", { course_identifier: 60366 })) as ToolResponse;
    expect(result.isError).toBeFalsy();
    expect(requests[0]?.url).toBe("/api/v1/courses/60366/rubrics");
    const rubrics = result.structuredContent?.rubrics as Array<{ id: number; title: string; criteria: unknown[] }>;
    expect(rubrics).toHaveLength(1);
    expect(rubrics[0]?.title).toBe("Project Rubric");
    expect(rubrics[0]?.criteria).toHaveLength(1);
  });

  it("list_all_rubrics on a course with no rubrics returns a friendly message", async () => {
    const { client } = buildMockCanvas([{ status: 200, data: [] }]);
    const harness = buildToolHarness();
    registerRubricTools(harness.server as never, client);
    const result = (await harness.call("list_all_rubrics", { course_identifier: 60366 })) as ToolResponse;
    expect(result.structuredContent?.count).toBe(0);
    expect(result.structuredContent?.message).toMatch(/No rubrics/);
  });

  it("list_all_rubrics with include_criteria=false omits the criteria field", async () => {
    const { client } = buildMockCanvas([
      {
        status: 200,
        data: [{ id: 555, title: "x", points_possible: 12, data: [{ id: "_1" }] }],
      },
    ]);
    const harness = buildToolHarness();
    registerRubricTools(harness.server as never, client);
    const result = (await harness.call("list_all_rubrics", {
      course_identifier: 60366,
      include_criteria: false,
    })) as ToolResponse;
    const rubrics = result.structuredContent?.rubrics as Array<Record<string, unknown>>;
    expect(rubrics[0]).not.toHaveProperty("criteria");
  });

  it("get_rubric_details returns the full rubric payload", async () => {
    const { client, requests } = buildMockCanvas([
      { status: 200, data: { id: 555, title: "Project Rubric", data: [{ id: "_8027" }] } },
    ]);
    const harness = buildToolHarness();
    registerRubricTools(harness.server as never, client);
    const result = (await harness.call("get_rubric_details", {
      course_identifier: 60366,
      rubric_id: 555,
    })) as ToolResponse;
    expect(result.isError).toBeFalsy();
    expect(requests[0]?.url).toBe("/api/v1/courses/60366/rubrics/555");
    expect(result.structuredContent?.id).toBe(555);
  });
});
