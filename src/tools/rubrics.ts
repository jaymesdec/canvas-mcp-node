import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import type { CanvasClient } from "../canvasClient.js";
import { jsonResult, safeHandler } from "./toolHelpers.js";

const LIST_ALL_RUBRICS_INPUT = {
  course_identifier: z.union([z.string(), z.number()]),
  include_criteria: z
    .boolean()
    .optional()
    .describe("If true (default), return full criterion list per rubric. If false, only id/title/points."),
};

const GET_RUBRIC_DETAILS_INPUT = {
  course_identifier: z.union([z.string(), z.number()]),
  rubric_id: z.union([z.string(), z.number()]),
};

interface CanvasRubric {
  id: number;
  title: string;
  points_possible?: number;
  data?: Array<Record<string, unknown>>;
  reusable?: boolean;
  read_only?: boolean;
  context_type?: string;
}

export function registerRubricTools(server: McpServer, canvas: CanvasClient): void {
  server.registerTool(
    "list_all_rubrics",
    {
      description:
        "List all rubrics in a Canvas course. Per-course only, matching the Python MCP's signature (rubrics.py:888).",
      inputSchema: LIST_ALL_RUBRICS_INPUT,
    },
    async (input) => {
      const args = input as { course_identifier: string | number; include_criteria?: boolean };
      return safeHandler("list_all_rubrics", async () => {
        const courseId = await canvas.resolveCourseId(args.course_identifier);
        const { items: rubrics, truncated, pages } = await canvas.getPaginated<CanvasRubric>(
          `/api/v1/courses/${courseId}/rubrics`,
        );

        if (rubrics.length === 0) {
          return jsonResult(
            { course_id: courseId, count: 0, rubrics: [], message: `No rubrics found for course ${courseId}.` },
            { summary: `No rubrics in course ${courseId}.` },
          );
        }

        const includeCriteria = args.include_criteria ?? true;
        const formatted = rubrics.map((rubric) => {
          const summary: Record<string, unknown> = {
            id: rubric.id,
            title: rubric.title,
            points_possible: rubric.points_possible ?? null,
          };
          if (includeCriteria) summary.criteria = rubric.data ?? [];
          return summary;
        });

        return jsonResult(
          { course_id: courseId, count: rubrics.length, pages, truncated, rubrics: formatted },
          { summary: `Course ${courseId}: ${rubrics.length} rubric(s).` },
        );
      });
    },
  );

  server.registerTool(
    "get_rubric_details",
    {
      description: "Fetch full criterion + rating details for a single Canvas rubric scoped to a course.",
      inputSchema: GET_RUBRIC_DETAILS_INPUT,
    },
    async (input) => {
      const args = input as { course_identifier: string | number; rubric_id: string | number };
      return safeHandler("get_rubric_details", async () => {
        const courseId = await canvas.resolveCourseId(args.course_identifier);
        const rubric = await canvas.get<CanvasRubric>(
          `/api/v1/courses/${courseId}/rubrics/${args.rubric_id}`,
        );
        return jsonResult(rubric, { summary: `Rubric ${rubric.id}: "${rubric.title}"` });
      });
    },
  );
}
