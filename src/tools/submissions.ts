import { promises as fs } from "node:fs";
import * as path from "node:path";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import type { CanvasClient } from "../canvasClient.js";
import type { Anonymizer } from "../anonymizer.js";
import { CanvasApiError, type CanvasUserLite } from "../types.js";
import { DEANON_DENIED_NOTE, resolveAnonymous } from "../featureFlags.js";
import { jsonResult, pickFields, safeHandler } from "./toolHelpers.js";
import { buildStaffIdSet } from "./roster.js";

const LIST_SUBMISSIONS_INPUT = {
  course_identifier: z.union([z.string(), z.number()]),
  assignment_id: z.union([z.string(), z.number()]),
  include_rubric_assessment: z
    .boolean()
    .optional()
    .describe("Include[]=rubric_assessment. Defaults to true."),
  include_submission_comments: z
    .boolean()
    .optional()
    .describe("Include[]=submission_comments. Defaults to true."),
  anonymous: z
    .boolean()
    .optional()
    .describe(
      "When true (default), student names/emails in submitter and submission_comments are pseudonymized. Override only takes effect when CANVAS_MCP_ALLOW_DEANONYMIZE=true on the server.",
    ),
};

const GET_SUBMISSION_RUBRIC_ASSESSMENT_INPUT = {
  course_identifier: z.union([z.string(), z.number()]),
  assignment_id: z.union([z.string(), z.number()]),
  user_id: z.union([z.string(), z.number()]).describe("Real Canvas user_id (not a pseudonym)."),
};

const DOWNLOAD_SUBMISSION_ATTACHMENT_INPUT = {
  course_identifier: z.union([z.string(), z.number()]),
  assignment_id: z.union([z.string(), z.number()]),
  user_id: z.union([z.string(), z.number()]),
  attachment_id: z
    .union([z.string(), z.number()])
    .optional()
    .describe("Optional — download only this attachment id. If omitted, downloads every attachment on the submission."),
  target_dir: z
    .string()
    .optional()
    .describe("Where to write files. Defaults to ./submissions/{courseCode|courseId}/{assignmentId}/"),
};

interface CanvasSubmissionAttachment {
  id: number;
  filename: string;
  display_name?: string;
  url: string;
  content_type?: string;
  size?: number;
}

interface CanvasSubmission {
  id: number;
  user_id: number;
  assignment_id: number;
  workflow_state?: string;
  submitted_at?: string | null;
  grade?: string | null;
  score?: number | null;
  attempt?: number;
  attachments?: CanvasSubmissionAttachment[];
  submission_comments?: Array<Record<string, unknown>>;
  rubric_assessment?: Record<string, { points?: number; rating_id?: string; comments?: string }> | null;
  user?: Record<string, unknown>;
}

interface CanvasAssignmentRubric {
  id: number;
  rubric?: Array<{ id: string; description?: string; long_description?: string; points?: number }> | null;
  rubric_settings?: Record<string, unknown> | null;
}

const SUBMISSION_DISPLAY_KEYS = [
  "id",
  "user_id",
  "workflow_state",
  "submitted_at",
  "late",
  "missing",
  "grade",
  "score",
  "attempt",
] as const;

const SUBMISSION_USER_DISPLAY_KEYS = ["id", "name", "email"] as const;

const ATTACHMENT_DISPLAY_KEYS = ["id", "filename", "display_name", "content_type", "size"] as const;

const COMMENT_DISPLAY_KEYS = ["id", "author_id", "author_name", "comment", "created_at"] as const;

function displaySubmissionComment(comment: Record<string, unknown>): Record<string, unknown> {
  const trimmed = pickFields(comment, COMMENT_DISPLAY_KEYS);
  if (trimmed.author_name === null && comment.author && typeof comment.author === "object") {
    const author = comment.author as Record<string, unknown>;
    trimmed.author_name = author.display_name ?? author.name ?? null;
  }
  if (comment.attempt !== undefined && comment.attempt !== null) trimmed.attempt = comment.attempt;
  return trimmed;
}

/**
 * Allowlist projection for a submission. MUST run on the anonymizer's output,
 * never the raw Canvas payload (R3a: anonymize first, trim second).
 */
export function displaySubmission(submission: Record<string, unknown>): Record<string, unknown> {
  const trimmed = pickFields(submission, SUBMISSION_DISPLAY_KEYS);
  const user = submission.user;
  trimmed.user =
    user && typeof user === "object"
      ? pickFields(user as Record<string, unknown>, SUBMISSION_USER_DISPLAY_KEYS)
      : null;
  const attachments = Array.isArray(submission.attachments) ? submission.attachments : [];
  trimmed.attachments = attachments.map((attachment) =>
    attachment && typeof attachment === "object"
      ? pickFields(attachment as Record<string, unknown>, ATTACHMENT_DISPLAY_KEYS)
      : attachment,
  );
  trimmed.rubric_assessment = submission.rubric_assessment ?? null;
  const comments = Array.isArray(submission.submission_comments) ? submission.submission_comments : [];
  trimmed.submission_comments = comments.map((comment) =>
    comment && typeof comment === "object"
      ? displaySubmissionComment(comment as Record<string, unknown>)
      : comment,
  );
  return trimmed;
}

const UNKNOWN_COMMENTER_PLACEHOLDER = "Unknown commenter";

/**
 * Fail-closed comment-author pass. Real Canvas comment authors are UserDisplay
 * objects with no role data, so classifyRole alone can't distinguish a teacher
 * from a student — classify against the course's staff roster instead: staff
 * ids keep real attribution, every other author is pseudonymized (author ids
 * are never anonymized). Authors with no id at all get a fixed placeholder
 * name — never verbatim, never a map allocation.
 */
export async function anonymizeNonStaffCommentAuthors(
  anonymizer: Anonymizer,
  courseId: number,
  submission: Record<string, unknown>,
  staffIds: Set<string>,
): Promise<Record<string, unknown>> {
  const comments = submission.submission_comments;
  if (!Array.isArray(comments)) return submission;

  const updated = await Promise.all(
    comments.map(async (rawComment) => {
      if (!rawComment || typeof rawComment !== "object") return rawComment;
      const comment = rawComment as Record<string, unknown>;
      const author = comment.author as CanvasUserLite | undefined;
      const rawAuthorId: unknown = author?.id ?? comment.author_id;
      const authorId =
        typeof rawAuthorId === "number" || typeof rawAuthorId === "string" ? rawAuthorId : null;
      if (authorId === null) {
        if (comment.author_name === undefined && comment.author === undefined) return comment;
        return { ...comment, author: null, author_name: UNKNOWN_COMMENTER_PLACEHOLDER };
      }
      if (staffIds.has(String(authorId))) return comment;

      const sourceAuthor: CanvasUserLite = author ?? {
        id: authorId,
        name: typeof comment.author_name === "string" ? comment.author_name : undefined,
      };
      const anonymizedAuthor = await anonymizer.anonymizeUser(courseId, sourceAuthor, {
        unknownRolePolicy: "student",
      });
      if (anonymizedAuthor === sourceAuthor && author) return comment;
      const scrubbedAuthor: CanvasUserLite = { ...anonymizedAuthor };
      if ("display_name" in scrubbedAuthor) scrubbedAuthor.display_name = anonymizedAuthor.name;
      return {
        ...comment,
        author: scrubbedAuthor,
        author_id: authorId,
        author_name: anonymizedAuthor.name,
      };
    }),
  );
  return { ...submission, submission_comments: updated };
}

/** Build the include[] tokens list for list_submissions. */
function buildSubmissionIncludeTokens(input: {
  include_rubric_assessment?: boolean;
  include_submission_comments?: boolean;
}): string[] {
  const tokens = ["user"]; // always need user for anonymization + role classification
  if (input.include_rubric_assessment ?? true) tokens.push("rubric_assessment");
  if (input.include_submission_comments ?? true) tokens.push("submission_comments");
  return tokens;
}

export function registerSubmissionTools(
  server: McpServer,
  canvas: CanvasClient,
  anonymizer: Anonymizer,
): void {
  server.registerTool(
    "list_submissions",
    {
      description:
        "List submissions for a Canvas assignment. Embedded student data is anonymized by default (FERPA gate); set anonymous=false only with CANVAS_MCP_ALLOW_DEANONYMIZE=true on the server.",
      inputSchema: LIST_SUBMISSIONS_INPUT,
    },
    async (input) => {
      const args = input as {
        course_identifier: string | number;
        assignment_id: string | number;
        include_rubric_assessment?: boolean;
        include_submission_comments?: boolean;
        anonymous?: boolean;
      };
      return safeHandler("list_submissions", async () => {
        const courseId = await canvas.resolveCourseId(args.course_identifier);
        const { anonymous, overridden } = resolveAnonymous(args.anonymous);
        const commentsIncluded = args.include_submission_comments ?? true;
        const params = {
          "include[]": buildSubmissionIncludeTokens(args),
        };

        const { items: submissions, truncated, pages } = await canvas.getPaginated<CanvasSubmission>(
          `/api/v1/courses/${courseId}/assignments/${args.assignment_id}/submissions`,
          { params },
        );

        let finalSubmissions: Record<string, unknown>[] = submissions as unknown as Record<
          string,
          unknown
        >[];
        if (anonymous) {
          finalSubmissions = await Promise.all(
            finalSubmissions.map((submission) => anonymizer.anonymizeSubmission(courseId, submission)),
          );
          const hasAnyComments = finalSubmissions.some(
            (submission) =>
              Array.isArray(submission.submission_comments) && submission.submission_comments.length > 0,
          );
          if (commentsIncluded && hasAnyComments) {
            const staffIds = await buildStaffIdSet(canvas, courseId);
            finalSubmissions = await Promise.all(
              finalSubmissions.map((submission) =>
                anonymizeNonStaffCommentAuthors(anonymizer, courseId, submission, staffIds),
              ),
            );
          }
        }
        const trimmedSubmissions = finalSubmissions.map(displaySubmission);

        const warnings = overridden ? [DEANON_DENIED_NOTE] : undefined;
        return jsonResult(
          {
            course_id: courseId,
            assignment_id: args.assignment_id,
            count: trimmedSubmissions.length,
            pages,
            truncated,
            anonymized: anonymous,
            ...(warnings ? { warnings } : {}),
            submissions: trimmedSubmissions,
          },
          {
            summary:
              `Assignment ${args.assignment_id}: ${finalSubmissions.length} submission(s)${anonymous ? " (anonymized)" : ""}.` +
              (overridden ? ` [override: ${DEANON_DENIED_NOTE}]` : ""),
          },
        );
      });
    },
  );

  server.registerTool(
    "get_submission_rubric_assessment",
    {
      description:
        "Fetch only the rubric_assessment block for one submission, joined with criterion descriptions from the assignment's rubric for readability.",
      inputSchema: GET_SUBMISSION_RUBRIC_ASSESSMENT_INPUT,
    },
    async (input) => {
      const args = input as {
        course_identifier: string | number;
        assignment_id: string | number;
        user_id: string | number;
      };
      return safeHandler("get_submission_rubric_assessment", async () => {
        const courseId = await canvas.resolveCourseId(args.course_identifier);

        // Fetch assignment rubric + submission in parallel.
        const [assignment, submission] = await Promise.all([
          canvas.get<CanvasAssignmentRubric>(
            `/api/v1/courses/${courseId}/assignments/${args.assignment_id}`,
            { params: { "include[]": ["rubric"] } },
          ),
          canvas.get<CanvasSubmission>(
            `/api/v1/courses/${courseId}/assignments/${args.assignment_id}/submissions/${args.user_id}`,
            { params: { "include[]": ["rubric_assessment"] } },
          ),
        ]);

        const rubricByCriterionId = new Map<string, { description?: string; points?: number }>();
        for (const criterion of assignment.rubric ?? []) {
          if (criterion.id) {
            rubricByCriterionId.set(criterion.id, {
              description: criterion.description ?? criterion.long_description,
              points: criterion.points,
            });
          }
        }

        const assessment = submission.rubric_assessment ?? null;
        const joined = assessment
          ? Object.entries(assessment).map(([criterionId, value]) => {
              const meta = rubricByCriterionId.get(criterionId);
              return {
                criterion_id: criterionId,
                description: meta?.description ?? null,
                points_possible: meta?.points ?? null,
                points: value?.points ?? null,
                rating_id: value?.rating_id ?? null,
                comments: value?.comments ?? null,
              };
            })
          : null;

        if (!joined) {
          return jsonResult(
            {
              course_id: courseId,
              assignment_id: args.assignment_id,
              user_id: args.user_id,
              rubric_assessment: null,
              message: "No rubric assessment recorded for this submission yet.",
            },
            {
              summary: `User ${args.user_id} on assignment ${args.assignment_id}: no rubric assessment.`,
            },
          );
        }

        return jsonResult(
          {
            course_id: courseId,
            assignment_id: args.assignment_id,
            user_id: args.user_id,
            criterion_count: joined.length,
            rubric_assessment: joined,
          },
          {
            summary: `User ${args.user_id} on assignment ${args.assignment_id}: ${joined.length} criterion assessment(s).`,
          },
        );
      });
    },
  );

  server.registerTool(
    "download_submission_attachment",
    {
      description:
        "Download a submission's attachments to disk. Streams via the Canvas-provided URL with bearer auth. Defaults target_dir to ./submissions/{courseCode|courseId}/{assignmentId}/.",
      inputSchema: DOWNLOAD_SUBMISSION_ATTACHMENT_INPUT,
    },
    async (input) => {
      const args = input as {
        course_identifier: string | number;
        assignment_id: string | number;
        user_id: string | number;
        attachment_id?: string | number;
        target_dir?: string;
      };
      return safeHandler("download_submission_attachment", async () => {
        const courseId = await canvas.resolveCourseId(args.course_identifier);
        const submission = await canvas.get<CanvasSubmission>(
          `/api/v1/courses/${courseId}/assignments/${args.assignment_id}/submissions/${args.user_id}`,
        );

        const attachments = submission.attachments ?? [];
        if (attachments.length === 0) {
          return jsonResult(
            {
              course_id: courseId,
              assignment_id: args.assignment_id,
              user_id: args.user_id,
              files: [],
              message: "No attachments on this submission.",
            },
            {
              summary: `User ${args.user_id} on assignment ${args.assignment_id}: no attachments.`,
            },
          );
        }

        const selected = args.attachment_id !== undefined
          ? attachments.filter((file) => String(file.id) === String(args.attachment_id))
          : attachments;
        if (selected.length === 0) {
          throw new CanvasApiError({
            code: "NOT_FOUND",
            message: `download_submission_attachment: attachment_id ${args.attachment_id} not found on submission.`,
          });
        }

        const courseLabel = canvas.getCachedCourseCode(courseId) ?? String(courseId);
        const baseDir = path.resolve(
          args.target_dir ?? path.join(process.cwd(), "submissions", courseLabel, String(args.assignment_id)),
        );
        await fs.mkdir(baseDir, { recursive: true });

        const written: Array<{ attachment_id: number; filename: string; path: string; size: number }> = [];
        for (const attachment of selected) {
          const response = await canvas.request<ArrayBuffer>("GET", attachment.url, {
            responseType: "arraybuffer",
          });
          const buffer = Buffer.from(response.data as ArrayBuffer);
          const safeName = attachment.display_name ?? attachment.filename ?? `attachment-${attachment.id}`;
          const filename = `${args.user_id}-${safeName}`;
          const filePath = path.join(baseDir, filename);
          await fs.writeFile(filePath, buffer);
          written.push({
            attachment_id: attachment.id,
            filename,
            path: filePath,
            size: buffer.byteLength,
          });
        }

        return jsonResult(
          {
            course_id: courseId,
            assignment_id: args.assignment_id,
            user_id: args.user_id,
            target_dir: baseDir,
            files: written,
          },
          {
            summary: `Wrote ${written.length} file(s) for user ${args.user_id} to ${baseDir}.`,
          },
        );
      });
    },
  );
}
