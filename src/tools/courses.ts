import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import type { CanvasClient } from "../canvasClient.js";
import { jsonResult, safeHandler } from "./toolHelpers.js";

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
