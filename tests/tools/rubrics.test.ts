import { describe, expect, it } from "vitest";

import { buildMockCanvas, buildToolHarness, parseJsonResult, type ToolResponse } from "../_helpers/mockCanvas.js";
import { registerRubricTools } from "../../src/tools/rubrics.js";

function asForm(data: unknown): URLSearchParams {
  if (data instanceof URLSearchParams) return data;
  if (typeof data === "string") return new URLSearchParams(data);
  throw new Error(`rubrics test: expected URLSearchParams, got ${typeof data}`);
}

describe("registerRubricTools", () => {
  it("registers all four rubric tools", () => {
    const { client } = buildMockCanvas([]);
    const harness = buildToolHarness();
    registerRubricTools(harness.server as never, client);
    expect([...harness.tools.keys()].sort()).toEqual([
      "create_rubric",
      "create_rubric_association",
      "get_rubric_details",
      "list_all_rubrics",
    ]);
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
    const rubrics = parseJsonResult(result).rubrics as Array<{ id: number; title: string; criteria: unknown[] }>;
    expect(rubrics).toHaveLength(1);
    expect(rubrics[0]?.title).toBe("Project Rubric");
    expect(rubrics[0]?.criteria).toHaveLength(1);
  });

  it("list_all_rubrics on a course with no rubrics returns a friendly message", async () => {
    const { client } = buildMockCanvas([{ status: 200, data: [] }]);
    const harness = buildToolHarness();
    registerRubricTools(harness.server as never, client);
    const result = (await harness.call("list_all_rubrics", { course_identifier: 60366 })) as ToolResponse;
    expect(parseJsonResult(result).count).toBe(0);
    expect(parseJsonResult(result).message).toMatch(/No rubrics/);
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
    const rubrics = parseJsonResult(result).rubrics as Array<Record<string, unknown>>;
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
    expect(parseJsonResult(result).id).toBe(555);
  });

  describe("create_rubric", () => {
    it("POSTs nested form-encoded criteria + ratings", async () => {
      const { client, requests } = buildMockCanvas([
        {
          status: 200,
          data: {
            rubric: { id: 999, title: "Project Rubric", points_possible: 16 },
          },
        },
      ]);
      const harness = buildToolHarness();
      registerRubricTools(harness.server as never, client);
      const result = (await harness.call("create_rubric", {
        course_identifier: 60366,
        title: "Project Rubric",
        free_form_criterion_comments: true,
        criteria: [
          {
            description: "Clarity",
            long_description: "How clearly the work communicates its purpose.",
            ratings: [
              { description: "Excellent", points: 4 },
              { description: "Proficient", points: 3 },
              { description: "Developing", points: 2 },
              { description: "Beginning", points: 1 },
            ],
          },
          {
            description: "Use of Evidence",
            ratings: [
              { description: "Excellent", points: 4, long_description: "Multiple specific examples." },
              { description: "Beginning", points: 1 },
            ],
          },
        ],
      })) as ToolResponse;

      expect(result.isError).toBeFalsy();
      expect(requests[0]?.method).toBe("POST");
      expect(requests[0]?.url).toBe("/api/v1/courses/60366/rubrics");
      const body = asForm(requests[0]?.data);
      expect(body.get("rubric[title]")).toBe("Project Rubric");
      expect(body.get("rubric[free_form_criterion_comments]")).toBe("true");
      expect(body.get("rubric[criteria][0][description]")).toBe("Clarity");
      expect(body.get("rubric[criteria][0][long_description]")).toBe("How clearly the work communicates its purpose.");
      expect(body.get("rubric[criteria][0][ratings][0][description]")).toBe("Excellent");
      expect(body.get("rubric[criteria][0][ratings][0][points]")).toBe("4");
      expect(body.get("rubric[criteria][0][ratings][3][description]")).toBe("Beginning");
      expect(body.get("rubric[criteria][1][description]")).toBe("Use of Evidence");
      expect(body.get("rubric[criteria][1][ratings][0][long_description]")).toBe("Multiple specific examples.");
      // No association params should be set when associate_with is omitted
      expect(body.get("rubric_association[association_type]")).toBeNull();
    });

    it("includes rubric_association params when associate_with is provided", async () => {
      const { client, requests } = buildMockCanvas([
        {
          status: 200,
          data: {
            rubric: { id: 999, title: "Project Rubric" },
            rubric_association: {
              id: 1234,
              rubric_id: 999,
              association_id: 5555,
              association_type: "Assignment",
              use_for_grading: true,
              hide_score_total: false,
              purpose: "grading",
            },
          },
        },
      ]);
      const harness = buildToolHarness();
      registerRubricTools(harness.server as never, client);
      const result = (await harness.call("create_rubric", {
        course_identifier: 60366,
        title: "Project Rubric",
        criteria: [
          {
            description: "Clarity",
            ratings: [
              { description: "Yes", points: 1 },
              { description: "No", points: 0 },
            ],
          },
        ],
        associate_with: {
          association_type: "Assignment",
          association_id: 5555,
          use_for_grading: true,
        },
      })) as ToolResponse;

      const body = asForm(requests[0]?.data);
      expect(body.get("rubric_association[association_type]")).toBe("Assignment");
      expect(body.get("rubric_association[association_id]")).toBe("5555");
      expect(body.get("rubric_association[use_for_grading]")).toBe("true");
      expect(body.get("rubric_association[purpose]")).toBe("grading");
      const association = parseJsonResult(result).rubric_association as { id: number };
      expect(association?.id).toBe(1234);
    });

    it("defaults use_for_grading to true when association is provided without it", async () => {
      const { client, requests } = buildMockCanvas([
        { status: 200, data: { rubric: { id: 1, title: "x" }, rubric_association: { id: 1, rubric_id: 1, association_id: 1, association_type: "Assignment", use_for_grading: true, hide_score_total: false, purpose: "grading" } } },
      ]);
      const harness = buildToolHarness();
      registerRubricTools(harness.server as never, client);
      await harness.call("create_rubric", {
        course_identifier: 60366,
        title: "x",
        criteria: [{ description: "x", ratings: [{ description: "x", points: 1 }, { description: "y", points: 0 }] }],
        associate_with: { association_type: "Assignment", association_id: 1 },
      });
      const body = asForm(requests[0]?.data);
      expect(body.get("rubric_association[use_for_grading]")).toBe("true");
    });
  });

  describe("create_rubric_association", () => {
    it("POSTs to /rubric_associations with form-encoded rubric_association params", async () => {
      const { client, requests } = buildMockCanvas([
        {
          status: 200,
          data: {
            id: 7777,
            rubric_id: 999,
            association_id: 5555,
            association_type: "Assignment",
            use_for_grading: true,
            hide_score_total: false,
            purpose: "grading",
          },
        },
      ]);
      const harness = buildToolHarness();
      registerRubricTools(harness.server as never, client);
      const result = (await harness.call("create_rubric_association", {
        course_identifier: 60366,
        rubric_id: 999,
        association_type: "Assignment",
        association_id: 5555,
        use_for_grading: true,
      })) as ToolResponse;

      expect(result.isError).toBeFalsy();
      expect(requests[0]?.method).toBe("POST");
      expect(requests[0]?.url).toBe("/api/v1/courses/60366/rubric_associations");
      const body = asForm(requests[0]?.data);
      expect(body.get("rubric_association[rubric_id]")).toBe("999");
      expect(body.get("rubric_association[association_type]")).toBe("Assignment");
      expect(body.get("rubric_association[association_id]")).toBe("5555");
      expect(body.get("rubric_association[use_for_grading]")).toBe("true");
      expect(body.get("rubric_association[purpose]")).toBe("grading");
      const association = parseJsonResult(result).rubric_association as { id: number };
      expect(association?.id).toBe(7777);
    });

    it("supports Quiz and Discussion association types", async () => {
      const { client, requests } = buildMockCanvas([
        { status: 200, data: { id: 1, rubric_id: 999, association_id: 333, association_type: "Quiz", use_for_grading: true, hide_score_total: false, purpose: "grading" } },
        { status: 200, data: { id: 2, rubric_id: 999, association_id: 444, association_type: "Discussion", use_for_grading: true, hide_score_total: false, purpose: "grading" } },
      ]);
      const harness = buildToolHarness();
      registerRubricTools(harness.server as never, client);
      await harness.call("create_rubric_association", { course_identifier: 60366, rubric_id: 999, association_type: "Quiz", association_id: 333 });
      await harness.call("create_rubric_association", { course_identifier: 60366, rubric_id: 999, association_type: "Discussion", association_id: 444 });
      expect(asForm(requests[0]?.data).get("rubric_association[association_type]")).toBe("Quiz");
      expect(asForm(requests[1]?.data).get("rubric_association[association_type]")).toBe("Discussion");
    });
  });
});
