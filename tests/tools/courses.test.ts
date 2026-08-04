import { afterEach, describe, expect, it } from "vitest";

import { buildMockCanvas, buildToolHarness, parseJsonResult, type ToolResponse } from "../_helpers/mockCanvas.js";
import { jsonResult } from "../../src/tools/toolHelpers.js";
import { registerCourseTools } from "../../src/tools/courses.js";

describe("jsonResult", () => {
  it("emits summary + compact JSON as the only representation", () => {
    const result = jsonResult({ a: 1, nested: { b: 2 } }, { summary: "S" });
    expect(result.content).toEqual([{ type: "text", text: 'S\n\n{"a":1,"nested":{"b":2}}' }]);
    expect(Object.keys(result)).toEqual(["content"]);
  });

  it("emits compact JSON alone when no summary is given", () => {
    const result = jsonResult({ a: 1 });
    expect(result.content?.[0]?.text).toBe('{"a":1}');
    expect(Object.keys(result)).toEqual(["content"]);
  });

  it("stringifies non-object payloads without wrapper objects", () => {
    expect(jsonResult([1, 2]).content?.[0]?.text).toBe("[1,2]");
    expect(jsonResult("plain").content?.[0]?.text).toBe('"plain"');
  });
});

describe("parseJsonResult", () => {
  it("parses the payload after the summary line", () => {
    const parsed = parseJsonResult(jsonResult({ count: 2 }, { summary: "2 course(s) found." }));
    expect(parsed).toEqual({ count: 2 });
  });

  it("parses a summary-less payload", () => {
    expect(parseJsonResult(jsonResult([1, 2]))).toEqual([1, 2]);
  });

  it("throws on error results instead of parsing them", () => {
    expect(() =>
      parseJsonResult({ content: [{ type: "text", text: "boom" }], isError: true }),
    ).toThrow(/error result/);
  });
});

describe("registerCourseTools", () => {
  it("registers list_courses, list_account_courses, and get_course_details", () => {
    const { client } = buildMockCanvas([]);
    const harness = buildToolHarness();
    registerCourseTools(harness.server as never, client);
    expect([...harness.tools.keys()].sort()).toEqual([
      "get_course_details",
      "list_account_courses",
      "list_courses",
    ]);
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
      expect(parseJsonResult(result).count).toBe(2);
      const courses = parseJsonResult(result).courses as Array<{ course_code: string; id: number }>;
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
      expect(parseJsonResult(result).course_code).toBe("DSGN_9_120251");
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

  describe("list_account_courses", () => {
    const previousEnv = process.env.CANVAS_ACCOUNT_ID;
    afterEach(() => {
      if (previousEnv === undefined) delete process.env.CANVAS_ACCOUNT_ID;
      else process.env.CANVAS_ACCOUNT_ID = previousEnv;
    });

    it("threads search_term, state[], and include[] to the account-courses endpoint", async () => {
      const { client, requests } = buildMockCanvas([
        {
          status: 200,
          data: [
            { id: 881, name: "Creative Learning Studio", course_code: "DES 325", workflow_state: "available", term: { name: "Spring 2026" } },
            { id: 902, name: "Studio Art I", course_code: "ART 121", workflow_state: "available", term: { name: "Spring 2026" } },
          ],
        },
      ]);
      const harness = buildToolHarness();
      registerCourseTools(harness.server as never, client);

      const result = (await harness.call("list_account_courses", {
        account_id: 1,
        search_term: "studio",
        state: ["available"],
        include: ["term", "total_students"],
      })) as ToolResponse;
      expect(result.isError).toBeFalsy();
      expect(requests[0]?.url).toBe("/api/v1/accounts/1/courses");
      expect(requests[0]?.params).toMatchObject({
        search_term: "studio",
        "state[]": ["available"],
        "include[]": ["term", "total_students"],
      });
      const courses = parseJsonResult(result).courses as Array<{ course_code: string; name: string }>;
      expect(courses).toHaveLength(2);
      expect(courses.map((course) => course.course_code).sort()).toEqual(["ART 121", "DES 325"]);
    });

    it("defaults account_id from CANVAS_ACCOUNT_ID env var when not passed", async () => {
      process.env.CANVAS_ACCOUNT_ID = "self";
      const { client, requests } = buildMockCanvas([{ status: 200, data: [] }]);
      const harness = buildToolHarness();
      registerCourseTools(harness.server as never, client);
      const result = (await harness.call("list_account_courses", {
        search_term: "art",
      })) as ToolResponse;
      expect(result.isError).toBeFalsy();
      expect(requests[0]?.url).toBe("/api/v1/accounts/self/courses");
      expect(parseJsonResult(result).account_id).toBe("self");
    });

    it("errors clearly when account_id is missing and no env var is set", async () => {
      delete process.env.CANVAS_ACCOUNT_ID;
      const { client } = buildMockCanvas([]);
      const harness = buildToolHarness();
      registerCourseTools(harness.server as never, client);
      const result = (await harness.call("list_account_courses", { search_term: "art" })) as ToolResponse;
      expect(result.isError).toBe(true);
      expect(result.content?.[0]?.text).toMatch(/CANVAS_ACCOUNT_ID/);
    });

    it("surfaces a clean scope-required error on 403", async () => {
      const { client } = buildMockCanvas([
        { status: 403, data: { errors: [{ message: "Insufficient permissions" }] } },
      ]);
      const harness = buildToolHarness();
      registerCourseTools(harness.server as never, client);
      const result = (await harness.call("list_account_courses", { account_id: 1 })) as ToolResponse;
      expect(result.isError).toBe(true);
      expect(result.content?.[0]?.text).toMatch(/account-admin scope/);
    });
  });
});
