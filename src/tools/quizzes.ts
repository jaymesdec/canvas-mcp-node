import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import type { CanvasClient } from "../canvasClient.js";
import { deriveCourseUrl, jsonResult, pickFields, safeHandler } from "./toolHelpers.js";

// This file targets Canvas *New Quizzes* (the /api/quiz/v1 microservice), NOT
// Classic Quizzes. The tool names and input schemas are deliberately kept
// identical to the old Classic tools so the teaching-AIssitant skills need no
// parameter renames — the Classic→New translation happens entirely in here.
// A New Quiz's `id` IS the Canvas assignment id; every item route hangs off it.

const CREATE_QUIZ_INPUT = {
  course_identifier: z.union([z.string(), z.number()]),
  title: z.string(),
  description: z.string().optional().describe("Quiz instructions/intro (rich HTML ok)."),
  quiz_type: z
    .enum(["practice_quiz", "assignment", "graded_survey", "survey"])
    .optional()
    .describe("Accepted for Classic-tool compatibility but ignored — New Quizzes has no quiz_type."),
  due_at: z.string().optional().describe("ISO-8601 due date (e.g., '2026-06-01T23:59:00Z')."),
  points_possible: z.number().optional(),
  shuffle_answers: z.boolean().optional(),
  shuffle_questions: z.boolean().optional(),
  allowed_attempts: z
    .number()
    .int()
    .optional()
    .describe("1 = single attempt (default), -1 = unlimited, n>1 = n attempts."),
  time_limit: z.number().int().optional().describe("Time limit in minutes. Omit for no limit."),
  show_correct_answers: z
    .boolean()
    .optional()
    .describe("Whether students see correct answers after submitting. New Quizzes defaults to showing them."),
};

const QUESTION_ANSWER_SCHEMA = z.object({
  answer_text: z.string().optional(),
  answer_html: z.string().optional(),
  answer_weight: z.number().optional().describe("100 for correct, 0 for incorrect."),
  answer_comments: z.string().optional().describe("Per-answer feedback (multiple choice only)."),
});

const MATCH_PAIR_SCHEMA = z.object({
  left: z.string().describe("The prompt shown to the student."),
  right: z.string().describe("The correct match for this prompt."),
});

const QUESTION_PAYLOAD_SCHEMA = z.object({
  question_name: z.string().optional(),
  question_text: z.string(),
  question_type: z.enum([
    "multiple_choice_question",
    "true_false_question",
    "multiple_answers_question",
    "short_answer_question",
    "essay_question",
    "matching_question",
    "ordering_question",
  ]),
  points_possible: z.number().optional(),
  correct_comments: z.string().optional(),
  incorrect_comments: z.string().optional(),
  neutral_comments: z.string().optional(),
  answers: z.array(QUESTION_ANSWER_SCHEMA).optional(),
  matches: z
    .array(MATCH_PAIR_SCHEMA)
    .optional()
    .describe("matching_question only: prompt→answer pairs."),
  distractors: z
    .array(z.string())
    .optional()
    .describe("matching_question only: extra wrong answer options with no matching prompt."),
  ordering_items: z
    .array(z.string())
    .optional()
    .describe("ordering_question only: items in their correct order."),
  ordering_top_label: z.string().optional().describe("ordering_question only: label above the list."),
  ordering_bottom_label: z.string().optional().describe("ordering_question only: label below the list."),
});

type QuestionPayload = z.infer<typeof QUESTION_PAYLOAD_SCHEMA>;

const CREATE_QUIZ_QUESTION_INPUT = {
  course_identifier: z.union([z.string(), z.number()]),
  quiz_id: z
    .union([z.string(), z.number()])
    .describe("The New Quiz's id (the Canvas assignment id returned by create_quiz)."),
  question: QUESTION_PAYLOAD_SCHEMA,
};

const LIST_QUIZZES_INPUT = {
  course_identifier: z.union([z.string(), z.number()]),
};

const GET_QUIZ_INPUT = {
  course_identifier: z.union([z.string(), z.number()]),
  quiz_id: z.union([z.string(), z.number()]).describe("The New Quiz's id (Canvas assignment id)."),
};

const UPDATE_QUIZ_INPUT = {
  course_identifier: z.union([z.string(), z.number()]),
  quiz_id: z.union([z.string(), z.number()]).describe("The New Quiz's id (Canvas assignment id)."),
  title: z.string().optional(),
  description: z.string().optional(),
  quiz_type: z
    .enum(["practice_quiz", "assignment", "graded_survey", "survey"])
    .optional()
    .describe("Accepted for compatibility but ignored — New Quizzes has no quiz_type."),
  due_at: z.string().optional().describe("ISO-8601 due date (e.g., '2026-06-01T23:59:00Z')."),
  points_possible: z.number().optional(),
  shuffle_answers: z.boolean().optional(),
  shuffle_questions: z.boolean().optional(),
  allowed_attempts: z.number().int().optional(),
  time_limit: z.number().int().optional().describe("Time limit in minutes. Omit for no limit."),
  show_correct_answers: z.boolean().optional(),
};

const UPDATE_QUIZ_QUESTION_INPUT = {
  course_identifier: z.union([z.string(), z.number()]),
  quiz_id: z.union([z.string(), z.number()]).describe("The New Quiz's id (Canvas assignment id)."),
  question_id: z
    .union([z.string(), z.number()])
    .describe("The item id to replace (from get_quiz's items[].id)."),
  question: QUESTION_PAYLOAD_SCHEMA,
};

const DELETE_QUIZ_QUESTION_INPUT = {
  course_identifier: z.union([z.string(), z.number()]),
  quiz_id: z.union([z.string(), z.number()]).describe("The New Quiz's id (Canvas assignment id)."),
  question_id: z.union([z.string(), z.number()]).describe("The item id to delete."),
};

interface NewQuizLite {
  id: string;
  title?: string;
  instructions?: string;
  points_possible?: number | null;
  due_at?: string | null;
  unlock_at?: string | null;
  lock_at?: string | null;
  published?: boolean;
  grading_type?: string;
  assignment_group_id?: string | number | null;
  quiz_settings?: Record<string, unknown> | null;
}

interface NewQuizItemLite {
  id: string;
  position?: number;
  points_possible?: number | null;
  entry_type?: string;
  entry?: {
    title?: string;
    item_body?: string;
    interaction_type_slug?: string;
    scoring_algorithm?: string;
  } | null;
  // Some responses flatten these onto the item itself:
  interaction_type_slug?: string;
  item_body?: string;
}

const QUIZ_DISPLAY_KEYS = ["id", "title", "published", "points_possible", "due_at"] as const;
const QUIZ_DETAIL_DISPLAY_KEYS = [
  ...QUIZ_DISPLAY_KEYS,
  "instructions",
  "grading_type",
  "unlock_at",
  "lock_at",
  "quiz_settings",
] as const;

function quizHtmlUrl(baseUrl: string, courseId: number, quizId: string | number): string {
  return `${deriveCourseUrl(baseUrl, courseId)}/assignments/${quizId}`;
}

function displayQuiz(
  quiz: NewQuizLite,
  courseId: number,
  baseUrl: string,
  keys: readonly string[] = QUIZ_DISPLAY_KEYS,
): Record<string, unknown> {
  const projected = pickFields(quiz as unknown as Record<string, unknown>, keys);
  projected.html_url = quizHtmlUrl(baseUrl, courseId, quiz.id);
  return projected;
}

function displayItem(item: NewQuizItemLite): Record<string, unknown> {
  const entry = item.entry ?? {};
  return {
    id: item.id ?? null,
    position: item.position ?? null,
    points_possible: item.points_possible ?? null,
    interaction_type_slug: item.interaction_type_slug ?? entry.interaction_type_slug ?? null,
    item_body: item.item_body ?? entry.item_body ?? null,
  };
}

/** Wrap plain text in a <p> so New Quizzes' rich-content fields render it. */
function richText(value: string | undefined): string {
  const text = value ?? "";
  return /^\s*</.test(text) ? text : `<p>${text}</p>`;
}

function answerBody(answer: z.infer<typeof QUESTION_ANSWER_SCHEMA>): string {
  return answer.answer_html ?? richText(answer.answer_text);
}

function isCorrect(answer: z.infer<typeof QUESTION_ANSWER_SCHEMA>): boolean {
  return (answer.answer_weight ?? 0) > 0;
}

function feedbackObject(question: QuestionPayload): Record<string, string> | undefined {
  const feedback: Record<string, string> = {};
  if (question.neutral_comments) feedback.neutral = richText(question.neutral_comments);
  if (question.correct_comments) feedback.correct = richText(question.correct_comments);
  if (question.incorrect_comments) feedback.incorrect = richText(question.incorrect_comments);
  return Object.keys(feedback).length > 0 ? feedback : undefined;
}

interface QuizItemEntry {
  interaction_type_slug: string;
  item_body: string;
  title?: string;
  calculator_type?: string;
  interaction_data: Record<string, unknown>;
  properties?: Record<string, unknown>;
  scoring_data: Record<string, unknown>;
  scoring_algorithm: string;
  feedback?: Record<string, string>;
  answer_feedback?: Record<string, string>;
}

/**
 * Translate the Classic-style friendly question payload into a New Quizzes item
 * `entry`. We generate every UUID here and mirror the correct-answer UUID(s)
 * into scoring_data so the caller never touches UUIDs.
 */
function buildItemEntry(question: QuestionPayload): QuizItemEntry {
  const base = {
    item_body: richText(question.question_text),
    ...(question.question_name ? { title: question.question_name } : {}),
  };
  const feedback = feedbackObject(question);
  const withFeedback = <T extends Omit<QuizItemEntry, "item_body">>(entry: T): QuizItemEntry => ({
    ...base,
    ...entry,
    ...(feedback ? { feedback } : {}),
  });

  switch (question.question_type) {
    case "multiple_choice_question": {
      const answers = question.answers ?? [];
      if (answers.length < 2) {
        throw new Error("multiple_choice_question needs at least 2 answers.");
      }
      const choices = answers.map((answer, index) => ({
        id: randomUUID(),
        position: index + 1,
        itemBody: answerBody(answer),
      }));
      const correctIndex = answers.findIndex(isCorrect);
      if (correctIndex === -1) {
        throw new Error("multiple_choice_question needs one answer with answer_weight 100.");
      }
      const answerFeedback: Record<string, string> = {};
      answers.forEach((answer, index) => {
        if (answer.answer_comments) answerFeedback[choices[index].id] = richText(answer.answer_comments);
      });
      return withFeedback({
        interaction_type_slug: "choice",
        interaction_data: { choices },
        properties: { shuffleRules: { choices: { shuffled: false, toLock: [] } }, varyPointsByAnswer: false },
        scoring_data: { value: choices[correctIndex].id },
        scoring_algorithm: "Equivalence",
        ...(Object.keys(answerFeedback).length > 0 ? { answer_feedback: answerFeedback } : {}),
      });
    }

    case "true_false_question": {
      const answers = question.answers ?? [];
      const correct = answers.find(isCorrect);
      if (!correct) {
        throw new Error("true_false_question needs the correct side marked with answer_weight 100.");
      }
      const correctValue = /^\s*true\s*$/i.test(correct.answer_text ?? "");
      return withFeedback({
        interaction_type_slug: "true-false",
        interaction_data: { true_choice: "True", false_choice: "False" },
        scoring_data: { value: correctValue },
        scoring_algorithm: "Equivalence",
      });
    }

    case "multiple_answers_question": {
      const answers = question.answers ?? [];
      if (answers.length < 2) {
        throw new Error("multiple_answers_question needs at least 2 answers.");
      }
      const choices = answers.map((answer, index) => ({
        id: randomUUID(),
        position: index + 1,
        itemBody: answerBody(answer),
      }));
      const correctIds = choices.filter((_, index) => isCorrect(answers[index])).map((choice) => choice.id);
      if (correctIds.length === 0) {
        throw new Error("multiple_answers_question needs at least one answer with answer_weight 100.");
      }
      return withFeedback({
        interaction_type_slug: "multi-answer",
        interaction_data: { choices },
        scoring_data: { value: correctIds },
        scoring_algorithm: "AllOrNothing",
      });
    }

    // short_answer maps to a manually-graded essay in New Quizzes (there is no
    // auto-graded fill-in item). The Classic accepted-answer variants are kept
    // as grader notes so the teacher still sees the answer key in SpeedGrader.
    case "short_answer_question":
    case "essay_question": {
      const acceptedAnswers = (question.answers ?? [])
        .filter(isCorrect)
        .map((answer) => answer.answer_text)
        .filter((text): text is string => Boolean(text));
      const graderNotes =
        acceptedAnswers.length > 0
          ? `Accepted answers: ${acceptedAnswers.join("; ")}`
          : "";
      return withFeedback({
        interaction_type_slug: "essay",
        interaction_data: {
          rce: true,
          spell_check: false,
          word_count: false,
          file_upload: false,
          word_limit_enabled: false,
        },
        scoring_data: { value: graderNotes },
        scoring_algorithm: "None",
      });
    }

    case "matching_question": {
      const matches = question.matches ?? [];
      if (matches.length < 2) {
        throw new Error("matching_question needs at least 2 matches [{ left, right }].");
      }
      const questions = matches.map((pair) => ({ id: randomUUID(), item_body: pair.left }));
      const answerPool = [...matches.map((pair) => pair.right), ...(question.distractors ?? [])];
      const uniqueAnswers = Array.from(new Set(answerPool));
      const value: Record<string, string> = {};
      questions.forEach((entry, index) => {
        value[entry.id] = matches[index].right;
      });
      return withFeedback({
        interaction_type_slug: "matching",
        interaction_data: { answers: uniqueAnswers, questions },
        properties: { shuffle_rules: { questions: { shuffled: false } } },
        scoring_data: { value },
        scoring_algorithm: "DeepEquals",
      });
    }

    case "ordering_question": {
      const items = question.ordering_items ?? [];
      if (items.length < 2) {
        throw new Error("ordering_question needs at least 2 ordering_items in correct order.");
      }
      const ids = items.map(() => randomUUID());
      const choices: Record<string, unknown> = {};
      ids.forEach((id, index) => {
        choices[id] = { id, item_body: richText(items[index]) };
      });
      const hasLabels = Boolean(question.ordering_top_label || question.ordering_bottom_label);
      return withFeedback({
        interaction_type_slug: "ordering",
        interaction_data: { choices },
        properties: {
          shuffle_rules: null,
          include_labels: hasLabels,
          display_answers_paragraph: false,
          ...(question.ordering_top_label ? { top_label: question.ordering_top_label } : {}),
          ...(question.ordering_bottom_label ? { bottom_label: question.ordering_bottom_label } : {}),
        },
        scoring_data: { value: ids },
        scoring_algorithm: "DeepEquals",
      });
    }

    default: {
      const exhaustive: never = question.question_type;
      throw new Error(`Unsupported question_type: ${String(exhaustive)}`);
    }
  }
}

/** Map the friendly create/update settings into the quiz_settings sub-tree. */
function buildQuizSettings(args: {
  shuffle_answers?: boolean;
  shuffle_questions?: boolean;
  allowed_attempts?: number;
  time_limit?: number;
  show_correct_answers?: boolean;
}): Record<string, unknown> {
  const settings: Record<string, unknown> = {};
  if (args.shuffle_answers !== undefined) settings.shuffle_answers = args.shuffle_answers;
  if (args.shuffle_questions !== undefined) settings.shuffle_questions = args.shuffle_questions;
  if (args.time_limit !== undefined) {
    settings.has_time_limit = true;
    settings.session_time_limit_in_seconds = args.time_limit * 60;
  }
  if (args.allowed_attempts !== undefined) {
    // When multiple attempts are enabled the New Quizzes API requires a valid
    // score_to_keep (average|first|highest|latest) — omitting it 400s. Default
    // to "highest", matching Classic's default retake scoring policy.
    if (args.allowed_attempts <= 0) {
      settings.multiple_attempts = {
        multiple_attempts_enabled: true,
        attempt_limit: false,
        score_to_keep: "highest",
      };
    } else if (args.allowed_attempts === 1) {
      settings.multiple_attempts = { multiple_attempts_enabled: false };
    } else {
      settings.multiple_attempts = {
        multiple_attempts_enabled: true,
        attempt_limit: true,
        max_attempts: args.allowed_attempts,
        score_to_keep: "highest",
      };
    }
  }
  if (args.show_correct_answers !== undefined) {
    settings.result_view_settings =
      args.show_correct_answers === false
        ? {
            result_view_restricted: true,
            display_item_correct_answer: false,
            display_item_response_correctness: false,
          }
        : { result_view_restricted: false };
  }
  return settings;
}

const NEW_QUIZZES_NOTE =
  "New Quizzes: these live on the /api/quiz/v1 service and are backed by Canvas assignments (quiz_id === assignment_id). " +
  "There is no submissions/regrade API — student attempts surface only in SpeedGrader.";

export function registerQuizTools(server: McpServer, canvas: CanvasClient): void {
  server.registerTool(
    "create_quiz",
    {
      description:
        "Create a Canvas New Quiz. Created unpublished per the Franklin no-auto-publish rule — teacher publishes after review. " +
        "Returns the quiz id (which is the Canvas assignment id) and a constructed html_url. " +
        "description is sent as the quiz instructions (rendered above the questions). " +
        NEW_QUIZZES_NOTE,
      inputSchema: CREATE_QUIZ_INPUT,
    },
    async (input) => {
      const args = input as z.infer<z.ZodObject<typeof CREATE_QUIZ_INPUT>>;
      return safeHandler("create_quiz", async () => {
        const courseId = await canvas.resolveCourseId(args.course_identifier, { bypassCache: true });
        const quizPayload: Record<string, unknown> = { title: args.title };
        if (args.description !== undefined) quizPayload.instructions = args.description;
        if (args.due_at !== undefined) quizPayload.due_at = args.due_at;
        if (args.points_possible !== undefined) quizPayload.points_possible = args.points_possible;
        const settings = buildQuizSettings(args);
        if (Object.keys(settings).length > 0) quizPayload.quiz_settings = settings;

        const created = await canvas.post<NewQuizLite>(
          `/api/quiz/v1/courses/${courseId}/quizzes`,
          { quiz: quizPayload },
        );
        return jsonResult(displayQuiz(created, courseId, canvas.baseUrl), {
          summary: `Created unpublished New Quiz "${created.title ?? args.title}" (id ${created.id}).`,
        });
      });
    },
  );

  server.registerTool(
    "create_quiz_question",
    {
      description:
        "Add a single question (item) to an existing New Quiz. Same friendly payload as the Classic tool — the server generates the New Quizzes UUIDs and scoring data. " +
        "Supported question_type: multiple_choice_question, true_false_question, multiple_answers_question, short_answer_question (→ manually-graded essay), essay_question, matching_question (uses matches[]), ordering_question (uses ordering_items[]).",
      inputSchema: CREATE_QUIZ_QUESTION_INPUT,
    },
    async (input) => {
      const args = input as {
        course_identifier: string | number;
        quiz_id: string | number;
        question: QuestionPayload;
      };
      return safeHandler("create_quiz_question", async () => {
        const courseId = await canvas.resolveCourseId(args.course_identifier, { bypassCache: true });
        const entry = buildItemEntry(args.question);
        const itemPayload: Record<string, unknown> = { entry_type: "Item", entry };
        if (args.question.points_possible !== undefined) {
          itemPayload.points_possible = args.question.points_possible;
        }
        const created = await canvas.post<NewQuizItemLite>(
          `/api/quiz/v1/courses/${courseId}/quizzes/${args.quiz_id}/items`,
          { item: itemPayload },
        );
        return jsonResult(displayItem(created), {
          summary: `Added ${args.question.question_type} to quiz ${args.quiz_id} (item ${created.id}).`,
        });
      });
    },
  );

  server.registerTool(
    "list_quizzes",
    {
      description: `List New Quizzes in a Canvas course (id, title, published, points_possible, due_at, html_url). ${NEW_QUIZZES_NOTE}`,
      inputSchema: LIST_QUIZZES_INPUT,
    },
    async (input) => {
      const args = input as z.infer<z.ZodObject<typeof LIST_QUIZZES_INPUT>>;
      return safeHandler("list_quizzes", async () => {
        const courseId = await canvas.resolveCourseId(args.course_identifier);
        const { items: quizzes, truncated, pages } = await canvas.getPaginated<NewQuizLite>(
          `/api/quiz/v1/courses/${courseId}/quizzes`,
        );
        return jsonResult(
          {
            course_id: courseId,
            count: quizzes.length,
            pages,
            truncated,
            quizzes: quizzes.map((quiz) => displayQuiz(quiz, courseId, canvas.baseUrl)),
          },
          { summary: `Course ${courseId}: ${quizzes.length} New Quiz(zes).` },
        );
      });
    },
  );

  server.registerTool(
    "get_quiz",
    {
      description: `Fetch a New Quiz's settings (title, published, points, due/unlock/lock, instructions, quiz_settings) and its items (trimmed to id, position, points_possible, interaction_type_slug, item_body). ${NEW_QUIZZES_NOTE}`,
      inputSchema: GET_QUIZ_INPUT,
    },
    async (input) => {
      const args = input as z.infer<z.ZodObject<typeof GET_QUIZ_INPUT>>;
      return safeHandler("get_quiz", async () => {
        const courseId = await canvas.resolveCourseId(args.course_identifier);
        const [quiz, itemsPage] = await Promise.all([
          canvas.get<NewQuizLite>(`/api/quiz/v1/courses/${courseId}/quizzes/${args.quiz_id}`),
          canvas.getPaginated<NewQuizItemLite>(
            `/api/quiz/v1/courses/${courseId}/quizzes/${args.quiz_id}/items`,
          ),
        ]);
        const items = itemsPage.items.map(displayItem);
        return jsonResult(
          {
            quiz: displayQuiz(quiz, courseId, canvas.baseUrl, QUIZ_DETAIL_DISPLAY_KEYS),
            item_count: items.length,
            item_pages: itemsPage.pages,
            items_truncated: itemsPage.truncated,
            items,
          },
          { summary: `New Quiz "${quiz.title ?? args.quiz_id}" (id ${quiz.id ?? args.quiz_id}): ${items.length} item(s).` },
        );
      });
    },
  );

  server.registerTool(
    "update_quiz",
    {
      description:
        "Update settings on an existing New Quiz (title, description/instructions, due_at, points_possible, shuffle_answers, shuffle_questions, allowed_attempts, time_limit, show_correct_answers). Never touches published state.",
      inputSchema: UPDATE_QUIZ_INPUT,
    },
    async (input) => {
      const args = input as z.infer<z.ZodObject<typeof UPDATE_QUIZ_INPUT>>;
      return safeHandler("update_quiz", async () => {
        const quizPayload: Record<string, unknown> = {};
        if (args.title !== undefined) quizPayload.title = args.title;
        if (args.description !== undefined) quizPayload.instructions = args.description;
        if (args.due_at !== undefined) quizPayload.due_at = args.due_at;
        if (args.points_possible !== undefined) quizPayload.points_possible = args.points_possible;
        const settings = buildQuizSettings(args);
        if (Object.keys(settings).length > 0) quizPayload.quiz_settings = settings;
        if (Object.keys(quizPayload).length === 0) {
          throw new Error(
            "update_quiz: provide at least one field to update (title, description, due_at, points_possible, shuffle_answers, shuffle_questions, allowed_attempts, time_limit, show_correct_answers).",
          );
        }

        const courseId = await canvas.resolveCourseId(args.course_identifier, { bypassCache: true });
        const updated = await canvas.patch<NewQuizLite>(
          `/api/quiz/v1/courses/${courseId}/quizzes/${args.quiz_id}`,
          { quiz: quizPayload },
        );
        return jsonResult(displayQuiz(updated, courseId, canvas.baseUrl), {
          summary: `Updated New Quiz "${updated.title ?? args.quiz_id}" (id ${updated.id ?? args.quiz_id}): ${Object.keys(quizPayload).join(", ")}.`,
        });
      });
    },
  );

  server.registerTool(
    "update_quiz_question",
    {
      description:
        "Replace an existing New Quiz item's content (same friendly payload as create_quiz_question). question_id is the item id from get_quiz's items[].id.",
      inputSchema: UPDATE_QUIZ_QUESTION_INPUT,
    },
    async (input) => {
      const args = input as {
        course_identifier: string | number;
        quiz_id: string | number;
        question_id: string | number;
        question: QuestionPayload;
      };
      return safeHandler("update_quiz_question", async () => {
        const courseId = await canvas.resolveCourseId(args.course_identifier, { bypassCache: true });
        const entry = buildItemEntry(args.question);
        const itemPayload: Record<string, unknown> = { entry_type: "Item", entry };
        if (args.question.points_possible !== undefined) {
          itemPayload.points_possible = args.question.points_possible;
        }
        const updated = await canvas.patch<NewQuizItemLite>(
          `/api/quiz/v1/courses/${courseId}/quizzes/${args.quiz_id}/items/${args.question_id}`,
          { item: itemPayload },
        );
        return jsonResult(displayItem(updated), {
          summary: `Updated item ${args.question_id} on quiz ${args.quiz_id}.`,
        });
      });
    },
  );

  server.registerTool(
    "delete_quiz_question",
    {
      description: "Delete an item from a New Quiz. question_id is the item id from get_quiz's items[].id.",
      inputSchema: DELETE_QUIZ_QUESTION_INPUT,
    },
    async (input) => {
      const args = input as z.infer<z.ZodObject<typeof DELETE_QUIZ_QUESTION_INPUT>>;
      return safeHandler("delete_quiz_question", async () => {
        const courseId = await canvas.resolveCourseId(args.course_identifier, { bypassCache: true });
        await canvas.del<unknown>(
          `/api/quiz/v1/courses/${courseId}/quizzes/${args.quiz_id}/items/${args.question_id}`,
        );
        return jsonResult(
          { course_id: courseId, quiz_id: args.quiz_id, deleted_item_id: args.question_id },
          { summary: `Deleted item ${args.question_id} from quiz ${args.quiz_id} in course ${courseId}.` },
        );
      });
    },
  );
}
