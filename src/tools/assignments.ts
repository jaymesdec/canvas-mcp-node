import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import type { CanvasClient } from "../canvasClient.js";
import type { Anonymizer } from "../anonymizer.js";
import { jsonResult, pickFields, safeHandler } from "./toolHelpers.js";
import { DEANON_DENIED_NOTE, resolveAnonymous } from "../featureFlags.js";
import { displaySubmission } from "./submissions.js";

const LIST_ASSIGNMENTS_INPUT = {
  course_identifier: z.union([z.string(), z.number()]),
  student_id: z
    .union([z.string(), z.number()])
    .optional()
    .describe("Optional Canvas user_id filter to scope the list (and submissions) to one student."),
  include: z
    .array(z.string())
    .optional()
    .describe("Canvas include[] tokens: e.g., 'submission', 'submission_history', 'all_dates', 'overrides'."),
  include_description: z
    .boolean()
    .optional()
    .describe("Include each assignment's HTML description. Defaults to false to keep responses compact."),
  published_only: z
    .boolean()
    .optional()
    .describe("If true, only published assignments are returned. Defaults to false."),
  anonymous: z
    .boolean()
    .optional()
    .describe(
      "When true (default), embedded student submissions/users are anonymized. Only relevant if include contains 'submission' or 'submission_history'.",
    ),
};

const SUBMISSION_TYPES_DESCRIPTION =
  "Allowed Canvas values: online_upload, online_text_entry, online_url, online_quiz, media_recording, " +
  "student_annotation, on_paper, external_tool, discussion_topic, wiki_page, none, not_graded.";

const CREATE_ASSIGNMENT_INPUT = {
  course_identifier: z.union([z.string(), z.number()]),
  name: z.string(),
  description: z.string().optional().describe("Assignment description HTML."),
  due_at: z.string().optional().describe("ISO-8601 due timestamp."),
  unlock_at: z.string().optional().describe("ISO-8601 timestamp when the assignment unlocks for students."),
  lock_at: z.string().optional().describe("ISO-8601 timestamp when the assignment locks."),
  points_possible: z.number().optional(),
  submission_types: z.array(z.string()).optional().describe(SUBMISSION_TYPES_DESCRIPTION),
};

const UPDATE_ASSIGNMENT_INPUT = {
  course_identifier: z.union([z.string(), z.number()]),
  assignment_id: z.union([z.string(), z.number()]),
  name: z.string().optional(),
  description: z.string().optional().describe("Assignment description HTML."),
  due_at: z.string().optional().describe("ISO-8601 due timestamp."),
  unlock_at: z.string().optional().describe("ISO-8601 timestamp when the assignment unlocks for students."),
  lock_at: z.string().optional().describe("ISO-8601 timestamp when the assignment locks."),
  points_possible: z.number().optional(),
  submission_types: z.array(z.string()).optional().describe(SUBMISSION_TYPES_DESCRIPTION),
};

const GET_ASSIGNMENT_DETAILS_INPUT = {
  course_identifier: z.union([z.string(), z.number()]),
  assignment_id: z.union([z.string(), z.number()]),
};

const GET_ASSIGNMENT_RUBRIC_DETAILS_INPUT = {
  course_identifier: z.union([z.string(), z.number()]),
  assignment_id: z.union([z.string(), z.number()]),
};

interface CanvasAssignment {
  id: number;
  name?: string;
  description?: string;
  due_at?: string | null;
  unlock_at?: string | null;
  lock_at?: string | null;
  points_possible?: number | null;
  submission_types?: string[];
  published?: boolean;
  workflow_state?: string;
  rubric?: Array<Record<string, unknown>> | null;
  rubric_settings?: Record<string, unknown> | null;
  submission?: Record<string, unknown> | null;
  submission_history?: Record<string, unknown>[] | null;
}

const ASSIGNMENT_DISPLAY_KEYS = [
  "id",
  "name",
  "due_at",
  "unlock_at",
  "lock_at",
  "points_possible",
  "published",
  "workflow_state",
  "submission_types",
] as const;

/**
 * Allowlist projection for a list_assignments row. Embedded submission data
 * must already be anonymized (R3a: anonymize first, trim second).
 */
function displayAssignment(
  assignment: CanvasAssignment,
  options: { includeDescription: boolean },
): Record<string, unknown> {
  const trimmed = pickFields(assignment as unknown as Record<string, unknown>, ASSIGNMENT_DISPLAY_KEYS);
  trimmed.has_rubric = Array.isArray(assignment.rubric)
    ? assignment.rubric.length > 0
    : Boolean(assignment.rubric);
  if (options.includeDescription) trimmed.description = assignment.description ?? null;
  if (assignment.submission && typeof assignment.submission === "object") {
    trimmed.submission = displaySubmission(assignment.submission);
  }
  if (Array.isArray(assignment.submission_history)) {
    trimmed.submission_history = assignment.submission_history.map((entry) =>
      entry && typeof entry === "object" ? displaySubmission(entry) : entry,
    );
  }
  return trimmed;
}

function isPublished(assignment: CanvasAssignment): boolean {
  return assignment.published === true || assignment.workflow_state === "published";
}

function submissionTypesMatch(requested: string[], returned: unknown): boolean {
  if (!Array.isArray(returned) || returned.length !== requested.length) return false;
  const returnedSet = new Set(returned);
  return requested.every((type) => returnedSet.has(type));
}

export function registerAssignmentTools(
  server: McpServer,
  canvas: CanvasClient,
  anonymizer: Anonymizer,
): void {
  server.registerTool(
    "list_assignments",
    {
      description:
        "List Canvas assignments in a course, trimmed to scheduling/grading fields (descriptions omitted unless include_description=true; published_only=true filters to published). include[]='submission' embeds the user's own (or `student_id`'s) submission. Anonymization wraps any embedded student data by default.",
      inputSchema: LIST_ASSIGNMENTS_INPUT,
    },
    async (input) => {
      const args = input as {
        course_identifier: string | number;
        student_id?: string | number;
        include?: string[];
        include_description?: boolean;
        published_only?: boolean;
        anonymous?: boolean;
      };
      return safeHandler("list_assignments", async () => {
        const courseId = await canvas.resolveCourseId(args.course_identifier);
        const params: Record<string, unknown> = {};
        if (args.include && args.include.length > 0) params["include[]"] = args.include;
        if (args.student_id !== undefined) params.user_id = args.student_id;

        const { items: fetchedAssignments, truncated, pages } = await canvas.getPaginated<CanvasAssignment>(
          `/api/v1/courses/${courseId}/assignments`,
          { params },
        );
        const assignments = args.published_only
          ? fetchedAssignments.filter(isPublished)
          : fetchedAssignments;

        const { anonymous, overridden } = resolveAnonymous(args.anonymous);
        const hasSubmissionInclude =
          Array.isArray(args.include) &&
          args.include.some((token) => token === "submission" || token === "submission_history");

        const finalAssignments = anonymous && hasSubmissionInclude
          ? await Promise.all(
              assignments.map(async (assignment) => {
                const copy: CanvasAssignment = { ...assignment };
                if (assignment.submission) {
                  copy.submission = await anonymizer.anonymizeSubmission(
                    courseId,
                    assignment.submission as Record<string, unknown>,
                  );
                }
                if (Array.isArray(assignment.submission_history)) {
                  copy.submission_history = await Promise.all(
                    assignment.submission_history.map((entry) =>
                      anonymizer.anonymizeSubmission(courseId, entry),
                    ),
                  );
                }
                return copy;
              }),
            )
          : assignments;
        const trimmedAssignments = finalAssignments.map((assignment) =>
          displayAssignment(assignment, { includeDescription: args.include_description ?? false }),
        );

        const warnings = overridden && hasSubmissionInclude ? [DEANON_DENIED_NOTE] : undefined;
        return jsonResult(
          {
            course_id: courseId,
            count: trimmedAssignments.length,
            pages,
            truncated,
            anonymized: anonymous && hasSubmissionInclude,
            ...(warnings ? { warnings } : {}),
            assignments: trimmedAssignments,
          },
          {
            summary:
              `Course ${courseId}: ${trimmedAssignments.length} assignment(s).` +
              (overridden && hasSubmissionInclude ? ` [override: ${DEANON_DENIED_NOTE}]` : ""),
          },
        );
      });
    },
  );

  server.registerTool(
    "create_assignment",
    {
      description:
        "Create a new Canvas assignment as a draft (published is forced false per the cross-project never-auto-publish rule — teacher publishes after review). Bypasses the course-code cache so a rename mid-session can't misroute the write. " +
        SUBMISSION_TYPES_DESCRIPTION,
      inputSchema: CREATE_ASSIGNMENT_INPUT,
    },
    async (input) => {
      const args = input as z.infer<z.ZodObject<typeof CREATE_ASSIGNMENT_INPUT>>;
      return safeHandler("create_assignment", async () => {
        const courseId = await canvas.resolveCourseId(args.course_identifier, { bypassCache: true });

        const assignmentPayload: Record<string, unknown> = { name: args.name, published: false };
        if (args.description !== undefined) assignmentPayload.description = args.description;
        if (args.due_at !== undefined) assignmentPayload.due_at = args.due_at;
        if (args.unlock_at !== undefined) assignmentPayload.unlock_at = args.unlock_at;
        if (args.lock_at !== undefined) assignmentPayload.lock_at = args.lock_at;
        if (args.points_possible !== undefined) assignmentPayload.points_possible = args.points_possible;
        if (args.submission_types !== undefined) assignmentPayload.submission_types = args.submission_types;

        const created = await canvas.post<CanvasAssignment>(
          `/api/v1/courses/${courseId}/assignments`,
          { assignment: assignmentPayload },
        );

        return jsonResult(
          {
            course_id: courseId,
            assignment: displayAssignment(created, { includeDescription: false }),
          },
          {
            summary: `Created draft assignment "${created.name ?? args.name}" (id ${created.id}) in course ${courseId}. Assignment is unpublished — teacher publishes manually after review.`,
          },
        );
      });
    },
  );

  server.registerTool(
    "update_assignment",
    {
      description:
        "Update fields on an existing Canvas assignment. Sends only the provided fields and never touches the published state. " +
        "Caveat: Canvas silently ignores submission_types changes once an assignment has student submissions — the response is checked and a warning is returned when that happens. " +
        SUBMISSION_TYPES_DESCRIPTION,
      inputSchema: UPDATE_ASSIGNMENT_INPUT,
    },
    async (input) => {
      const args = input as z.infer<z.ZodObject<typeof UPDATE_ASSIGNMENT_INPUT>>;
      return safeHandler("update_assignment", async () => {
        const assignmentPayload: Record<string, unknown> = {};
        if (args.name !== undefined) assignmentPayload.name = args.name;
        if (args.description !== undefined) assignmentPayload.description = args.description;
        if (args.due_at !== undefined) assignmentPayload.due_at = args.due_at;
        if (args.unlock_at !== undefined) assignmentPayload.unlock_at = args.unlock_at;
        if (args.lock_at !== undefined) assignmentPayload.lock_at = args.lock_at;
        if (args.points_possible !== undefined) assignmentPayload.points_possible = args.points_possible;
        if (args.submission_types !== undefined) assignmentPayload.submission_types = args.submission_types;
        if (Object.keys(assignmentPayload).length === 0) {
          throw new Error(
            "update_assignment: provide at least one field to update (name/description/due_at/unlock_at/lock_at/points_possible/submission_types).",
          );
        }

        const courseId = await canvas.resolveCourseId(args.course_identifier, { bypassCache: true });
        const updated = await canvas.put<CanvasAssignment>(
          `/api/v1/courses/${courseId}/assignments/${args.assignment_id}`,
          { assignment: assignmentPayload },
        );

        const warnings: string[] = [];
        if (
          args.submission_types !== undefined &&
          !submissionTypesMatch(args.submission_types, updated.submission_types)
        ) {
          warnings.push(
            `Canvas ignored the requested submission_types change (requested: [${args.submission_types.join(", ")}], returned: [${(updated.submission_types ?? []).join(", ")}]). Canvas silently rejects submission_types edits once an assignment has student submissions.`,
          );
        }

        return jsonResult(
          {
            course_id: courseId,
            assignment: displayAssignment(updated, { includeDescription: args.description !== undefined }),
            ...(warnings.length > 0 ? { warnings } : {}),
          },
          {
            summary:
              `Updated assignment ${args.assignment_id} ("${updated.name ?? ""}") in course ${courseId}.` +
              (warnings.length > 0 ? " [warning: submission_types change ignored by Canvas]" : ""),
          },
        );
      });
    },
  );

  server.registerTool(
    "get_assignment_details",
    {
      description: "Fetch full metadata for a single Canvas assignment (due_at, points_possible, submission_types, ...).",
      inputSchema: GET_ASSIGNMENT_DETAILS_INPUT,
    },
    async (input) => {
      const args = input as { course_identifier: string | number; assignment_id: string | number };
      return safeHandler("get_assignment_details", async () => {
        const courseId = await canvas.resolveCourseId(args.course_identifier);
        const assignment = await canvas.get<CanvasAssignment>(
          `/api/v1/courses/${courseId}/assignments/${args.assignment_id}`,
        );
        return jsonResult(assignment, {
          summary: `Assignment ${args.assignment_id}: "${assignment.name ?? ""}"`,
        });
      });
    },
  );

  server.registerTool(
    "get_assignment_rubric_details",
    {
      description:
        "Fetch only the rubric portion of an assignment. Returns { rubric: null, message } when the assignment has no rubric attached.",
      inputSchema: GET_ASSIGNMENT_RUBRIC_DETAILS_INPUT,
    },
    async (input) => {
      const args = input as { course_identifier: string | number; assignment_id: string | number };
      return safeHandler("get_assignment_rubric_details", async () => {
        const courseId = await canvas.resolveCourseId(args.course_identifier);
        const assignment = await canvas.get<CanvasAssignment>(
          `/api/v1/courses/${courseId}/assignments/${args.assignment_id}`,
          { params: { "include[]": ["rubric"] } },
        );
        if (!assignment.rubric || (Array.isArray(assignment.rubric) && assignment.rubric.length === 0)) {
          return jsonResult(
            { assignment_id: args.assignment_id, rubric: null, message: "No rubric attached to this assignment." },
            { summary: `Assignment ${args.assignment_id} has no rubric.` },
          );
        }
        return jsonResult(
          {
            assignment_id: args.assignment_id,
            rubric: assignment.rubric,
            rubric_settings: assignment.rubric_settings ?? null,
          },
          {
            summary: `Assignment ${args.assignment_id}: rubric has ${assignment.rubric.length} criterion/criteria.`,
          },
        );
      });
    },
  );
}
