import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import type { CanvasClient } from "../canvasClient.js";
import { CanvasApiError } from "../types.js";
import { jsonResult, safeHandler } from "./toolHelpers.js";

/**
 * Resolve an account_id from the tool argument or the CANVAS_ACCOUNT_ID env var,
 * with a clear error when neither is set. Shared between list_account_courses
 * and (eventually) list_account_users.
 */
export function resolveAccountId(argId: string | number | undefined): string {
  if (argId !== undefined && String(argId).trim() !== "") return String(argId).trim();
  const fromEnv = process.env.CANVAS_ACCOUNT_ID?.trim();
  if (fromEnv) return fromEnv;
  throw new Error(
    "account_id is required. Pass it explicitly or set CANVAS_ACCOUNT_ID in the MCP server env (e.g., 'self' or a numeric id like 1).",
  );
}

interface CanvasCourseLite {
  id: number;
  name?: string;
  course_code?: string;
  workflow_state?: string;
  term?: { name?: string } | null;
  start_at?: string | null;
  end_at?: string | null;
  enrollment_term_id?: number;
}

function displayCourse(course: CanvasCourseLite): {
  course_code: string | null;
  id: number;
  name: string | null;
  workflow_state: string | null;
  term: string | null;
} {
  return {
    course_code: course.course_code ?? null,
    id: course.id,
    name: course.name ?? null,
    workflow_state: course.workflow_state ?? null,
    term: course.term?.name ?? null,
  };
}

const LIST_COURSES_INPUT = {
  enrollment_state: z
    .enum(["active", "invited_or_pending", "completed"])
    .optional()
    .describe("Canvas enrollment_state filter; defaults to 'active'."),
  include: z
    .array(z.string())
    .optional()
    .describe("Additional Canvas include[] tokens (e.g., 'term', 'total_students')."),
};

const LIST_ACCOUNT_COURSES_INPUT = {
  account_id: z
    .union([z.string(), z.number()])
    .optional()
    .describe("Canvas account id. Defaults to CANVAS_ACCOUNT_ID env var if set. Use 'self' for the token's own account."),
  search_term: z
    .string()
    .optional()
    .describe("Free-text search across course name and course_code. Canvas requires at least 2 characters."),
  enrollment_term_id: z
    .union([z.string(), z.number()])
    .optional()
    .describe("Restrict to a single term."),
  state: z
    .array(z.enum(["created", "claimed", "available", "completed", "deleted"]))
    .optional()
    .describe("workflow_state[] filter. Defaults to ['available'] when omitted."),
  published: z.boolean().optional().describe("If true, only published courses; if false, only unpublished."),
  with_enrollments: z
    .boolean()
    .optional()
    .describe("If true, only courses with active enrollments. If false, only empty courses."),
  include: z
    .array(z.string())
    .optional()
    .describe("Canvas include[] tokens: e.g., 'term', 'teachers', 'total_students', 'concluded'."),
};

const GET_COURSE_DETAILS_INPUT = {
  course_identifier: z
    .union([z.string(), z.number()])
    .describe("Canvas course code (e.g., 'BADM_554_120251_246794') or numeric course id."),
  include: z
    .array(z.string())
    .optional()
    .describe("Additional Canvas include[] tokens (e.g., 'syllabus_body', 'term')."),
};

export function registerCourseTools(server: McpServer, canvas: CanvasClient): void {
  server.registerTool(
    "list_courses",
    {
      description:
        "List all Canvas courses the authenticated user is enrolled in. Output prefers course_code over numeric id per Franklin School conventions.",
      inputSchema: LIST_COURSES_INPUT,
    },
    async (input) => {
      const args = input as { enrollment_state?: string; include?: string[] };
      return safeHandler("list_courses", async () => {
        const params: Record<string, unknown> = {
          enrollment_state: args.enrollment_state ?? "active",
        };
        if (args.include && args.include.length > 0) params["include[]"] = args.include;

        const { items, truncated, pages } = await canvas.getPaginated<CanvasCourseLite>(
          "/api/v1/courses",
          { params },
        );

        const courses = items.map(displayCourse);
        return jsonResult(
          { count: courses.length, pages, truncated, courses },
          { summary: `Found ${courses.length} course(s) (across ${pages} page(s)${truncated ? ", truncated" : ""}).` },
        );
      });
    },
  );

  server.registerTool(
    "list_account_courses",
    {
      description:
        "Search the full course catalog at the account level. Requires account-admin scope on the Canvas token. Defaults account_id from CANVAS_ACCOUNT_ID env var when not passed. Returns paginated results with course_code preferred in summary.",
      inputSchema: LIST_ACCOUNT_COURSES_INPUT,
    },
    async (input) => {
      const args = input as {
        account_id?: string | number;
        search_term?: string;
        enrollment_term_id?: string | number;
        state?: string[];
        published?: boolean;
        with_enrollments?: boolean;
        include?: string[];
      };
      return safeHandler("list_account_courses", async () => {
        const accountId = resolveAccountId(args.account_id);
        const params: Record<string, unknown> = {};
        if (args.search_term) params.search_term = args.search_term;
        if (args.enrollment_term_id !== undefined) params.enrollment_term_id = args.enrollment_term_id;
        if (args.state && args.state.length > 0) params["state[]"] = args.state;
        if (args.published !== undefined) params.published = args.published;
        if (args.with_enrollments !== undefined) params.with_enrollments = args.with_enrollments;
        if (args.include && args.include.length > 0) params["include[]"] = args.include;

        let items: CanvasCourseLite[];
        let truncated: boolean;
        let pages: number;
        try {
          const result = await canvas.getPaginated<CanvasCourseLite>(
            `/api/v1/accounts/${accountId}/courses`,
            { params },
          );
          items = result.items;
          truncated = result.truncated;
          pages = result.pages;
        } catch (error) {
          if (
            error instanceof CanvasApiError &&
            (error.code === "UNAUTHORIZED" || error.code === "FORBIDDEN")
          ) {
            throw new CanvasApiError({
              code: error.code,
              status: error.status,
              message:
                `list_account_courses requires account-admin scope on the Canvas token (account_id=${accountId}). ` +
                `The current token is missing the necessary permissions, or the account_id is wrong.`,
              endpoint: error.endpoint,
            });
          }
          throw error;
        }

        const courses = items.map(displayCourse);
        return jsonResult(
          {
            account_id: accountId,
            count: courses.length,
            pages,
            truncated,
            courses,
          },
          {
            summary:
              `Account ${accountId}: ${courses.length} course(s) across ${pages} page(s)${
                truncated ? ", truncated" : ""
              }${args.search_term ? ` matching "${args.search_term}"` : ""}.`,
          },
        );
      });
    },
  );

  server.registerTool(
    "get_course_details",
    {
      description:
        "Fetch detailed information for a single Canvas course. Accepts either a course code or numeric id.",
      inputSchema: GET_COURSE_DETAILS_INPUT,
    },
    async (input) => {
      const args = input as { course_identifier: string | number; include?: string[] };
      return safeHandler("get_course_details", async () => {
        const courseId = await canvas.resolveCourseId(args.course_identifier);
        const params: Record<string, unknown> = {};
        if (args.include && args.include.length > 0) params["include[]"] = args.include;

        const course = await canvas.get<CanvasCourseLite>(`/api/v1/courses/${courseId}`, {
          params,
        });
        return jsonResult(course, {
          summary: `Course ${course.course_code ?? courseId}: ${course.name ?? "(no name)"}`,
        });
      });
    },
  );
}
