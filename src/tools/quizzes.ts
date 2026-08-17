import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import type { CanvasClient } from "../canvasClient.js";
import { jsonResult, pickFields, safeHandler } from "./toolHelpers.js";

const QUIZ_TYPE = z
  .enum(["practice_quiz", "assignment", "graded_survey", "survey"])
  .describe("Canvas quiz_type. Defaults to 'assignment'.");

const CREATE_QUIZ_INPUT = {
  course_identifier: z.union([z.string(), z.number()]),
  title: z.string(),
  description: z.string().optional(),
  quiz_type: QUIZ_TYPE.optional(),
  due_at: z.string().optional().describe("ISO-8601 due date (e.g., '2026-06-01T23:59:00Z')."),
  points_possible: z.number().optional(),
  shuffle_answers: z.boolean().optional(),
  allowed_attempts: z.number().int().optional(),
  time_limit: z.number().int().optional().describe("Time limit in minutes. Omit for no limit."),
  show_correct_answers: z
    .boolean()
    .optional()
    .describe("Whether students see correct answers after submitting. Canvas defaults to true when omitted."),
};

const QUESTION_ANSWER_SCHEMA = z.object({
  answer_text: z.string().optional(),
  answer_html: z.string().optional(),
  answer_weight: z.number().optional().describe("100 for correct, 0 for incorrect in multiple-choice."),
  answer_comments: z.string().optional(),
});

const QUESTION_PAYLOAD_SCHEMA = z.object({
  question_name: z.string().optional(),
  question_text: z.string(),
  question_type: z.enum([
    "calculated_question",
    "essay_question",
    "file_upload_question",
    "fill_in_multiple_blanks_question",
    "matching_question",
    "multiple_answers_question",
    "multiple_choice_question",
    "multiple_dropdowns_question",
    "numerical_question",
    "short_answer_question",
    "text_only_question",
    "true_false_question",
  ]),
  points_possible: z.number().optional(),
  correct_comments: z.string().optional(),
  incorrect_comments: z.string().optional(),
  neutral_comments: z.string().optional(),
  answers: z.array(QUESTION_ANSWER_SCHEMA).optional(),
});

const CREATE_QUIZ_QUESTION_INPUT = {
  course_identifier: z.union([z.string(), z.number()]),
  quiz_id: z.union([z.string(), z.number()]),
  question: QUESTION_PAYLOAD_SCHEMA,
};

const LIST_QUIZZES_INPUT = {
  course_identifier: z.union([z.string(), z.number()]),
};

const GET_QUIZ_INPUT = {
  course_identifier: z.union([z.string(), z.number()]),
  quiz_id: z.union([z.string(), z.number()]),
};

const UPDATE_QUIZ_INPUT = {
  course_identifier: z.union([z.string(), z.number()]),
  quiz_id: z.union([z.string(), z.number()]),
  title: z.string().optional(),
  description: z.string().optional(),
  quiz_type: QUIZ_TYPE.optional(),
  due_at: z.string().optional().describe("ISO-8601 due date (e.g., '2026-06-01T23:59:00Z')."),
  points_possible: z.number().optional(),
  shuffle_answers: z.boolean().optional(),
  allowed_attempts: z.number().int().optional(),
  time_limit: z.number().int().optional().describe("Time limit in minutes. Omit for no limit."),
  show_correct_answers: z
    .boolean()
    .optional()
    .describe("Whether students see correct answers after submitting. Canvas defaults to true when omitted."),
};

const UPDATE_QUIZ_QUESTION_INPUT = {
  course_identifier: z.union([z.string(), z.number()]),
  quiz_id: z.union([z.string(), z.number()]),
  question_id: z.union([z.string(), z.number()]),
  question: QUESTION_PAYLOAD_SCHEMA,
};

const DELETE_QUIZ_QUESTION_INPUT = {
  course_identifier: z.union([z.string(), z.number()]),
  quiz_id: z.union([z.string(), z.number()]),
  question_id: z.union([z.string(), z.number()]),
};

interface CanvasQuizLite {
  id: number;
  title: string;
  quiz_type?: string;
  published?: boolean;
  html_url?: string;
  due_at?: string | null;
  points_possible?: number | null;
  question_count?: number;
}

const QUIZ_DISPLAY_KEYS = [
  "id",
  "title",
  "quiz_type",
  "published",
  "due_at",
  "points_possible",
  "question_count",
  "html_url",
] as const;

// get_quiz is the inspect tool, so it adds the settings fields on top of the
// list shape. access_code is fine for the teacher but kept explicit here so
// its exposure is a deliberate allowlist entry, not an accident.
const QUIZ_DETAIL_DISPLAY_KEYS = [
  ...QUIZ_DISPLAY_KEYS,
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
] as const;

function displayQuiz(quiz: CanvasQuizLite): Record<string, unknown> {
  return pickFields(quiz as unknown as Record<string, unknown>, QUIZ_DISPLAY_KEYS);
}

interface CanvasQuizQuestionLite {
  id: number;
  quiz_id: number;
  position: number;
  question_name?: string;
  question_text: string;
  question_type: string;
  points_possible: number;
  answers?: unknown[];
}

const QUESTION_DISPLAY_KEYS = [
  "id",
  "position",
  "question_name",
  "question_type",
  "points_possible",
  "question_text",
  "answers",
] as const;

function displayQuizQuestion(question: CanvasQuizQuestionLite): Record<string, unknown> {
  return pickFields(question as unknown as Record<string, unknown>, QUESTION_DISPLAY_KEYS);
}

const CLASSIC_QUIZZES_ONLY_NOTE =
  "Classic Quizzes only: New Quizzes live on a separate API and will NOT appear here — they show up in list_assignments as external_tool items with is_quiz_lti_assignment: true.";

const QUIZ_VERSIONING_WARNING =
  "If the quiz already has student submissions, Canvas creates a new quiz version and students may need to retake it for edits to count.";

export function registerQuizTools(server: McpServer, canvas: CanvasClient): void {
  server.registerTool(
    "create_quiz",
    {
      description:
        "Create a Canvas quiz. published is forced false per Franklin School cross-project rule — teacher publishes after review. " +
        "Quiz description is sent verbatim (no page-template wrapping — quiz intros render above the questions, not as wiki pages).",
      inputSchema: CREATE_QUIZ_INPUT,
    },
    async (input) => {
      const args = input as z.infer<z.ZodObject<typeof CREATE_QUIZ_INPUT>>;
      return safeHandler("create_quiz", async () => {
        const courseId = await canvas.resolveCourseId(args.course_identifier, { bypassCache: true });
        const quizPayload: Record<string, unknown> = {
          title: args.title,
          quiz_type: args.quiz_type ?? "assignment",
          published: false,
        };
        if (args.description !== undefined) quizPayload.description = args.description;
        if (args.due_at !== undefined) quizPayload.due_at = args.due_at;
        if (args.points_possible !== undefined) quizPayload.points_possible = args.points_possible;
        if (args.shuffle_answers !== undefined) quizPayload.shuffle_answers = args.shuffle_answers;
        if (args.allowed_attempts !== undefined) quizPayload.allowed_attempts = args.allowed_attempts;
        if (args.time_limit !== undefined) quizPayload.time_limit = args.time_limit;
        if (args.show_correct_answers !== undefined) quizPayload.show_correct_answers = args.show_correct_answers;

        const created = await canvas.post<CanvasQuizLite>(
          `/api/v1/courses/${courseId}/quizzes`,
          { quiz: quizPayload },
        );
        return jsonResult(displayQuiz(created), {
          summary: `Created draft quiz "${created.title}" (id ${created.id}).`,
        });
      });
    },
  );

  server.registerTool(
    "create_quiz_question",
    {
      description:
        "Add a single question to an existing Canvas quiz. answers[] is required for choice-style question_types.",
      inputSchema: CREATE_QUIZ_QUESTION_INPUT,
    },
    async (input) => {
      const args = input as {
        course_identifier: string | number;
        quiz_id: string | number;
        question: z.infer<typeof QUESTION_PAYLOAD_SCHEMA>;
      };
      return safeHandler("create_quiz_question", async () => {
        const courseId = await canvas.resolveCourseId(args.course_identifier, { bypassCache: true });
        const created = await canvas.post<CanvasQuizQuestionLite>(
          `/api/v1/courses/${courseId}/quizzes/${args.quiz_id}/questions`,
          { question: args.question },
        );
        return jsonResult(created, {
          summary: `Added ${args.question.question_type} question to quiz ${args.quiz_id} (id ${created.id}).`,
        });
      });
    },
  );

  server.registerTool(
    "list_quizzes",
    {
      description: `List quizzes in a Canvas course (id, title, quiz_type, published, due_at, points_possible, question_count). ${CLASSIC_QUIZZES_ONLY_NOTE}`,
      inputSchema: LIST_QUIZZES_INPUT,
    },
    async (input) => {
      const args = input as z.infer<z.ZodObject<typeof LIST_QUIZZES_INPUT>>;
      return safeHandler("list_quizzes", async () => {
        const courseId = await canvas.resolveCourseId(args.course_identifier);
        const { items: quizzes, truncated, pages } = await canvas.getPaginated<CanvasQuizLite>(
          `/api/v1/courses/${courseId}/quizzes`,
        );
        return jsonResult(
          {
            course_id: courseId,
            count: quizzes.length,
            pages,
            truncated,
            quizzes: quizzes.map(displayQuiz),
          },
          { summary: `Course ${courseId}: ${quizzes.length} classic quiz(zes).` },
        );
      });
    },
  );

  server.registerTool(
    "get_quiz",
    {
      description: `Fetch a Canvas quiz's settings (list fields plus description, shuffle_answers, allowed_attempts, time_limit, one_question_at_a_time, hide_results, scoring_policy, access_code, unlock_at, lock_at) and its questions (trimmed to id, position, name, type, points, text, answers). ${CLASSIC_QUIZZES_ONLY_NOTE}`,
      inputSchema: GET_QUIZ_INPUT,
    },
    async (input) => {
      const args = input as z.infer<z.ZodObject<typeof GET_QUIZ_INPUT>>;
      return safeHandler("get_quiz", async () => {
        const courseId = await canvas.resolveCourseId(args.course_identifier);
        const [quiz, questionsPage] = await Promise.all([
          canvas.get<CanvasQuizLite>(`/api/v1/courses/${courseId}/quizzes/${args.quiz_id}`),
          canvas.getPaginated<CanvasQuizQuestionLite>(
            `/api/v1/courses/${courseId}/quizzes/${args.quiz_id}/questions`,
          ),
        ]);
        const questions = questionsPage.items.map(displayQuizQuestion);
        return jsonResult(
          {
            quiz: pickFields(quiz as unknown as Record<string, unknown>, QUIZ_DETAIL_DISPLAY_KEYS),
            question_count: questions.length,
            question_pages: questionsPage.pages,
            questions_truncated: questionsPage.truncated,
            questions,
          },
          { summary: `Quiz "${quiz.title}" (id ${quiz.id}): ${questions.length} question(s).` },
        );
      });
    },
  );

  server.registerTool(
    "update_quiz",
    {
      description:
        "Update settings on an existing Canvas quiz (title, description, quiz_type, due_at, points_possible, shuffle_answers, allowed_attempts). Never touches published state — quizzes with student submissions cannot be unpublished, and question edits on such quizzes create a new quiz version. " +
        "Quiz description is sent verbatim (no page-template wrapping — quiz intros render above the questions, not as wiki pages).",
      inputSchema: UPDATE_QUIZ_INPUT,
    },
    async (input) => {
      const args = input as z.infer<z.ZodObject<typeof UPDATE_QUIZ_INPUT>>;
      return safeHandler("update_quiz", async () => {
        const quizPayload: Record<string, unknown> = {};
        if (args.title !== undefined) quizPayload.title = args.title;
        if (args.description !== undefined) quizPayload.description = args.description;
        if (args.quiz_type !== undefined) quizPayload.quiz_type = args.quiz_type;
        if (args.due_at !== undefined) quizPayload.due_at = args.due_at;
        if (args.points_possible !== undefined) quizPayload.points_possible = args.points_possible;
        if (args.shuffle_answers !== undefined) quizPayload.shuffle_answers = args.shuffle_answers;
        if (args.allowed_attempts !== undefined) quizPayload.allowed_attempts = args.allowed_attempts;
        if (args.time_limit !== undefined) quizPayload.time_limit = args.time_limit;
        if (args.show_correct_answers !== undefined) quizPayload.show_correct_answers = args.show_correct_answers;
        if (Object.keys(quizPayload).length === 0) {
          throw new Error(
            "update_quiz: provide at least one field to update (title, description, quiz_type, due_at, points_possible, shuffle_answers, allowed_attempts, time_limit, show_correct_answers).",
          );
        }

        const courseId = await canvas.resolveCourseId(args.course_identifier, { bypassCache: true });
        const updated = await canvas.put<CanvasQuizLite>(
          `/api/v1/courses/${courseId}/quizzes/${args.quiz_id}`,
          { quiz: quizPayload },
        );
        return jsonResult(displayQuiz(updated), {
          summary: `Updated quiz "${updated.title}" (id ${updated.id}): ${Object.keys(quizPayload).join(", ")}.`,
        });
      });
    },
  );

  server.registerTool(
    "update_quiz_question",
    {
      description: `Replace an existing quiz question's content (same payload shape as create_quiz_question). ${QUIZ_VERSIONING_WARNING}`,
      inputSchema: UPDATE_QUIZ_QUESTION_INPUT,
    },
    async (input) => {
      const args = input as {
        course_identifier: string | number;
        quiz_id: string | number;
        question_id: string | number;
        question: z.infer<typeof QUESTION_PAYLOAD_SCHEMA>;
      };
      return safeHandler("update_quiz_question", async () => {
        const courseId = await canvas.resolveCourseId(args.course_identifier, { bypassCache: true });
        const updated = await canvas.put<CanvasQuizQuestionLite>(
          `/api/v1/courses/${courseId}/quizzes/${args.quiz_id}/questions/${args.question_id}`,
          { question: args.question },
        );
        return jsonResult(displayQuizQuestion(updated), {
          summary: `Updated question ${args.question_id} on quiz ${args.quiz_id}.`,
        });
      });
    },
  );

  server.registerTool(
    "delete_quiz_question",
    {
      description: `Delete a question from a Canvas quiz. ${QUIZ_VERSIONING_WARNING}`,
      inputSchema: DELETE_QUIZ_QUESTION_INPUT,
    },
    async (input) => {
      const args = input as z.infer<z.ZodObject<typeof DELETE_QUIZ_QUESTION_INPUT>>;
      return safeHandler("delete_quiz_question", async () => {
        const courseId = await canvas.resolveCourseId(args.course_identifier, { bypassCache: true });
        await canvas.del<unknown>(
          `/api/v1/courses/${courseId}/quizzes/${args.quiz_id}/questions/${args.question_id}`,
        );
        return jsonResult(
          { course_id: courseId, quiz_id: args.quiz_id, deleted_question_id: args.question_id },
          { summary: `Deleted question ${args.question_id} from quiz ${args.quiz_id} in course ${courseId}.` },
        );
      });
    },
  );
}
