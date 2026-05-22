import { describe, expect, it } from "vitest";

import { buildMockCanvas, buildToolHarness } from "../_helpers/mockCanvas.js";
import { registerQuizTools } from "../../src/tools/quizzes.js";

interface ToolResponse {
  content?: Array<{ type: string; text: string }>;
  isError?: boolean;
  structuredContent?: Record<string, unknown>;
}

describe("registerQuizTools", () => {
  it("registers create_quiz and create_quiz_question", () => {
    const { client } = buildMockCanvas([]);
    const harness = buildToolHarness();
    registerQuizTools(harness.server as never, client);
    expect([...harness.tools.keys()].sort()).toEqual(["create_quiz", "create_quiz_question"]);
  });

  it("create_quiz forces published:false and defaults quiz_type to assignment", async () => {
    const { client, requests } = buildMockCanvas([
      { status: 200, data: { id: 999, title: "Week 1 Quiz", quiz_type: "assignment", published: false } },
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
