import { describe, expect, it } from "vitest";

import {
  buildMockCanvas,
  buildToolHarness,
  parseJsonResult,
  type ToolResponse,
} from "../_helpers/mockCanvas.js";
import { registerQuizTools } from "../../src/tools/quizzes.js";

type ItemEntry = {
  interaction_type_slug: string;
  item_body: string;
  title?: string;
  interaction_data: Record<string, unknown>;
  scoring_data: Record<string, unknown>;
  scoring_algorithm: string;
  feedback?: Record<string, string>;
  answer_feedback?: Record<string, string>;
};

function itemEntryOf(data: unknown): ItemEntry {
  return (data as { item: { entry: ItemEntry } }).item.entry;
}

describe("registerQuizTools (New Quizzes)", () => {
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

  it("create_quiz posts to /api/quiz/v1, never publishes, maps description→instructions, and returns a constructed html_url", async () => {
    const { client, requests } = buildMockCanvas([
      { status: 200, data: { id: "999", title: "Week 1 Quiz", published: false, points_possible: 10, due_at: null } },
    ]);
    const harness = buildToolHarness();
    registerQuizTools(harness.server as never, client);

    const result = (await harness.call("create_quiz", {
      course_identifier: 60366,
      title: "Week 1 Quiz",
      description: "<p>Read carefully.</p>",
    })) as ToolResponse;
    expect(result.isError).toBeFalsy();
    expect(requests[0]?.method).toBe("POST");
    expect(requests[0]?.url).toBe("/api/quiz/v1/courses/60366/quizzes");
    const payload = (requests[0]?.data as { quiz: Record<string, unknown> }).quiz;
    expect(payload).toMatchObject({ title: "Week 1 Quiz", instructions: "<p>Read carefully.</p>" });
    expect(payload).not.toHaveProperty("published");
    expect(payload).not.toHaveProperty("quiz_type");
    const created = parseJsonResult(result);
    expect(created.id).toBe("999");
    expect(created.html_url).toBe("https://canvas.example.com/courses/60366/assignments/999");
  });

  it("create_quiz maps friendly settings into quiz_settings and ignores quiz_type", async () => {
    const { client, requests } = buildMockCanvas([{ status: 200, data: { id: "1", title: "x" } }]);
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
      shuffle_answers: true,
      show_correct_answers: false,
    });
    const payload = (requests[0]?.data as { quiz: Record<string, unknown> }).quiz;
    expect(payload).not.toHaveProperty("quiz_type");
    expect(payload.due_at).toBe("2026-06-01T23:59:00Z");
    expect(payload.points_possible).toBe(25);
    const settings = payload.quiz_settings as Record<string, unknown>;
    expect(settings.shuffle_answers).toBe(true);
    expect(settings.has_time_limit).toBe(true);
    expect(settings.session_time_limit_in_seconds).toBe(2700);
    expect(settings.multiple_attempts).toMatchObject({
      multiple_attempts_enabled: true,
      attempt_limit: true,
      max_attempts: 3,
    });
    expect(settings.result_view_settings).toMatchObject({
      result_view_restricted: true,
      display_item_correct_answer: false,
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
      { status: 200, data: { id: "999", title: "Week 1 Quiz", published: false } },
    ]);
    await client.resolveCourseId("DSGN_9_120251");
    const harness = buildToolHarness();
    registerQuizTools(harness.server as never, client);
    const result = (await harness.call("create_quiz", {
      course_identifier: "DSGN_9_120251",
      title: "Week 1 Quiz",
    })) as ToolResponse;
    expect(result.isError).toBeFalsy();
    expect(requests.filter((request) => request.url === "/api/v1/courses")).toHaveLength(2);
    expect(requests.at(-1)?.url).toBe("/api/quiz/v1/courses/60366/quizzes");
  });

  it("create_quiz_question wraps a choice item with generated UUIDs and Equivalence scoring", async () => {
    const { client, requests } = buildMockCanvas([{ status: 200, data: { id: "item-12" } }]);
    const harness = buildToolHarness();
    registerQuizTools(harness.server as never, client);

    const result = (await harness.call("create_quiz_question", {
      course_identifier: 60366,
      quiz_id: "999",
      question: {
        question_name: "Q1",
        question_text: "1+1?",
        question_type: "multiple_choice_question",
        points_possible: 1,
        answers: [
          { answer_text: "2", answer_weight: 100 },
          { answer_text: "3", answer_weight: 0 },
        ],
        neutral_comments: "basic arithmetic",
      },
    })) as ToolResponse;
    expect(result.isError).toBeFalsy();
    expect(requests[0]?.method).toBe("POST");
    expect(requests[0]?.url).toBe("/api/quiz/v1/courses/60366/quizzes/999/items");
    const body = requests[0]?.data as { item: { entry_type: string; points_possible: number; entry: ItemEntry } };
    expect(body.item.entry_type).toBe("Item");
    expect(body.item.points_possible).toBe(1);
    const entry = body.item.entry;
    expect(entry.interaction_type_slug).toBe("choice");
    expect(entry.title).toBe("Q1");
    expect(entry.item_body).toBe("<p>1+1?</p>");
    expect(entry.scoring_algorithm).toBe("Equivalence");
    const choices = (entry.interaction_data as { choices: Array<{ id: string; itemBody: string }> }).choices;
    expect(choices).toHaveLength(2);
    expect(choices[0].itemBody).toBe("<p>2</p>");
    // scoring_data.value points at the UUID of the weight-100 answer (the first one).
    expect((entry.scoring_data as { value: string }).value).toBe(choices[0].id);
    expect(entry.feedback?.neutral).toBe("<p>basic arithmetic</p>");
  });

  it("create_quiz_question errors when no multiple-choice answer is marked correct", async () => {
    const { client, requests } = buildMockCanvas([]);
    const harness = buildToolHarness();
    registerQuizTools(harness.server as never, client);
    const result = (await harness.call("create_quiz_question", {
      course_identifier: 60366,
      quiz_id: "999",
      question: {
        question_text: "pick",
        question_type: "multiple_choice_question",
        answers: [
          { answer_text: "a", answer_weight: 0 },
          { answer_text: "b", answer_weight: 0 },
        ],
      },
    })) as ToolResponse;
    expect(result.isError).toBe(true);
    expect(result.content?.[0]?.text).toContain("answer_weight 100");
    expect(requests).toHaveLength(0);
  });

  it("true_false translates to a boolean scoring value", async () => {
    const { client, requests } = buildMockCanvas([{ status: 200, data: { id: "i" } }]);
    const harness = buildToolHarness();
    registerQuizTools(harness.server as never, client);
    await harness.call("create_quiz_question", {
      course_identifier: 60366,
      quiz_id: "999",
      question: {
        question_text: "Water boils at 100C at sea level.",
        question_type: "true_false_question",
        answers: [
          { answer_text: "True", answer_weight: 100 },
          { answer_text: "False", answer_weight: 0 },
        ],
      },
    });
    const entry = itemEntryOf(requests[0]?.data);
    expect(entry.interaction_type_slug).toBe("true-false");
    expect(entry.interaction_data).toMatchObject({ true_choice: "True", false_choice: "False" });
    expect(entry.scoring_data.value).toBe(true);
  });

  it("multiple_answers collects every correct UUID with AllOrNothing scoring", async () => {
    const { client, requests } = buildMockCanvas([{ status: 200, data: { id: "i" } }]);
    const harness = buildToolHarness();
    registerQuizTools(harness.server as never, client);
    await harness.call("create_quiz_question", {
      course_identifier: 60366,
      quiz_id: "999",
      question: {
        question_text: "Select the primary colors.",
        question_type: "multiple_answers_question",
        answers: [
          { answer_text: "red", answer_weight: 100 },
          { answer_text: "green", answer_weight: 0 },
          { answer_text: "blue", answer_weight: 100 },
        ],
      },
    });
    const entry = itemEntryOf(requests[0]?.data);
    expect(entry.interaction_type_slug).toBe("multi-answer");
    expect(entry.scoring_algorithm).toBe("AllOrNothing");
    const choices = (entry.interaction_data as { choices: Array<{ id: string }> }).choices;
    const correct = entry.scoring_data.value as string[];
    expect(correct).toHaveLength(2);
    expect(correct).toEqual([choices[0].id, choices[2].id]);
  });

  it("short_answer maps to a manually-graded essay with the answer key as grader notes", async () => {
    const { client, requests } = buildMockCanvas([{ status: 200, data: { id: "i" } }]);
    const harness = buildToolHarness();
    registerQuizTools(harness.server as never, client);
    await harness.call("create_quiz_question", {
      course_identifier: 60366,
      quiz_id: "999",
      question: {
        question_text: "Name the process.",
        question_type: "short_answer_question",
        answers: [
          { answer_text: "evapotranspiration", answer_weight: 100 },
          { answer_text: "evapo-transpiration", answer_weight: 100 },
        ],
      },
    });
    const entry = itemEntryOf(requests[0]?.data);
    expect(entry.interaction_type_slug).toBe("essay");
    expect(entry.scoring_algorithm).toBe("None");
    expect(entry.scoring_data.value).toBe("Accepted answers: evapotranspiration; evapo-transpiration");
  });

  it("matching builds questions/answers and a prompt→answer scoring map", async () => {
    const { client, requests } = buildMockCanvas([{ status: 200, data: { id: "i" } }]);
    const harness = buildToolHarness();
    registerQuizTools(harness.server as never, client);
    await harness.call("create_quiz_question", {
      course_identifier: 60366,
      quiz_id: "999",
      question: {
        question_text: "Match the pathway to its location.",
        question_type: "matching_question",
        matches: [
          { left: "Glycolysis", right: "Cytoplasm" },
          { left: "Citric Acid Cycle", right: "Mitochondrial Matrix" },
        ],
        distractors: ["Peroxisome"],
      },
    });
    const entry = itemEntryOf(requests[0]?.data);
    expect(entry.interaction_type_slug).toBe("matching");
    expect(entry.scoring_algorithm).toBe("DeepEquals");
    const data = entry.interaction_data as { answers: string[]; questions: Array<{ id: string; item_body: string }> };
    expect(data.answers).toEqual(["Cytoplasm", "Mitochondrial Matrix", "Peroxisome"]);
    expect(data.questions.map((q) => q.item_body)).toEqual(["Glycolysis", "Citric Acid Cycle"]);
    const value = entry.scoring_data.value as Record<string, string>;
    expect(value[data.questions[0].id]).toBe("Cytoplasm");
    expect(value[data.questions[1].id]).toBe("Mitochondrial Matrix");
  });

  it("ordering builds a keyed choices object and an ordered UUID scoring array", async () => {
    const { client, requests } = buildMockCanvas([{ status: 200, data: { id: "i" } }]);
    const harness = buildToolHarness();
    registerQuizTools(harness.server as never, client);
    await harness.call("create_quiz_question", {
      course_identifier: 60366,
      quiz_id: "999",
      question: {
        question_text: "Order the events.",
        question_type: "ordering_question",
        ordering_items: ["First", "Second", "Third"],
        ordering_top_label: "earliest",
      },
    });
    const entry = itemEntryOf(requests[0]?.data);
    expect(entry.interaction_type_slug).toBe("ordering");
    const choices = entry.interaction_data.choices as Record<string, { id: string; item_body: string }>;
    const order = entry.scoring_data.value as string[];
    expect(order).toHaveLength(3);
    expect(order.map((id) => choices[id].item_body)).toEqual(["<p>First</p>", "<p>Second</p>", "<p>Third</p>"]);
    expect((entry as unknown as { properties: Record<string, unknown> }).properties).toMatchObject({
      include_labels: true,
      top_label: "earliest",
    });
  });

  it("create_quiz_question rejects a dropped Classic type (text_only_question)", async () => {
    const { client, requests } = buildMockCanvas([]);
    const harness = buildToolHarness();
    registerQuizTools(harness.server as never, client);
    const result = (await harness.call("create_quiz_question", {
      course_identifier: 60366,
      quiz_id: "999",
      question: { question_text: "divider", question_type: "text_only_question" },
    })) as ToolResponse;
    expect(result.isError).toBe(true);
    expect(result.content?.[0]?.text).toContain("Unsupported question_type");
    expect(requests).toHaveLength(0);
  });

  it("list_quizzes returns the trimmed shape with constructed html_urls", async () => {
    const { client, requests } = buildMockCanvas([
      {
        status: 200,
        data: [
          { id: "999", title: "Week 1 Quiz", published: true, due_at: "2026-06-01T23:59:00Z", points_possible: 10, quiz_settings: { x: 1 } },
          { id: "1000", title: "Week 2 Quiz", published: false },
        ],
      },
    ]);
    const harness = buildToolHarness();
    registerQuizTools(harness.server as never, client);

    const result = (await harness.call("list_quizzes", { course_identifier: 60366 })) as ToolResponse;
    expect(result.isError).toBeFalsy();
    expect(requests[0]?.url).toBe("/api/quiz/v1/courses/60366/quizzes");
    const parsed = parseJsonResult<{ count: number; quizzes: Record<string, unknown>[] }>(result);
    expect(parsed.count).toBe(2);
    const expectedKeys = ["id", "title", "published", "points_possible", "due_at", "html_url"].sort();
    for (const quiz of parsed.quizzes) {
      expect(Object.keys(quiz).sort()).toEqual(expectedKeys);
    }
    expect(parsed.quizzes[0]?.html_url).toBe("https://canvas.example.com/courses/60366/assignments/999");
    expect(parsed.quizzes[0]).not.toHaveProperty("quiz_settings");
  });

  it("get_quiz fires quiz + items requests and trims items to the display allowlist", async () => {
    const { client, requests } = buildMockCanvas([
      {
        status: 200,
        data: { id: "999", title: "Week 1 Quiz", published: false, points_possible: 10, instructions: "<p>go</p>", quiz_settings: { shuffle_answers: true } },
      },
      {
        status: 200,
        data: [
          { id: "item-12", position: 1, points_possible: 1, entry: { interaction_type_slug: "choice", item_body: "<p>1+1?</p>", scoring_algorithm: "Equivalence" } },
          { id: "item-13", position: 2, points_possible: 4, interaction_type_slug: "essay", item_body: "<p>Why?</p>" },
        ],
      },
    ]);
    const harness = buildToolHarness();
    registerQuizTools(harness.server as never, client);

    const result = (await harness.call("get_quiz", { course_identifier: 60366, quiz_id: "999" })) as ToolResponse;
    expect(result.isError).toBeFalsy();
    expect(requests.map((request) => request.url).sort()).toEqual([
      "/api/quiz/v1/courses/60366/quizzes/999",
      "/api/quiz/v1/courses/60366/quizzes/999/items",
    ]);
    const parsed = parseJsonResult<{ quiz: Record<string, unknown>; item_count: number; items: Record<string, unknown>[] }>(result);
    expect(parsed.quiz.html_url).toBe("https://canvas.example.com/courses/60366/assignments/999");
    expect(parsed.quiz.instructions).toBe("<p>go</p>");
    expect(parsed.item_count).toBe(2);
    const expectedItemKeys = ["id", "position", "points_possible", "interaction_type_slug", "item_body"].sort();
    for (const item of parsed.items) {
      expect(Object.keys(item).sort()).toEqual(expectedItemKeys);
    }
    // reads interaction_type_slug from a nested entry AND a flattened item.
    expect(parsed.items[0]?.interaction_type_slug).toBe("choice");
    expect(parsed.items[1]?.interaction_type_slug).toBe("essay");
  });

  it("get_quiz with zero items returns items: [] and item_count 0", async () => {
    const { client } = buildMockCanvas([
      { status: 200, data: { id: "999", title: "Empty Quiz" } },
      { status: 200, data: [] },
    ]);
    const harness = buildToolHarness();
    registerQuizTools(harness.server as never, client);

    const result = (await harness.call("get_quiz", { course_identifier: 60366, quiz_id: "999" })) as ToolResponse;
    const parsed = parseJsonResult<{ item_count: number; items: unknown[] }>(result);
    expect(parsed.items).toEqual([]);
    expect(parsed.item_count).toBe(0);
  });

  it("update_quiz PATCHes only the provided fields and never sends published", async () => {
    const { client, requests } = buildMockCanvas([
      { status: 200, data: { id: "999", title: "Renamed Quiz", published: true, points_possible: 20 } },
    ]);
    const harness = buildToolHarness();
    registerQuizTools(harness.server as never, client);

    const result = (await harness.call("update_quiz", {
      course_identifier: 60366,
      quiz_id: "999",
      title: "Renamed Quiz",
      points_possible: 20,
    })) as ToolResponse;
    expect(result.isError).toBeFalsy();
    expect(requests[0]?.method).toBe("PATCH");
    expect(requests[0]?.url).toBe("/api/quiz/v1/courses/60366/quizzes/999");
    const payload = (requests[0]?.data as { quiz: Record<string, unknown> }).quiz;
    expect(payload).toEqual({ title: "Renamed Quiz", points_possible: 20 });
    expect(payload).not.toHaveProperty("published");
  });

  it("update_quiz with zero updatable fields errors without calling Canvas", async () => {
    const { client, requests } = buildMockCanvas([]);
    const harness = buildToolHarness();
    registerQuizTools(harness.server as never, client);

    const result = (await harness.call("update_quiz", { course_identifier: 60366, quiz_id: "999" })) as ToolResponse;
    expect(result.isError).toBe(true);
    expect(result.content?.[0]?.text).toContain("at least one field");
    expect(requests).toHaveLength(0);
  });

  it("update_quiz_question PATCHes the item route with a rebuilt entry", async () => {
    const { client, requests } = buildMockCanvas([{ status: 200, data: { id: "item-12" } }]);
    const harness = buildToolHarness();
    registerQuizTools(harness.server as never, client);

    const result = (await harness.call("update_quiz_question", {
      course_identifier: 60366,
      quiz_id: "999",
      question_id: "item-12",
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
    expect(requests[0]?.method).toBe("PATCH");
    expect(requests[0]?.url).toBe("/api/quiz/v1/courses/60366/quizzes/999/items/item-12");
    const entry = itemEntryOf(requests[0]?.data);
    expect(entry.interaction_type_slug).toBe("choice");
    expect(entry.item_body).toBe("<p>2+2?</p>");
  });

  it("delete_quiz_question DELETEs the item route and names the item + quiz", async () => {
    const { client, requests } = buildMockCanvas([{ status: 204, data: null }]);
    const harness = buildToolHarness();
    registerQuizTools(harness.server as never, client);

    const result = (await harness.call("delete_quiz_question", {
      course_identifier: 60366,
      quiz_id: "999",
      question_id: "item-12",
    })) as ToolResponse;
    expect(result.isError).toBeFalsy();
    expect(requests[0]?.method).toBe("DELETE");
    expect(requests[0]?.url).toBe("/api/quiz/v1/courses/60366/quizzes/999/items/item-12");
    expect(result.content?.[0]?.text).toContain("Deleted item item-12 from quiz 999");
    const parsed = parseJsonResult<{ deleted_item_id: string }>(result);
    expect(parsed.deleted_item_id).toBe("item-12");
  });

  it("delete_quiz_question on a missing item surfaces the Canvas 404 with tool context", async () => {
    const { client } = buildMockCanvas([
      { status: 404, data: { errors: [{ message: "The specified resource does not exist." }] } },
    ]);
    const harness = buildToolHarness();
    registerQuizTools(harness.server as never, client);

    const result = (await harness.call("delete_quiz_question", {
      course_identifier: 60366,
      quiz_id: "999",
      question_id: "424242",
    })) as ToolResponse;
    expect(result.isError).toBe(true);
    expect(result.content?.[0]?.text).toContain("delete_quiz_question");
    expect(result.content?.[0]?.text).toContain("404");
    expect(result.content?.[0]?.text).toContain("The specified resource does not exist.");
  });

  it("create → get → update-item round-trip targets the New Quizzes routes", async () => {
    const quizShell = { id: "999", title: "Week 1 Quiz", published: false };
    const item = { id: "item-12", position: 1, points_possible: 5, interaction_type_slug: "essay", item_body: "<p>Why?</p>" };
    const { client, requests } = buildMockCanvas([
      { status: 200, data: quizShell },
      { status: 200, data: quizShell },
      { status: 200, data: [item] },
      { status: 200, data: item },
    ]);
    const harness = buildToolHarness();
    registerQuizTools(harness.server as never, client);

    const created = parseJsonResult(
      (await harness.call("create_quiz", { course_identifier: 60366, title: "Week 1 Quiz" })) as ToolResponse,
    );
    expect(created.id).toBe("999");

    const before = parseJsonResult<{ items: Array<{ item_body: string }> }>(
      (await harness.call("get_quiz", { course_identifier: 60366, quiz_id: "999" })) as ToolResponse,
    );
    expect(before.items[0]?.item_body).toBe("<p>Why?</p>");

    const updateResult = (await harness.call("update_quiz_question", {
      course_identifier: 60366,
      quiz_id: "999",
      question_id: "item-12",
      question: { question_text: "Why does it matter?", question_type: "essay_question", points_possible: 5 },
    })) as ToolResponse;
    expect(updateResult.isError).toBeFalsy();
    expect(requests.at(-1)?.url).toBe("/api/quiz/v1/courses/60366/quizzes/999/items/item-12");
  });
});
