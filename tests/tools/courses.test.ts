import { describe, expect, it } from "vitest";

import { buildMockCanvas, buildToolHarness } from "../_helpers/mockCanvas.js";
import { registerCourseTools } from "../../src/tools/courses.js";

interface ToolResponse {
  content?: Array<{ type: string; text: string }>;
  isError?: boolean;
  structuredContent?: Record<string, unknown>;
}

describe("registerCourseTools", () => {
  it("registers list_courses and get_course_details", () => {
    const { client } = buildMockCanvas([]);
    const harness = buildToolHarness();
    registerCourseTools(harness.server as never, client);
    expect([...harness.tools.keys()].sort()).toEqual(["get_course_details", "list_courses"]);
  });

  describe("list_courses", () => {
    it("returns formatted course list with course_code in summary", async () => {
      const { client, requests } = buildMockCanvas([
        {
          status: 200,
          data: [
            {
              id: 60366,
              name: "Design 9",
              course_code: "DSGN_9_120251",
              workflow_state: "available",
              term: { name: "Fall 2025" },
            },
            {
              id: 60367,
              name: "Computing 10",
              course_code: "CMP_10_120251",
              workflow_state: "available",
              term: { name: "Fall 2025" },
            },
          ],
        },
      ]);
      const harness = buildToolHarness();
      registerCourseTools(harness.server as never, client);

      const result = (await harness.call("list_courses")) as ToolResponse;
      expect(result.isError).toBeFalsy();
      expect(result.structuredContent?.count).toBe(2);
      const courses = result.structuredContent?.courses as Array<{ course_code: string; id: number }>;
      expect(courses).toHaveLength(2);
      expect(courses[0]?.course_code).toBe("DSGN_9_120251");
      expect(courses[0]?.id).toBe(60366);
      expect(requests[0]?.params).toMatchObject({ enrollment_state: "active" });
    });

    it("threads enrollment_state and include[] through to Canvas", async () => {
      const { client, requests } = buildMockCanvas([{ status: 200, data: [] }]);
      const harness = buildToolHarness();
      registerCourseTools(harness.server as never, client);
      await harness.call("list_courses", { enrollment_state: "completed", include: ["term"] });
      expect(requests[0]?.params).toMatchObject({
        enrollment_state: "completed",
        "include[]": ["term"],
      });
    });
  });

  describe("get_course_details", () => {
    it("accepts a numeric id and returns details", async () => {
      const { client, requests } = buildMockCanvas([
        {
          status: 200,
          data: {
            id: 60366,
            name: "Design 9",
            course_code: "DSGN_9_120251",
            workflow_state: "available",
            term: { name: "Fall 2025" },
          },
        },
      ]);
      const harness = buildToolHarness();
      registerCourseTools(harness.server as never, client);

      const result = (await harness.call("get_course_details", { course_identifier: 60366 })) as ToolResponse;
      expect(result.isError).toBeFalsy();
      expect(result.structuredContent?.course_code).toBe("DSGN_9_120251");
      expect(requests[0]?.url).toBe("/api/v1/courses/60366");
    });

    it("resolves a course code via search_term then fetches the course", async () => {
      const { client, requests } = buildMockCanvas([
        {
          status: 200,
          data: [{ id: 60366, course_code: "DSGN_9_120251", name: "Design 9" }],
        },
        {
          status: 200,
          data: { id: 60366, course_code: "DSGN_9_120251", name: "Design 9" },
        },
      ]);
      const harness = buildToolHarness();
      registerCourseTools(harness.server as never, client);

      const result = (await harness.call("get_course_details", {
        course_identifier: "DSGN_9_120251",
      })) as ToolResponse;
      expect(result.isError).toBeFalsy();
      expect(requests).toHaveLength(2);
      expect(requests[0]?.params).toMatchObject({ search_term: "DSGN_9_120251" });
      expect(requests[1]?.url).toBe("/api/v1/courses/60366");
    });

    it("returns a structured error result on Canvas 404 (no exception thrown)", async () => {
      const { client } = buildMockCanvas([
        // resolveCourseId via search_term returns no matches → NOT_FOUND
        { status: 200, data: [] },
      ]);
      const harness = buildToolHarness();
      registerCourseTools(harness.server as never, client);
      const result = (await harness.call("get_course_details", {
        course_identifier: "MISSING",
      })) as ToolResponse;
      expect(result.isError).toBe(true);
      expect(result.content?.[0]?.text).toMatch(/no Canvas course matches/);
    });
  });
});
