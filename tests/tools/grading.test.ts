import { describe, expect, it } from "vitest";

import { buildMockCanvas, buildToolHarness, parseJsonResult, type ToolResponse } from "../_helpers/mockCanvas.js";
import { registerGradingTools } from "../../src/tools/grading.js";

function asForm(data: unknown): URLSearchParams {
  if (data instanceof URLSearchParams) return data;
  if (typeof data === "string") return new URLSearchParams(data);
  throw new Error(`grading test: expected URLSearchParams, got ${typeof data}`);
}

describe("registerGradingTools", () => {
  it("registers all four grading tools", () => {
    const { client } = buildMockCanvas([]);
    const harness = buildToolHarness();
    registerGradingTools(harness.server as never, client);
    expect([...harness.tools.keys()].sort()).toEqual([
      "bulk_grade_submissions",
      "grade_submission",
      "grade_submission_with_rubric",
      "grade_with_rubric",
    ]);
  });

  describe("grade_submission", () => {
    it("PUTs form-encoded submission[posted_grade]", async () => {
      const { client, requests } = buildMockCanvas([
        { status: 200, data: { id: 1, user_id: 1001, assignment_id: 999, grade: "85", score: 85 } },
      ]);
      const harness = buildToolHarness();
      registerGradingTools(harness.server as never, client);
      const result = (await harness.call("grade_submission", {
        course_identifier: 60366,
        assignment_id: 999,
        user_id: 1001,
        posted_grade: 85,
      })) as ToolResponse;
      expect(result.isError).toBeFalsy();
      expect(requests[0]?.method).toBe("PUT");
      expect(requests[0]?.url).toBe("/api/v1/courses/60366/assignments/999/submissions/1001");
      const body = asForm(requests[0]?.data);
      expect(body.get("submission[posted_grade]")).toBe("85");
    });

    it("includes comment when provided", async () => {
      const { client, requests } = buildMockCanvas([{ status: 200, data: {} }]);
      const harness = buildToolHarness();
      registerGradingTools(harness.server as never, client);
      await harness.call("grade_submission", {
        course_identifier: 60366,
        assignment_id: 999,
        user_id: 1001,
        posted_grade: "B+",
        comment: "Solid work.",
      });
      const body = asForm(requests[0]?.data);
      expect(body.get("submission[posted_grade]")).toBe("B+");
      expect(body.get("comment[text_comment]")).toBe("Solid work.");
    });
  });

  describe("grade_with_rubric", () => {
    it("emits one form key per criterion with bracketed nesting", async () => {
      const { client, requests } = buildMockCanvas([{ status: 200, data: {} }]);
      const harness = buildToolHarness();
      registerGradingTools(harness.server as never, client);
      await harness.call("grade_with_rubric", {
        course_identifier: 60366,
        assignment_id: 999,
        user_id: 1001,
        rubric_assessment: {
          _8027: { points: 4, comments: "Strong" },
          _8028: { points: 3, rating_id: "abc" },
        },
        comment: "Great effort.",
      });
      const body = asForm(requests[0]?.data);
      expect(body.get("rubric_assessment[_8027][points]")).toBe("4");
      expect(body.get("rubric_assessment[_8027][comments]")).toBe("Strong");
      expect(body.get("rubric_assessment[_8028][points]")).toBe("3");
      expect(body.get("rubric_assessment[_8028][rating_id]")).toBe("abc");
      expect(body.get("comment[text_comment]")).toBe("Great effort.");
      // No posted_grade should be sent for the rubric-only tool.
      expect(body.get("submission[posted_grade]")).toBeNull();
    });

    it("rejects non-numeric criterion points before any HTTP call", async () => {
      const { client, requests } = buildMockCanvas([]);
      const harness = buildToolHarness();
      registerGradingTools(harness.server as never, client);
      const result = (await harness.call("grade_with_rubric", {
        course_identifier: 60366,
        assignment_id: 999,
        user_id: 1001,
        rubric_assessment: {
          _8027: { points: -1 as unknown as number },
        },
      })) as ToolResponse;
      expect(result.isError).toBe(true);
      expect(result.content?.[0]?.text).toMatch(/cannot be negative/);
      expect(requests).toHaveLength(0);
    });
  });

  describe("grade_submission_with_rubric", () => {
    it("combines posted_grade + rubric_assessment + comment in one PUT", async () => {
      const { client, requests } = buildMockCanvas([{ status: 200, data: {} }]);
      const harness = buildToolHarness();
      registerGradingTools(harness.server as never, client);
      await harness.call("grade_submission_with_rubric", {
        course_identifier: 60366,
        assignment_id: 999,
        user_id: 1001,
        posted_grade: 88,
        rubric_assessment: { _8027: { points: 4 } },
        comment: "Combined.",
      });
      const body = asForm(requests[0]?.data);
      expect(body.get("submission[posted_grade]")).toBe("88");
      expect(body.get("rubric_assessment[_8027][points]")).toBe("4");
      expect(body.get("comment[text_comment]")).toBe("Combined.");
    });

    it("errors when payload would be empty", async () => {
      const { client, requests } = buildMockCanvas([]);
      const harness = buildToolHarness();
      registerGradingTools(harness.server as never, client);
      const result = (await harness.call("grade_submission_with_rubric", {
        course_identifier: 60366,
        assignment_id: 999,
        user_id: 1001,
      })) as ToolResponse;
      expect(result.isError).toBe(true);
      expect(requests).toHaveLength(0);
    });
  });

  describe("bulk_grade_submissions", () => {
    it("grades each user, returns per-user written results", async () => {
      const { client, requests } = buildMockCanvas([
        // Phase 1 — submissions list
        {
          status: 200,
          data: [
            { id: 1, user_id: 1001 },
            { id: 2, user_id: 1002 },
            { id: 3, user_id: 1003 },
          ],
        },
        // Phase 2 — three writes (order not guaranteed, but for max_concurrent=5 they queue together)
        { status: 200, data: { id: 1, user_id: 1001, grade: "85" } },
        { status: 200, data: { id: 2, user_id: 1002, grade: "90" } },
        { status: 200, data: { id: 3, user_id: 1003, grade: "B" } },
      ]);
      const harness = buildToolHarness();
      registerGradingTools(harness.server as never, client);
      const result = (await harness.call("bulk_grade_submissions", {
        course_identifier: 60366,
        assignment_id: 999,
        grades: {
          "1001": { posted_grade: 85 },
          "1002": { posted_grade: 90 },
          "1003": { posted_grade: "B" },
        },
        rate_limit_delay: 0,
      })) as ToolResponse;
      expect(result.isError).toBeFalsy();
      expect(parseJsonResult(result).graded).toBe(3);
      expect(parseJsonResult(result).failed).toBe(0);
      expect(parseJsonResult(result).skipped).toBe(0);
      expect(requests).toHaveLength(4); // 1 list + 3 writes
      const written = parseJsonResult(result).written as Array<{ user_id: string }>;
      expect(written.map((entry) => entry.user_id).sort()).toEqual(["1001", "1002", "1003"]);
    });

    it("returns skipped[] for user_ids without a current submission", async () => {
      const { client } = buildMockCanvas([
        // submission list (only 1001 has submitted)
        { status: 200, data: [{ id: 1, user_id: 1001 }] },
        // single write for 1001
        { status: 200, data: { id: 1, user_id: 1001, grade: "85" } },
      ]);
      const harness = buildToolHarness();
      registerGradingTools(harness.server as never, client);
      const result = (await harness.call("bulk_grade_submissions", {
        course_identifier: 60366,
        assignment_id: 999,
        grades: {
          "1001": { posted_grade: 85 },
          "1002": { posted_grade: 90 }, // never submitted
        },
        rate_limit_delay: 0,
      })) as ToolResponse;
      expect(parseJsonResult(result).graded).toBe(1);
      expect(parseJsonResult(result).skipped).toBe(1);
      const skipped = parseJsonResult(result).skipped_results as Array<{ user_id: string; reason: string }>;
      expect(skipped[0]?.user_id).toBe("1002");
      expect(skipped[0]?.reason).toMatch(/no current submission/);
    });

    it("with dry_run=true returns would-be payloads without PUTting", async () => {
      const { client, requests } = buildMockCanvas([
        // submission list
        { status: 200, data: [{ id: 1, user_id: 1001 }, { id: 2, user_id: 1002 }] },
        // NO write responses queued — would fail if any PUT actually fires
      ]);
      const harness = buildToolHarness();
      registerGradingTools(harness.server as never, client);
      const result = (await harness.call("bulk_grade_submissions", {
        course_identifier: 60366,
        assignment_id: 999,
        grades: {
          "1001": { posted_grade: 85, comment: "Solid" },
          "1002": { rubric_assessment: { _8027: { points: 4 } } },
        },
        dry_run: true,
        rate_limit_delay: 0,
      })) as ToolResponse;
      expect(parseJsonResult(result).dry_run).toBe(true);
      expect(parseJsonResult(result).graded).toBe(2);
      expect(requests).toHaveLength(1); // only the submission-list fetch
      const payloads = parseJsonResult(result).dry_run_payloads as Array<{
        user_id: string;
        payload: Record<string, string>;
      }>;
      expect(payloads).toHaveLength(2);
      const for1001 = payloads.find((entry) => entry.user_id === "1001");
      expect(for1001?.payload["submission[posted_grade]"]).toBe("85");
      expect(for1001?.payload["comment[text_comment]"]).toBe("Solid");
      const for1002 = payloads.find((entry) => entry.user_id === "1002");
      expect(for1002?.payload["rubric_assessment[_8027][points]"]).toBe("4");
    });

    it("returns partial results when one write fails — does not throw", async () => {
      const { client } = buildMockCanvas([
        { status: 200, data: [{ id: 1, user_id: 1001 }, { id: 2, user_id: 1002 }] },
        { status: 200, data: { id: 1, user_id: 1001 } },
        { status: 422, data: { errors: [{ message: "Invalid posted_grade" }] } },
      ]);
      const harness = buildToolHarness();
      registerGradingTools(harness.server as never, client);
      const result = (await harness.call("bulk_grade_submissions", {
        course_identifier: 60366,
        assignment_id: 999,
        grades: {
          "1001": { posted_grade: 85 },
          "1002": { posted_grade: "not-a-grade" },
        },
        rate_limit_delay: 0,
        max_concurrent: 2,
      })) as ToolResponse;
      expect(result.isError).toBeFalsy();
      expect(parseJsonResult(result).graded).toBe(1);
      expect(parseJsonResult(result).failed).toBe(1);
      const failed = parseJsonResult(result).failed_results as Array<{ user_id: string; error: string }>;
      expect(failed[0]?.user_id).toBe("1002");
      expect(failed[0]?.error).toMatch(/Invalid posted_grade|422/);
    });

    it("on 429 mid-flight: stops the next batch and reports unprocessed user_ids", async () => {
      const { client } = buildMockCanvas([
        // submission list
        {
          status: 200,
          data: [
            { id: 1, user_id: 1001 },
            { id: 2, user_id: 1002 },
            { id: 3, user_id: 1003 },
            { id: 4, user_id: 1004 },
          ],
        },
        // batch 1 (concurrent=2): one OK, one 429
        { status: 200, data: { id: 1, user_id: 1001 } },
        { status: 429, headers: { "retry-after": "60" }, data: { errors: ["rate limited"] } },
        // batch 2 should NEVER fire
      ]);
      const harness = buildToolHarness();
      registerGradingTools(harness.server as never, client);
      const result = (await harness.call("bulk_grade_submissions", {
        course_identifier: 60366,
        assignment_id: 999,
        grades: {
          "1001": { posted_grade: 85 },
          "1002": { posted_grade: 90 },
          "1003": { posted_grade: 80 },
          "1004": { posted_grade: 75 },
        },
        max_concurrent: 2,
        rate_limit_delay: 0,
      })) as ToolResponse;
      expect(parseJsonResult(result).graded).toBe(1);
      expect(parseJsonResult(result).failed).toBe(1);
      const unprocessed = parseJsonResult(result).unprocessed_user_ids as string[];
      expect(unprocessed.sort()).toEqual(["1003", "1004"]);
    });
  });
});
