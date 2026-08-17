import { describe, expect, it } from "vitest";

import {
  buildMockCanvas,
  buildToolHarness,
  parseJsonResult,
  type FakeResponse,
  type ToolResponse,
} from "../_helpers/mockCanvas.js";
import { registerQuizTools } from "../../src/tools/quizzes.js";

describe("registerQuizTools", () => {
  it("registers the quiz tool set", () => {
    const { client } = buildMockCanvas([]);
    const harness = buildToolHarness();
    registerQuizTools(harness.server as never, client);
    expect([...harness.tools.keys()].sort()).toEqual([
      "create_quiz",
      "create_quiz_question",
      "delete_quiz_question",
      "get_quiz",
      "list_quizzes",
      "update_quiz",
      "update_quiz_question",
    ]);
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
      time_limit: 45,
      show_correct_answers: false,
    });
    const payload = (requests[0]?.data as { quiz: Record<string, unknown> }).quiz;
    expect(payload).toMatchObject({
      quiz_type: "practice_quiz",
      due_at: "2026-06-01T23:59:00Z",
      points_possible: 25,
      allowed_attempts: 3,
      time_limit: 45,
      show_correct_answers: false,
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

  it("list_quizzes returns the trimmed quiz shape for each item", async () => {
    const { client, requests } = buildMockCanvas([
      {
        status: 200,
        data: [
          {
            id: 999,
            title: "Week 1 Quiz",
            quiz_type: "assignment",
            published: true,
            due_at: "2026-06-01T23:59:00Z",
            points_possible: 10,
            question_count: 4,
            html_url: "https://canvas.example.com/courses/60366/quizzes/999",
            access_code: "secret",
            all_dates: [],
            permissions: { read: true, update: true },
          },
          { id: 1000, title: "Week 2 Quiz", quiz_type: "practice_quiz", published: false },
        ],
      },
    ]);
    const harness = buildToolHarness();
    registerQuizTools(harness.server as never, client);

    const result = (await harness.call("list_quizzes", { course_identifier: 60366 })) as ToolResponse;
    expect(result.isError).toBeFalsy();
    expect(requests[0]?.url).toBe("/api/v1/courses/60366/quizzes");
    const parsed = parseJsonResult<{ course_id: number; count: number; truncated: boolean; quizzes: Record<string, unknown>[] }>(result);
    expect(parsed.course_id).toBe(60366);
    expect(parsed.count).toBe(2);
    expect(parsed.truncated).toBe(false);
    const expectedKeys = ["id", "title", "quiz_type", "published", "due_at", "points_possible", "question_count", "html_url"].sort();
    for (const quiz of parsed.quizzes) {
      expect(Object.keys(quiz).sort()).toEqual(expectedKeys);
    }
    expect(parsed.quizzes[0]).not.toHaveProperty("access_code");
    expect(parsed.quizzes[1]?.question_count).toBeNull();
  });

  it("get_quiz fires quiz + questions requests, trims the quiz to the detail allowlist, and merges the trimmed questions", async () => {
    const { client, requests } = buildMockCanvas([
      {
        status: 200,
        data: {
          id: 999,
          title: "Week 1 Quiz",
          quiz_type: "assignment",
          published: false,
          points_possible: 10,
          question_count: 2,
          shuffle_answers: true,
          time_limit: 30,
          access_code: "secret",
          all_dates: [],
          permissions: { read: true, update: true },
          preview_url: "https://canvas.example.com/courses/60366/quizzes/999/preview",
        },
      },
      {
        status: 200,
        data: [
          {
            id: 12,
            quiz_id: 999,
            position: 1,
            question_name: "Q1",
            question_type: "multiple_choice_question",
            question_text: "1+1?",
            points_possible: 1,
            answers: [{ id: 1, text: "2", weight: 100 }],
            assessment_question_id: 777,
            correct_comments_html: "<p>yes</p>",
          },
          {
            id: 13,
            quiz_id: 999,
            position: 2,
            question_type: "essay_question",
            question_text: "Why?",
            points_possible: 4,
          },
        ],
      },
    ]);
    const harness = buildToolHarness();
    registerQuizTools(harness.server as never, client);

    const result = (await harness.call("get_quiz", { course_identifier: 60366, quiz_id: 999 })) as ToolResponse;
    expect(result.isError).toBeFalsy();
    expect(requests.map((request) => request.url).sort()).toEqual([
      "/api/v1/courses/60366/quizzes/999",
      "/api/v1/courses/60366/quizzes/999/questions",
    ]);
    const parsed = parseJsonResult<{
      quiz: Record<string, unknown>;
      question_count: number;
      question_pages: number;
      questions_truncated: boolean;
      questions: Record<string, unknown>[];
    }>(result);
    expect(Object.keys(parsed.quiz).sort()).toEqual(
      [
        "id",
        "title",
        "quiz_type",
        "published",
        "due_at",
        "points_possible",
        "question_count",
        "html_url",
        "description",
        "shuffle_answers",
        "allowed_attempts",
        "time_limit",
        "show_correct_answers",
        "one_question_at_a_time",
        "hide_results",
        "scoring_policy",
        "access_code",
        "unlock_at",
        "lock_at",
      ].sort(),
    );
    expect(parsed.quiz.shuffle_answers).toBe(true);
    expect(parsed.quiz.time_limit).toBe(30);
    expect(parsed.quiz.access_code).toBe("secret");
    expect(parsed.quiz).not.toHaveProperty("permissions");
    expect(JSON.stringify(parsed.quiz)).not.toContain("preview_url");
    expect(parsed.question_count).toBe(2);
    expect(parsed.question_pages).toBe(1);
    expect(parsed.questions_truncated).toBe(false);
    expect(parsed.questions).toHaveLength(2);
    const expectedQuestionKeys = ["id", "position", "question_name", "question_type", "points_possible", "question_text", "answers"].sort();
    for (const question of parsed.questions) {
      expect(Object.keys(question).sort()).toEqual(expectedQuestionKeys);
    }
    expect(parsed.questions[0]).not.toHaveProperty("assessment_question_id");
    expect(parsed.questions[0]?.answers).toHaveLength(1);
  });

  it("get_quiz propagates a truncated questions walk into questions_truncated/question_pages", async () => {
    const responses: FakeResponse[] = [{ status: 200, data: { id: 999, title: "Big Quiz" } }];
    // mockCanvas caps pagination at maxPages: 10 — every page advertises a next link.
    for (let page = 1; page <= 10; page += 1) {
      responses.push({
        status: 200,
        data: [
          {
            id: page,
            quiz_id: 999,
            position: page,
            question_type: "essay_question",
            question_text: `Q${page}`,
            points_possible: 1,
          },
        ],
        headers: {
          link: `<https://canvas.example.com/api/v1/courses/60366/quizzes/999/questions?page=${page + 1}>; rel="next"`,
        },
      });
    }
    const { client } = buildMockCanvas(responses);
    const harness = buildToolHarness();
    registerQuizTools(harness.server as never, client);

    const result = (await harness.call("get_quiz", { course_identifier: 60366, quiz_id: 999 })) as ToolResponse;
    const parsed = parseJsonResult<{ question_count: number; question_pages: number; questions_truncated: boolean }>(result);
    expect(parsed.questions_truncated).toBe(true);
    expect(parsed.question_pages).toBe(10);
    expect(parsed.question_count).toBe(10);
  });

  it("get_quiz with zero questions returns questions: [] and question_count 0", async () => {
    const { client } = buildMockCanvas([
      { status: 200, data: { id: 999, title: "Empty Quiz", question_count: 0 } },
      { status: 200, data: [] },
    ]);
    const harness = buildToolHarness();
    registerQuizTools(harness.server as never, client);

    const result = (await harness.call("get_quiz", { course_identifier: 60366, quiz_id: 999 })) as ToolResponse;
    const parsed = parseJsonResult<{ question_count: number; questions: unknown[] }>(result);
    expect(parsed.questions).toEqual([]);
    expect(parsed.question_count).toBe(0);
  });

  it("update_quiz PUTs only the provided fields and never sends published", async () => {
    const { client, requests } = buildMockCanvas([
      { status: 200, data: { id: 999, title: "Renamed Quiz", published: true, points_possible: 20 } },
    ]);
    const harness = buildToolHarness();
    registerQuizTools(harness.server as never, client);

    const result = (await harness.call("update_quiz", {
      course_identifier: 60366,
      quiz_id: 999,
      title: "Renamed Quiz",
      points_possible: 20,
    })) as ToolResponse;
    expect(result.isError).toBeFalsy();
    expect(requests[0]?.method).toBe("PUT");
    expect(requests[0]?.url).toBe("/api/v1/courses/60366/quizzes/999");
    const payload = (requests[0]?.data as { quiz: Record<string, unknown> }).quiz;
    expect(payload).toEqual({ title: "Renamed Quiz", points_possible: 20 });
    expect(payload).not.toHaveProperty("published");
  });

  it("update_quiz with zero updatable fields errors without calling Canvas", async () => {
    const { client, requests } = buildMockCanvas([]);
    const harness = buildToolHarness();
    registerQuizTools(harness.server as never, client);

    const result = (await harness.call("update_quiz", {
      course_identifier: 60366,
      quiz_id: 999,
    })) as ToolResponse;
    expect(result.isError).toBe(true);
    expect(result.content?.[0]?.text).toContain("at least one field");
    expect(requests).toHaveLength(0);
  });

  it("update_quiz_question PUTs the nested question payload", async () => {
    const { client, requests } = buildMockCanvas([
      {
        status: 200,
        data: {
          id: 12,
          quiz_id: 999,
          position: 1,
          question_type: "multiple_choice_question",
          question_text: "2+2?",
          points_possible: 2,
        },
      },
    ]);
    const harness = buildToolHarness();
    registerQuizTools(harness.server as never, client);

    const result = (await harness.call("update_quiz_question", {
      course_identifier: 60366,
      quiz_id: 999,
      question_id: 12,
      question: {
        question_text: "2+2?",
        question_type: "multiple_choice_question",
        points_possible: 2,
        answers: [
          { answer_text: "4", answer_weight: 100 },
          { answer_text: "5", answer_weight: 0 },
        ],
      },
    })) as ToolResponse;
    expect(result.isError).toBeFalsy();
    expect(requests[0]?.method).toBe("PUT");
    expect(requests[0]?.url).toBe("/api/v1/courses/60366/quizzes/999/questions/12");
    const payload = (requests[0]?.data as { question: Record<string, unknown> }).question;
    expect(payload.question_text).toBe("2+2?");
    expect(payload.answers).toHaveLength(2);
  });

  it("delete_quiz_question deletes and names the question and quiz in the summary", async () => {
    const { client, requests } = buildMockCanvas([{ status: 204, data: null }]);
    const harness = buildToolHarness();
    registerQuizTools(harness.server as never, client);

    const result = (await harness.call("delete_quiz_question", {
      course_identifier: 60366,
      quiz_id: 999,
      question_id: 12,
    })) as ToolResponse;
    expect(result.isError).toBeFalsy();
    expect(requests[0]?.method).toBe("DELETE");
    expect(requests[0]?.url).toBe("/api/v1/courses/60366/quizzes/999/questions/12");
    expect(result.content?.[0]?.text).toContain("Deleted question 12 from quiz 999");
    const parsed = parseJsonResult<{ deleted_question_id: number }>(result);
    expect(parsed.deleted_question_id).toBe(12);
  });

  it("delete_quiz_question on a missing question surfaces the Canvas 404 with tool context", async () => {
    const { client } = buildMockCanvas([
      { status: 404, data: { errors: [{ message: "The specified resource does not exist." }] } },
    ]);
    const harness = buildToolHarness();
    registerQuizTools(harness.server as never, client);

    const result = (await harness.call("delete_quiz_question", {
      course_identifier: 60366,
      quiz_id: 999,
      question_id: 424242,
    })) as ToolResponse;
    expect(result.isError).toBe(true);
    expect(result.content?.[0]?.text).toContain("delete_quiz_question");
    expect(result.content?.[0]?.text).toContain("404");
    expect(result.content?.[0]?.text).toContain("The specified resource does not exist.");
  });

  it("create → get → update-question → get round-trip shows the edit", async () => {
    const quizShell = { id: 999, title: "Week 1 Quiz", quiz_type: "assignment", published: false, question_count: 1 };
    const originalQuestion = {
      id: 12,
      quiz_id: 999,
      position: 1,
      question_type: "essay_question",
      question_text: "Why?",
      points_possible: 5,
    };
    const editedQuestion = { ...originalQuestion, question_text: "Why does it matter?" };
    const { client } = buildMockCanvas([
      { status: 200, data: quizShell },
      { status: 200, data: quizShell },
      { status: 200, data: [originalQuestion] },
      { status: 200, data: editedQuestion },
      { status: 200, data: quizShell },
      { status: 200, data: [editedQuestion] },
    ]);
    const harness = buildToolHarness();
    registerQuizTools(harness.server as never, client);

    const created = parseJsonResult(
      (await harness.call("create_quiz", { course_identifier: 60366, title: "Week 1 Quiz" })) as ToolResponse,
    );
    expect(created.id).toBe(999);

    const before = parseJsonResult<{ questions: Array<{ question_text: string }> }>(
      (await harness.call("get_quiz", { course_identifier: 60366, quiz_id: 999 })) as ToolResponse,
    );
    expect(before.questions[0]?.question_text).toBe("Why?");

    const updateResult = (await harness.call("update_quiz_question", {
      course_identifier: 60366,
      quiz_id: 999,
      question_id: 12,
      question: { question_text: "Why does it matter?", question_type: "essay_question", points_possible: 5 },
    })) as ToolResponse;
    expect(updateResult.isError).toBeFalsy();

    const after = parseJsonResult<{ questions: Array<{ question_text: string }> }>(
      (await harness.call("get_quiz", { course_identifier: 60366, quiz_id: 999 })) as ToolResponse,
    );
    expect(after.questions[0]?.question_text).toBe("Why does it matter?");
  });
});
