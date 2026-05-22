import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import type { CanvasClient } from "../canvasClient.js";
import { jsonResult, safeHandler } from "./toolHelpers.js";

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

interface CanvasQuizLite {
  id: number;
  title: string;
  quiz_type?: string;
  published?: boolean;
  html_url?: string;
  due_at?: string | null;
  points_possible?: number | null;
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

export function registerQuizTools(server: McpServer, canvas: CanvasClient): void {
  server.registerTool(
    "create_quiz",
    {
      description:
        "Create a Canvas quiz. published is forced false per Franklin School cross-project rule — teacher publishes after review.",
      inputSchema: CREATE_QUIZ_INPUT,
    },
    async (input) => {
      const args = input as z.infer<z.ZodObject<typeof CREATE_QUIZ_INPUT>>;
      return safeHandler("create_quiz", async () => {
        const courseId = await canvas.resolveCourseId(args.course_identifier);
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

        const created = await canvas.post<CanvasQuizLite>(
          `/api/v1/courses/${courseId}/quizzes`,
          { quiz: quizPayload },
        );
        return jsonResult(created, {
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
        const courseId = await canvas.resolveCourseId(args.course_identifier);
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
}
