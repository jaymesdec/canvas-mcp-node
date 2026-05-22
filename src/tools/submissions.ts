import { promises as fs } from "node:fs";
import * as path from "node:path";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import type { CanvasClient } from "../canvasClient.js";
import type { Anonymizer } from "../anonymizer.js";
import { CanvasApiError } from "../types.js";
import { DEANON_DENIED_NOTE, isDeanonymizationAllowed } from "../featureFlags.js";
import { jsonResult, safeHandler } from "./toolHelpers.js";

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

function resolveAnonymous(requested: boolean | undefined): { anonymous: boolean; overridden: boolean } {
  const wantedAnonymous = requested ?? true;
  if (wantedAnonymous === false && !isDeanonymizationAllowed()) {
    return { anonymous: true, overridden: true };
  }
  return { anonymous: wantedAnonymous, overridden: false };
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
        const params = {
          "include[]": buildSubmissionIncludeTokens(args),
        };

        const { items: submissions, truncated, pages } = await canvas.getPaginated<CanvasSubmission>(
          `/api/v1/courses/${courseId}/assignments/${args.assignment_id}/submissions`,
          { params },
        );

        const finalSubmissions = anonymous
          ? ((await Promise.all(
              submissions.map((submission) =>
                anonymizer.anonymizeSubmission(courseId, submission as unknown as Record<string, unknown>),
              ),
            )) as unknown as CanvasSubmission[])
          : submissions;

        const warnings = overridden ? [DEANON_DENIED_NOTE] : undefined;
        return jsonResult(
          {
            course_id: courseId,
            assignment_id: args.assignment_id,
            count: finalSubmissions.length,
            pages,
            truncated,
            anonymized: anonymous,
            ...(warnings ? { warnings } : {}),
            submissions: finalSubmissions,
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
