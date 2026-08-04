import { describe, expect, it } from "vitest";

import { buildMockCanvas, buildToolHarness, parseJsonResult, type ToolResponse } from "../_helpers/mockCanvas.js";
import { registerQuizTools } from "../../src/tools/quizzes.js";

describe("registerQuizTools", () => {
  it("registers create_quiz and create_quiz_question", () => {
    const { client } = buildMockCanvas([]);
    const harness = buildToolHarness();
    registerQuizTools(harness.server as never, client);
    expect([...harness.tools.keys()].sort()).toEqual(["create_quiz", "create_quiz_question"]);
  });

  it("create_quiz forces published:false, defaults quiz_type to assignment, and returns the trimmed quiz shape", async () => {
    const { client, requests } = buildMockCanvas([
      {
        status: 200,
        data: {
          id: 999,
          title: "Week 1 Quiz",
          quiz_type: "assignment",
          published: false,
          due_at: null,
          points_possible: 10,
          question_count: 0,
          html_url: "https://canvas.example.com/courses/60366/quizzes/999",
          access_code: null,
          all_dates: [],
          permissions: { read: true, update: true },
        },
      },
    ]);
    const harness = buildToolHarness();
    registerQuizTools(harness.server as never, client);

    const result = (await harness.call("create_quiz", {
      course_identifier: 60366,
      title: "Week 1 Quiz",
    })) as ToolResponse;
    expect(result.isError).toBeFalsy();
    expect(requests[0]?.url).toBe("/api/v1/courses/60366/quizzes");
    const payload = (requests[0]?.data as { quiz: Record<string, unknown> }).quiz;
    expect(payload).toMatchObject({
      title: "Week 1 Quiz",
      quiz_type: "assignment",
      published: false,
    });
    const created = parseJsonResult(result);
    expect(Object.keys(created).sort()).toEqual(
      ["id", "title", "quiz_type", "published", "due_at", "points_possible", "question_count", "html_url"].sort(),
    );
    expect(created.published).toBe(false);
    expect(created).not.toHaveProperty("permissions");
  });

  it("create_quiz threads optional fields through to Canvas", async () => {
    const { client, requests } = buildMockCanvas([{ status: 200, data: { id: 1, title: "x" } }]);
    const harness = buildToolHarness();
    registerQuizTools(harness.server as never, client);
    await harness.call("create_quiz", {
      course_identifier: 60366,
      title: "Practice",
      quiz_type: "practice_quiz",
      due_at: "2026-06-01T23:59:00Z",
      points_possible: 25,
      allowed_attempts: 3,
    });
    const payload = (requests[0]?.data as { quiz: Record<string, unknown> }).quiz;
    expect(payload).toMatchObject({
      quiz_type: "practice_quiz",
      due_at: "2026-06-01T23:59:00Z",
      points_possible: 25,
      allowed_attempts: 3,
      published: false,
    });
  });

  it("create_quiz re-resolves a cached course code instead of trusting the cache (bypassCache)", async () => {
    const enrollmentListResponse = {
      status: 200,
      data: [{ id: 60366, course_code: "DSGN_9_120251", name: "Design 9", workflow_state: "available", term: { name: "Fall 2025" } }],
    };
    const { client, requests } = buildMockCanvas([
      enrollmentListResponse,
      enrollmentListResponse,
      { status: 200, data: { id: 999, title: "Week 1 Quiz", published: false } },
    ]);
    await client.resolveCourseId("DSGN_9_120251"); // warm the cache
    const harness = buildToolHarness();
    registerQuizTools(harness.server as never, client);
    const result = (await harness.call("create_quiz", {
      course_identifier: "DSGN_9_120251",
      title: "Week 1 Quiz",
    })) as ToolResponse;
    expect(result.isError).toBeFalsy();
    expect(requests.filter((request) => request.url === "/api/v1/courses")).toHaveLength(2);
    expect(requests.at(-1)?.url).toBe("/api/v1/courses/60366/quizzes");
  });

  it("create_quiz_question re-resolves a cached course code instead of trusting the cache (bypassCache)", async () => {
    const enrollmentListResponse = {
      status: 200,
      data: [{ id: 60366, course_code: "DSGN_9_120251", name: "Design 9", workflow_state: "available", term: { name: "Fall 2025" } }],
    };
    const { client, requests } = buildMockCanvas([
      enrollmentListResponse,
      enrollmentListResponse,
      { status: 200, data: { id: 12, quiz_id: 999, position: 1, question_type: "essay_question", question_text: "Why?", points_possible: 5 } },
    ]);
    await client.resolveCourseId("DSGN_9_120251");
    const harness = buildToolHarness();
    registerQuizTools(harness.server as never, client);
    const result = (await harness.call("create_quiz_question", {
      course_identifier: "DSGN_9_120251",
      quiz_id: 999,
      question: { question_text: "Why?", question_type: "essay_question", points_possible: 5 },
    })) as ToolResponse;
    expect(result.isError).toBeFalsy();
    expect(requests.filter((request) => request.url === "/api/v1/courses")).toHaveLength(2);
    expect(requests.at(-1)?.url).toBe("/api/v1/courses/60366/quizzes/999/questions");
  });

  it("create_quiz_question posts the wrapped question payload for multiple_choice", async () => {
    const { client, requests } = buildMockCanvas([
      {
        status: 200,
        data: {
          id: 12,
          quiz_id: 999,
          position: 1,
          question_type: "multiple_choice_question",
          question_text: "1+1?",
          points_possible: 1,
        },
      },
    ]);
    const harness = buildToolHarness();
    registerQuizTools(harness.server as never, client);

    const result = (await harness.call("create_quiz_question", {
      course_identifier: 60366,
      quiz_id: 999,
      question: {
        question_text: "1+1?",
        question_type: "multiple_choice_question",
        points_possible: 1,
        answers: [
          { answer_text: "2", answer_weight: 100 },
          { answer_text: "3", answer_weight: 0 },
        ],
      },
    })) as ToolResponse;
    expect(result.isError).toBeFalsy();
    expect(requests[0]?.url).toBe("/api/v1/courses/60366/quizzes/999/questions");
    const payload = (requests[0]?.data as { question: { answers: unknown[] } }).question;
    expect(payload.answers).toHaveLength(2);
  });
});
