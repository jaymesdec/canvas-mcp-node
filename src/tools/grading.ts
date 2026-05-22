import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import type { CanvasClient } from "../canvasClient.js";
import { CanvasApiError } from "../types.js";
import { jsonResult, safeHandler } from "./toolHelpers.js";

const RUBRIC_ASSESSMENT_VALUE = z.object({
  points: z.number(),
  rating_id: z.string().optional(),
  comments: z.string().optional(),
});

const RUBRIC_ASSESSMENT_RECORD = z.record(z.string(), RUBRIC_ASSESSMENT_VALUE);

const GRADE_SUBMISSION_INPUT = {
  course_identifier: z.union([z.string(), z.number()]),
  assignment_id: z.union([z.string(), z.number()]),
  user_id: z.union([z.string(), z.number()]).describe("Real Canvas user_id (never a pseudonym)."),
  posted_grade: z
    .union([z.string(), z.number()])
    .describe("Canvas posted_grade. Accepts a letter grade, percentage, or point value depending on the assignment's grading_type."),
  comment: z.string().optional(),
};

const GRADE_WITH_RUBRIC_INPUT = {
  course_identifier: z.union([z.string(), z.number()]),
  assignment_id: z.union([z.string(), z.number()]),
  user_id: z.union([z.string(), z.number()]),
  rubric_assessment: RUBRIC_ASSESSMENT_RECORD.describe(
    "Object keyed by criterion_id (often starts with underscore, e.g. '_8027') with { points, rating_id?, comments? }.",
  ),
  comment: z.string().optional(),
};

const GRADE_SUBMISSION_WITH_RUBRIC_INPUT = {
  course_identifier: z.union([z.string(), z.number()]),
  assignment_id: z.union([z.string(), z.number()]),
  user_id: z.union([z.string(), z.number()]),
  posted_grade: z.union([z.string(), z.number()]).optional(),
  rubric_assessment: RUBRIC_ASSESSMENT_RECORD.optional(),
  comment: z.string().optional(),
};

const BULK_GRADE_DECISION = z.object({
  posted_grade: z.union([z.string(), z.number()]).optional(),
  grade: z.union([z.string(), z.number()]).optional().describe("Alias for posted_grade (matches Python MCP signature)."),
  rubric_assessment: RUBRIC_ASSESSMENT_RECORD.optional(),
  comment: z.string().optional(),
});

const BULK_GRADE_SUBMISSIONS_INPUT = {
  course_identifier: z.union([z.string(), z.number()]),
  assignment_id: z.union([z.string(), z.number()]),
  grades: z
    .record(z.string(), BULK_GRADE_DECISION)
    .describe("Object keyed by real Canvas user_id with per-submission decisions."),
  dry_run: z.boolean().optional().describe("When true, returns would-be payloads without writing to Canvas. Defaults to false."),
  max_concurrent: z.number().int().positive().optional().describe("Max concurrent grading PUTs per batch. Defaults to 5."),
  rate_limit_delay: z.number().nonnegative().optional().describe("Delay (in seconds) between batches. Defaults to 1.0."),
};

interface GradeDecision {
  posted_grade?: string | number;
  grade?: string | number;
  rubric_assessment?: Record<string, { points: number; rating_id?: string; comments?: string }>;
  comment?: string;
}

interface GradeWriteResponse {
  id: number;
  user_id: number;
  assignment_id: number;
  score?: number | null;
  grade?: string | null;
  graded_at?: string | null;
  workflow_state?: string;
}

/**
 * Build Canvas's form-encoded payload for a submission update. Mirrors the lifted
 * code_api/canvas/grading/gradeWithRubric.ts:buildRubricAssessmentFormData behavior
 * exactly so the typed tool path and the execute_typescript path produce identical
 * Canvas requests.
 */
function buildGradeFormData(decision: GradeDecision): URLSearchParams {
  const params = new URLSearchParams();
  const posted = decision.posted_grade ?? decision.grade;
  if (posted !== undefined) {
    params.append("submission[posted_grade]", String(posted));
  }
  if (decision.rubric_assessment) {
    for (const [criterionId, value] of Object.entries(decision.rubric_assessment)) {
      if (typeof value.points !== "number") {
        throw new Error(
          `grade write: criterion "${criterionId}" points must be a number (got ${typeof value.points}).`,
        );
      }
      if (value.points < 0) {
        throw new Error(`grade write: criterion "${criterionId}" points cannot be negative (got ${value.points}).`);
      }
      params.append(`rubric_assessment[${criterionId}][points]`, String(value.points));
      if (value.rating_id) {
        params.append(`rubric_assessment[${criterionId}][rating_id]`, value.rating_id);
      }
      if (value.comments) {
        params.append(`rubric_assessment[${criterionId}][comments]`, value.comments);
      }
    }
  }
  if (decision.comment) {
    params.append("comment[text_comment]", decision.comment);
  }
  if (params.toString() === "") {
    throw new Error(
      "grade write: payload would be empty. Provide posted_grade, rubric_assessment, or comment.",
    );
  }
  return params;
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export function registerGradingTools(server: McpServer, canvas: CanvasClient): void {
  /** Shared core: PUT a single grading payload. Bypasses the course-code cache. */
  async function writeGrade(
    courseIdentifier: string | number,
    assignmentId: string | number,
    userId: string | number,
    decision: GradeDecision,
  ): Promise<GradeWriteResponse> {
    const courseId = await canvas.resolveCourseId(courseIdentifier, { bypassCache: true });
    const body = buildGradeFormData(decision);
    return canvas.put<GradeWriteResponse>(
      `/api/v1/courses/${courseId}/assignments/${assignmentId}/submissions/${userId}`,
      body,
      { headers: { "Content-Type": "application/x-www-form-urlencoded" } },
    );
  }

  server.registerTool(
    "grade_submission",
    {
      description:
        "Write a posted_grade (and optional comment) to a single submission. No rubric. Bypasses the course-code cache so a rename can't misroute the write.",
      inputSchema: GRADE_SUBMISSION_INPUT,
    },
    async (input) => {
      const args = input as z.infer<z.ZodObject<typeof GRADE_SUBMISSION_INPUT>>;
      return safeHandler("grade_submission", async () => {
        const response = await writeGrade(args.course_identifier, args.assignment_id, args.user_id, {
          posted_grade: args.posted_grade,
          comment: args.comment,
        });
        return jsonResult(response, {
          summary: `Graded user ${args.user_id} on assignment ${args.assignment_id}: posted_grade=${args.posted_grade}.`,
        });
      });
    },
  );

  server.registerTool(
    "grade_with_rubric",
    {
      description:
        "Write a rubric_assessment (per-criterion points + comments) to a single submission. No posted_grade override.",
      inputSchema: GRADE_WITH_RUBRIC_INPUT,
    },
    async (input) => {
      const args = input as z.infer<z.ZodObject<typeof GRADE_WITH_RUBRIC_INPUT>>;
      return safeHandler("grade_with_rubric", async () => {
        const response = await writeGrade(args.course_identifier, args.assignment_id, args.user_id, {
          rubric_assessment: args.rubric_assessment,
          comment: args.comment,
        });
        return jsonResult(response, {
          summary: `Rubric-graded user ${args.user_id} on assignment ${args.assignment_id} (${Object.keys(args.rubric_assessment).length} criterion/criteria).`,
        });
      });
    },
  );

  server.registerTool(
    "grade_submission_with_rubric",
    {
      description:
        "Kitchen-sink grading write: posted_grade + rubric_assessment + comment in one Canvas call. Use when both a summary grade and a rubric assessment are needed.",
      inputSchema: GRADE_SUBMISSION_WITH_RUBRIC_INPUT,
    },
    async (input) => {
      const args = input as z.infer<z.ZodObject<typeof GRADE_SUBMISSION_WITH_RUBRIC_INPUT>>;
      return safeHandler("grade_submission_with_rubric", async () => {
        if (
          args.posted_grade === undefined &&
          (args.rubric_assessment === undefined || Object.keys(args.rubric_assessment).length === 0) &&
          !args.comment
        ) {
          throw new Error(
            "grade_submission_with_rubric: provide at least one of posted_grade, rubric_assessment, or comment.",
          );
        }
        const response = await writeGrade(args.course_identifier, args.assignment_id, args.user_id, {
          posted_grade: args.posted_grade,
          rubric_assessment: args.rubric_assessment,
          comment: args.comment,
        });
        return jsonResult(response, {
          summary: `Graded user ${args.user_id} on assignment ${args.assignment_id} with combined payload.`,
        });
      });
    },
  );

  server.registerTool(
    "bulk_grade_submissions",
    {
      description:
        "Grade many submissions at once. `grades` is keyed by real Canvas user_id with per-submission { posted_grade?, rubric_assessment?, comment? } decisions. dry_run=true returns would-be payloads without writing. Users with no current submission for the assignment land in skipped[].",
      inputSchema: BULK_GRADE_SUBMISSIONS_INPUT,
    },
    async (input) => {
      const args = input as z.infer<z.ZodObject<typeof BULK_GRADE_SUBMISSIONS_INPUT>>;
      return safeHandler("bulk_grade_submissions", async () => {
        const courseId = await canvas.resolveCourseId(args.course_identifier, { bypassCache: true });
        const maxConcurrent = args.max_concurrent ?? 5;
        const rateLimitMs = Math.round((args.rate_limit_delay ?? 1) * 1000);
        const dryRun = args.dry_run ?? false;

        // Phase 1: fetch all current submissions so we know which user_ids have one.
        const { items: existingSubmissions } = await canvas.getPaginated<{ user_id: number }>(
          `/api/v1/courses/${courseId}/assignments/${args.assignment_id}/submissions`,
        );
        const submitterIds = new Set(existingSubmissions.map((submission) => String(submission.user_id)));

        const userIds = Object.keys(args.grades);
        const stats = { graded: 0, failed: 0, skipped: 0 };
        const skipped: Array<{ user_id: string; reason: string }> = [];
        const failed: Array<{ user_id: string; error: string }> = [];
        const dryRunPayloads: Array<{ user_id: string; payload: Record<string, string> }> = [];
        const written: Array<{ user_id: string; response: GradeWriteResponse }> = [];
        const unprocessed: string[] = [];

        let aborted = false;

        outer: for (let offset = 0; offset < userIds.length; offset += maxConcurrent) {
          const batch = userIds.slice(offset, offset + maxConcurrent);
          const batchResults = await Promise.allSettled(
            batch.map(async (userId) => {
              const decision = args.grades[userId];
              if (!decision) {
                stats.skipped += 1;
                skipped.push({ user_id: userId, reason: "no decision provided" });
                return;
              }
              if (!submitterIds.has(userId)) {
                stats.skipped += 1;
                skipped.push({
                  user_id: userId,
                  reason: "no current submission for this assignment (stale roster snapshot)",
                });
                return;
              }
              if (dryRun) {
                const params = buildGradeFormData(decision);
                const payload: Record<string, string> = {};
                for (const [key, value] of params.entries()) payload[key] = value;
                dryRunPayloads.push({ user_id: userId, payload });
                stats.graded += 1; // count would-be writes
                return;
              }
              try {
                const response = await writeGrade(args.course_identifier, args.assignment_id, userId, decision);
                stats.graded += 1;
                written.push({ user_id: userId, response });
              } catch (error) {
                stats.failed += 1;
                const message =
                  error instanceof CanvasApiError
                    ? `${error.message}${error.canvasMessage ? ` — ${error.canvasMessage}` : ""}`
                    : error instanceof Error
                      ? error.message
                      : String(error);
                failed.push({ user_id: userId, error: message });
                // Treat rate-limit as a signal to stop the batch loop so unprocessed lands honestly.
                if (error instanceof CanvasApiError && error.code === "RATE_LIMITED") {
                  aborted = true;
                }
              }
            }),
          );
          // Surface unexpected rejections that escaped the per-call try/catch.
          for (const settled of batchResults) {
            if (settled.status === "rejected") {
              stats.failed += 1;
              failed.push({ user_id: "unknown", error: String(settled.reason) });
            }
          }
          if (aborted) {
            // Anything past this batch is unprocessed.
            for (let i = offset + maxConcurrent; i < userIds.length; i += 1) {
              const id = userIds[i];
              if (id !== undefined) unprocessed.push(id);
            }
            break outer;
          }
          if (offset + maxConcurrent < userIds.length && rateLimitMs > 0) {
            await sleep(rateLimitMs);
          }
        }

        return jsonResult(
          {
            course_id: courseId,
            assignment_id: args.assignment_id,
            total: userIds.length,
            graded: stats.graded,
            failed: stats.failed,
            skipped: stats.skipped,
            unprocessed_count: unprocessed.length,
            dry_run: dryRun,
            ...(dryRun ? { dry_run_payloads: dryRunPayloads } : { written }),
            failed_results: failed,
            skipped_results: skipped,
            unprocessed_user_ids: unprocessed,
          },
          {
            summary:
              `Assignment ${args.assignment_id}: ` +
              `${stats.graded} ${dryRun ? "would-be-graded" : "graded"}, ` +
              `${stats.failed} failed, ${stats.skipped} skipped` +
              (unprocessed.length ? `, ${unprocessed.length} unprocessed` : "") +
              `.`,
          },
        );
      });
    },
  );
}
