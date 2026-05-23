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

const RUBRIC_RATING_SCHEMA = z.object({
  description: z.string().describe("Short rating label, e.g., 'Excellent', 'Proficient', 'Developing', 'Beginning'."),
  long_description: z
    .string()
    .optional()
    .describe("The descriptor shown in SpeedGrader explaining what work earns this rating."),
  points: z.number().describe("Points awarded at this rating level."),
});

const RUBRIC_CRITERION_SCHEMA = z.object({
  description: z.string().describe("Short criterion name, e.g., 'Clarity of Argument' or 'Use of Evidence'."),
  long_description: z
    .string()
    .optional()
    .describe("Full description of what this criterion measures, shown in SpeedGrader above the ratings."),
  ratings: z
    .array(RUBRIC_RATING_SCHEMA)
    .min(2)
    .describe("Rating levels for this criterion. Typically 4 (Excellent/Proficient/Developing/Beginning)."),
});

const RUBRIC_ASSOCIATION_PARAMS = {
  association_type: z
    .enum(["Assignment", "Quiz", "Discussion"])
    .describe("What kind of Canvas object to attach the rubric to."),
  association_id: z
    .union([z.string(), z.number()])
    .describe("The numeric Canvas id of the assignment, quiz, or discussion."),
  use_for_grading: z
    .boolean()
    .optional()
    .describe("If true (default), rubric scores roll up to the assignment grade. If false, the rubric is informational only."),
  hide_score_total: z
    .boolean()
    .optional()
    .describe("If true, hide the rubric's total score from students. Default false."),
};

const CREATE_RUBRIC_INPUT = {
  course_identifier: z.union([z.string(), z.number()]),
  title: z.string().describe("Rubric title shown in the course rubrics list (e.g., 'Engineering Design Project Rubric')."),
  criteria: z.array(RUBRIC_CRITERION_SCHEMA).min(1),
  free_form_criterion_comments: z
    .boolean()
    .optional()
    .describe(
      "If true, graders can write per-criterion comments in SpeedGrader. If false, comments use only the canned rating descriptions. Default false.",
    ),
  associate_with: z
    .object(RUBRIC_ASSOCIATION_PARAMS)
    .optional()
    .describe(
      "Optional: attach the new rubric to an assignment/quiz/discussion in the same API call. Use create_rubric_association separately if you want to attach an EXISTING rubric to another assignment.",
    ),
};

const CREATE_RUBRIC_ASSOCIATION_INPUT = {
  course_identifier: z.union([z.string(), z.number()]),
  rubric_id: z.union([z.string(), z.number()]).describe("Numeric id of an existing rubric in this course."),
  ...RUBRIC_ASSOCIATION_PARAMS,
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

interface CanvasRubricAssociation {
  id: number;
  rubric_id: number;
  association_id: number;
  association_type: string;
  use_for_grading: boolean;
  hide_score_total: boolean;
  purpose: string;
}

interface CreateRubricResponse {
  rubric: CanvasRubric;
  rubric_association?: CanvasRubricAssociation;
}

/** Convert the structured criteria + association into Canvas's nested form-encoded params. */
function buildRubricFormData(args: {
  title: string;
  free_form_criterion_comments?: boolean;
  criteria: Array<z.infer<typeof RUBRIC_CRITERION_SCHEMA>>;
  associate_with?: z.infer<z.ZodObject<typeof RUBRIC_ASSOCIATION_PARAMS>>;
}): URLSearchParams {
  const params = new URLSearchParams();
  params.append("rubric[title]", args.title);
  if (args.free_form_criterion_comments !== undefined) {
    params.append("rubric[free_form_criterion_comments]", String(args.free_form_criterion_comments));
  }
  args.criteria.forEach((criterion, ci) => {
    params.append(`rubric[criteria][${ci}][description]`, criterion.description);
    if (criterion.long_description) {
      params.append(`rubric[criteria][${ci}][long_description]`, criterion.long_description);
    }
    criterion.ratings.forEach((rating, ri) => {
      params.append(`rubric[criteria][${ci}][ratings][${ri}][description]`, rating.description);
      if (rating.long_description) {
        params.append(`rubric[criteria][${ci}][ratings][${ri}][long_description]`, rating.long_description);
      }
      params.append(`rubric[criteria][${ci}][ratings][${ri}][points]`, String(rating.points));
    });
  });
  if (args.associate_with) {
    params.append("rubric_association[association_type]", args.associate_with.association_type);
    params.append("rubric_association[association_id]", String(args.associate_with.association_id));
    params.append(
      "rubric_association[use_for_grading]",
      String(args.associate_with.use_for_grading ?? true),
    );
    if (args.associate_with.hide_score_total !== undefined) {
      params.append("rubric_association[hide_score_total]", String(args.associate_with.hide_score_total));
    }
    params.append("rubric_association[purpose]", "grading");
  }
  return params;
}

function buildAssociationFormData(args: {
  rubric_id: string | number;
  association_type: "Assignment" | "Quiz" | "Discussion";
  association_id: string | number;
  use_for_grading?: boolean;
  hide_score_total?: boolean;
}): URLSearchParams {
  const params = new URLSearchParams();
  params.append("rubric_association[rubric_id]", String(args.rubric_id));
  params.append("rubric_association[association_type]", args.association_type);
  params.append("rubric_association[association_id]", String(args.association_id));
  params.append("rubric_association[use_for_grading]", String(args.use_for_grading ?? true));
  if (args.hide_score_total !== undefined) {
    params.append("rubric_association[hide_score_total]", String(args.hide_score_total));
  }
  params.append("rubric_association[purpose]", "grading");
  return params;
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

  server.registerTool(
    "create_rubric",
    {
      description:
        "Create a new Canvas rubric in a course. Optionally attaches the rubric to an Assignment/Quiz/Discussion in the same call via the associate_with param (saves a round-trip). Bypasses the course-code cache (write path).",
      inputSchema: CREATE_RUBRIC_INPUT,
    },
    async (input) => {
      const args = input as {
        course_identifier: string | number;
        title: string;
        criteria: Array<z.infer<typeof RUBRIC_CRITERION_SCHEMA>>;
        free_form_criterion_comments?: boolean;
        associate_with?: z.infer<z.ZodObject<typeof RUBRIC_ASSOCIATION_PARAMS>>;
      };
      return safeHandler("create_rubric", async () => {
        const courseId = await canvas.resolveCourseId(args.course_identifier, { bypassCache: true });
        const body = buildRubricFormData(args);
        const response = await canvas.post<CreateRubricResponse>(
          `/api/v1/courses/${courseId}/rubrics`,
          body,
          { headers: { "Content-Type": "application/x-www-form-urlencoded" } },
        );
        const summaryPieces = [
          `Created rubric "${response.rubric.title}" (id ${response.rubric.id}) in course ${courseId}`,
          `with ${args.criteria.length} criterion/criteria`,
        ];
        if (response.rubric_association) {
          summaryPieces.push(
            `, associated with ${response.rubric_association.association_type} ${response.rubric_association.association_id}`,
          );
        }
        return jsonResult(
          { course_id: courseId, ...response },
          { summary: summaryPieces.join(" ") + "." },
        );
      });
    },
  );

  server.registerTool(
    "create_rubric_association",
    {
      description:
        "Attach an existing rubric to an Assignment/Quiz/Discussion. Use when reusing a rubric across multiple assessments. Bypasses the course-code cache (write path). To create+associate a NEW rubric in one call, use create_rubric's `associate_with` param instead.",
      inputSchema: CREATE_RUBRIC_ASSOCIATION_INPUT,
    },
    async (input) => {
      const args = input as {
        course_identifier: string | number;
        rubric_id: string | number;
        association_type: "Assignment" | "Quiz" | "Discussion";
        association_id: string | number;
        use_for_grading?: boolean;
        hide_score_total?: boolean;
      };
      return safeHandler("create_rubric_association", async () => {
        const courseId = await canvas.resolveCourseId(args.course_identifier, { bypassCache: true });
        const body = buildAssociationFormData(args);
        const created = await canvas.post<CanvasRubricAssociation>(
          `/api/v1/courses/${courseId}/rubric_associations`,
          body,
          { headers: { "Content-Type": "application/x-www-form-urlencoded" } },
        );
        return jsonResult(
          { course_id: courseId, rubric_association: created },
          {
            summary: `Attached rubric ${args.rubric_id} to ${args.association_type} ${args.association_id} in course ${courseId} (use_for_grading=${created.use_for_grading}).`,
          },
        );
      });
    },
  );
}
