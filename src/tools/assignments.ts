import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import type { CanvasClient } from "../canvasClient.js";
import type { Anonymizer } from "../anonymizer.js";
import { jsonResult, safeHandler } from "./toolHelpers.js";

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
  anonymous: z
    .boolean()
    .optional()
    .describe(
      "When true (default), embedded student submissions/users are anonymized. Only relevant if include contains 'submission' or 'submission_history'.",
    ),
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
  points_possible?: number | null;
  submission_types?: string[];
  workflow_state?: string;
  rubric?: Array<Record<string, unknown>> | null;
  rubric_settings?: Record<string, unknown> | null;
  submission?: Record<string, unknown> | null;
  submission_history?: Record<string, unknown>[] | null;
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
        "List Canvas assignments in a course. include[]='submission' embeds the user's own (or `student_id`'s) submission. Anonymization wraps any embedded student data by default.",
      inputSchema: LIST_ASSIGNMENTS_INPUT,
    },
    async (input) => {
      const args = input as {
        course_identifier: string | number;
        student_id?: string | number;
        include?: string[];
        anonymous?: boolean;
      };
      return safeHandler("list_assignments", async () => {
        const courseId = await canvas.resolveCourseId(args.course_identifier);
        const params: Record<string, unknown> = {};
        if (args.include && args.include.length > 0) params["include[]"] = args.include;
        if (args.student_id !== undefined) params.user_id = args.student_id;

        const { items: assignments, truncated, pages } = await canvas.getPaginated<CanvasAssignment>(
          `/api/v1/courses/${courseId}/assignments`,
          { params },
        );

        const anonymous = args.anonymous ?? true;
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

        return jsonResult(
          {
            course_id: courseId,
            count: finalAssignments.length,
            pages,
            truncated,
            anonymized: anonymous && hasSubmissionInclude,
            assignments: finalAssignments,
          },
          { summary: `Course ${courseId}: ${finalAssignments.length} assignment(s).` },
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
