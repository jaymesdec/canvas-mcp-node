import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import type { CanvasClient } from "../canvasClient.js";
import type { Anonymizer } from "../anonymizer.js";
import { applyPageTemplate, explainAcademicWeek, type SchoolConfig } from "../schoolConfig.js";
import { deriveCourseUrl, jsonResult, pickFields, safeHandler } from "./toolHelpers.js";
import { DEANON_DENIED_NOTE, resolveAnonymous } from "../featureFlags.js";
import { anonymizeNonStaffCommentAuthors, displaySubmission } from "./submissions.js";
import { buildStaffIdSet } from "./roster.js";

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

const ASSESSMENT_TEMPLATE_NAME = "assessment";

const FINAL_ASMT_PARAM = z
  .boolean()
  .optional()
  .describe(
    "Whether this assessment counts toward the final grade — adds the FINAL tag to the title. REQUIRED when template:'assessment': ask the teacher, never assume.",
  );

const FAIR_ASMT_PARAM = z
  .boolean()
  .optional()
  .describe(
    "Whether this assessment is published to the school's continuous reporting tool where parents see the assessment, grade, graded rubric, and comments — adds the FAIR tag to the title. REQUIRED when template:'assessment': ask the teacher, never assume.",
  );

const ASSIGNMENT_GROUP_PARAM = z
  .union([z.string(), z.number()])
  .optional()
  .describe(
    "Canvas assignment group this assignment belongs to — numeric group id or exact group name (case-insensitive). REQUIRED when template:'assessment': the group name IS the {type} in the assessment title and its group_weight IS the {percent} — ask the teacher which group the assessment belongs to (the percent then comes from Canvas, not the teacher's memory). Use list_assignment_groups to see the course's groups.",
  );

const ASMT_PERCENT_PARAM = z
  .number()
  .min(0)
  .max(100)
  .optional()
  .describe(
    "Assessment weight percent for the title's {percent} — only needed when the resolved assignment group has no usable group_weight (weights disabled or weight 0). When the group carries a real weight, that Canvas value wins and this is only cross-checked.",
  );

const CREATE_ASSIGNMENT_INPUT = {
  course_identifier: z.union([z.string(), z.number()]),
  name: z.string(),
  description: z
    .string()
    .optional()
    .describe(
      "Assignment description HTML used for single-slot templates (filled into the {{body}} token). For multi-slot templates like 'assessment', pass `slots` instead.",
    ),
  due_at: z.string().optional().describe("ISO-8601 due timestamp."),
  unlock_at: z.string().optional().describe("ISO-8601 timestamp when the assignment unlocks for students."),
  lock_at: z.string().optional().describe("ISO-8601 timestamp when the assignment locks."),
  points_possible: z.number().optional(),
  submission_types: z.array(z.string()).optional().describe(SUBMISSION_TYPES_DESCRIPTION),
  template: z
    .string()
    .optional()
    .describe(
      "Named page template from the school config (e.g., 'assessment', 'default'). Omit to apply 'default' to the description. Pass 'none' to skip wrapping. Use list_page_templates to discover what's available.",
    ),
  final_asmt: FINAL_ASMT_PARAM,
  fair_asmt: FAIR_ASMT_PARAM,
  assignment_group: ASSIGNMENT_GROUP_PARAM,
  asmt_percent: ASMT_PERCENT_PARAM,
  slots: z
    .record(z.string(), z.string())
    .optional()
    .describe(
      "Named content for multi-slot templates. Keys map to {{slot:NAME}} tokens in the template HTML. Discover slot names via list_page_templates.",
    ),
  include_sections: z
    .array(z.string())
    .optional()
    .describe(
      "Force-add optional template sections that are default-omit. Discover section names via list_page_templates.",
    ),
  omit_sections: z
    .array(z.string())
    .optional()
    .describe(
      "Force-remove template sections that are default-include. Discover section names via list_page_templates.",
    ),
};

const UPDATE_ASSIGNMENT_INPUT = {
  course_identifier: z.union([z.string(), z.number()]),
  assignment_id: z.union([z.string(), z.number()]),
  name: z.string().optional(),
  description: z
    .string()
    .optional()
    .describe(
      "Assignment description HTML. For multi-slot templates, pass `slots` instead. Sent verbatim only when no template machinery is engaged.",
    ),
  due_at: z.string().optional().describe("ISO-8601 due timestamp."),
  unlock_at: z.string().optional().describe("ISO-8601 timestamp when the assignment unlocks for students."),
  lock_at: z.string().optional().describe("ISO-8601 timestamp when the assignment locks."),
  points_possible: z.number().optional(),
  submission_types: z.array(z.string()).optional().describe(SUBMISSION_TYPES_DESCRIPTION),
  template: z
    .string()
    .optional()
    .describe(
      "Named page template from the school config (e.g., 'assessment'). Pass to rebuild the description from the template with the supplied slots. Pass 'none' to skip template machinery entirely (description sent verbatim). When omitted with no other template args, behaves as a simple field-update.",
    ),
  final_asmt: FINAL_ASMT_PARAM,
  fair_asmt: FAIR_ASMT_PARAM,
  assignment_group: ASSIGNMENT_GROUP_PARAM,
  asmt_percent: ASMT_PERCENT_PARAM,
  slots: z
    .record(z.string(), z.string())
    .optional()
    .describe(
      "Named content for multi-slot templates. When provided (or when `template` / `include_sections` / `omit_sections` is provided), the description is REBUILT from the template using these slots — pass ALL slots you want in the new description, not just the ones that changed. Use get_assignment_details first if you need the current values.",
    ),
  include_sections: z
    .array(z.string())
    .optional()
    .describe(
      "When re-applying a template, force-add optional sections that are default-omit.",
    ),
  omit_sections: z
    .array(z.string())
    .optional()
    .describe(
      "When re-applying a template, force-remove sections that are default-include.",
    ),
};

const LIST_ASSIGNMENT_GROUPS_INPUT = {
  course_identifier: z.union([z.string(), z.number()]),
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

interface CanvasCourseLite {
  id: number;
  name?: string;
}

// Fetch course.name only when the chosen template actually needs it — saves an
// API call per write when the template doesn't use {{course_name}}.
async function fetchCourseNameIfTemplateNeedsIt(
  canvas: CanvasClient,
  schoolConfig: SchoolConfig | null,
  templateArg: string | undefined,
  courseId: number,
): Promise<string | undefined> {
  const chosenTemplate = schoolConfig?.pageTemplates?.[templateArg ?? "default"];
  if (!chosenTemplate?.html.includes("{{course_name}}")) return undefined;
  try {
    const course = await canvas.get<CanvasCourseLite>(`/api/v1/courses/${courseId}`);
    return course.name;
  } catch {
    // ignore — {{course_name}} substitutes as empty
    return undefined;
  }
}

interface CanvasAssignmentGroup {
  id: number;
  name?: string;
  position?: number;
  group_weight?: number | null;
}

async function fetchAssignmentGroups(
  canvas: CanvasClient,
  courseId: number,
): Promise<CanvasAssignmentGroup[]> {
  const { items } = await canvas.getPaginated<CanvasAssignmentGroup>(
    `/api/v1/courses/${courseId}/assignment_groups`,
  );
  return items;
}

function formatGroupList(groups: CanvasAssignmentGroup[]): string {
  if (groups.length === 0) return "(no assignment groups found in this course)";
  return groups
    .map((group) => `"${group.name ?? "(unnamed)"}" (id ${group.id}, weight ${group.group_weight ?? 0}%)`)
    .join(", ");
}

function resolveAssignmentGroup(
  toolName: string,
  groups: CanvasAssignmentGroup[],
  identifier: string | number,
): CanvasAssignmentGroup {
  const asNumber =
    typeof identifier === "number"
      ? identifier
      : /^\d+$/.test(identifier.trim())
        ? Number(identifier.trim())
        : null;
  if (asNumber !== null) {
    const byId = groups.find((group) => group.id === asNumber);
    if (byId) return byId;
    if (typeof identifier === "number") {
      throw new Error(
        `${toolName}: no assignment group with id ${identifier} in this course. Ask the teacher which group this belongs to and retry with the exact name or a listed id. Course assignment groups: ${formatGroupList(groups)}.`,
      );
    }
  }
  const wanted = String(identifier).trim().toLowerCase();
  const matches = groups.filter((group) => (group.name ?? "").trim().toLowerCase() === wanted);
  if (matches.length === 1) return matches[0]!;
  const problem =
    matches.length === 0 ? "does not match any assignment group" : `matches ${matches.length} assignment groups`;
  throw new Error(
    `${toolName}: assignment_group "${identifier}" ${problem} in this course. Ask the teacher which group this belongs to and retry with the exact name or numeric id. Course assignment groups: ${formatGroupList(groups)}.`,
  );
}

function assertAssessmentGroupProvided(
  toolName: string,
  assignmentGroup: string | number | undefined,
  groups: CanvasAssignmentGroup[],
): void {
  if (assignmentGroup !== undefined) return;
  throw new Error(
    `${toolName}: template 'assessment' requires assignment_group — ask the teacher which assignment group this assessment belongs to; the group is the {type} in the title and its weight is the {percent}. Course assignment groups: ${formatGroupList(groups)}.`,
  );
}

// Canvas reports group_weight 0 for every group when weighted assignment
// groups are disabled, so 0 and null are both treated as "no usable weight".
function resolveAssessmentPercent(
  toolName: string,
  group: CanvasAssignmentGroup,
  asmtPercent: number | undefined,
): { percent: number; warnings: string[] } {
  const warnings: string[] = [];
  const groupWeight = group.group_weight;
  if (typeof groupWeight === "number" && groupWeight > 0) {
    if (asmtPercent !== undefined && asmtPercent !== groupWeight) {
      warnings.push(
        `asmt_percent ${asmtPercent} differs from assignment group "${group.name ?? group.id}"'s Canvas group_weight ${groupWeight}% — the Canvas weight wins in the suggested title. Confirm with the teacher if that looks wrong.`,
      );
    }
    return { percent: groupWeight, warnings };
  }
  if (asmtPercent !== undefined) return { percent: asmtPercent, warnings };
  throw new Error(
    `${toolName}: assignment group "${group.name ?? group.id}" has no usable group_weight (weighted assignment groups may be disabled for this course) — ask the teacher what percent of the grade this assessment is worth and retry with asmt_percent (0-100).`,
  );
}

interface SuggestedTitleVars {
  type: string;
  name: string;
  week: number | null;
  percent: number;
  fair_flag: string;
  final_flag: string;
}

// Unknown {vars} in the format are intentionally left untouched — schools may
// carry placeholders this server doesn't know how to fill.
function composeSuggestedTitle(
  titleFormat: string,
  vars: SuggestedTitleVars,
  weekWarning: string | null,
): { title: string; warnings: string[] } {
  const warnings: string[] = [];
  if (vars.week === null && titleFormat.includes("{week}") && weekWarning !== null) {
    warnings.push(weekWarning);
  }
  const substitutions: Record<string, string> = {
    type: vars.type,
    name: vars.name,
    week: vars.week === null ? "?" : String(vars.week),
    percent: String(vars.percent),
    fair_flag: vars.fair_flag,
    final_flag: vars.final_flag,
  };
  let title = titleFormat;
  for (const [token, value] of Object.entries(substitutions)) {
    title = title.split(`{${token}}`).join(value);
  }
  return { title, warnings };
}

interface AssessmentWeekResolution {
  week: number | null;
  warning: string | null;
}

// The warning must state the EXACT reason the week is unknown — an ambiguous
// message here caused models to claim no calendar was loaded and hand teachers
// raw-math week estimates that ignore school breaks.
function assessmentWeekFor(dueAt: string | undefined, schoolConfig: SchoolConfig | null): AssessmentWeekResolution {
  const date = dueAt !== undefined ? new Date(dueAt) : new Date();
  if (Number.isNaN(date.getTime())) {
    return { week: null, warning: `The due date "${dueAt}" could not be parsed — substituted "?" for the week in the suggested title. Confirm the due date and week number with the teacher.` };
  }
  const explanation = explainAcademicWeek(date, schoolConfig?.academicCalendar);
  if (explanation.reason === "ok") return { week: explanation.week, warning: null };

  const dateLabel = date.toISOString().slice(0, 10);
  const subject = dueAt !== undefined ? `The due date ${dateLabel}` : `Today (${dateLabel}, no due date was provided)`;
  let warning: string;
  switch (explanation.reason) {
    case "break":
      warning =
        `${subject} falls during a SCHOOL BREAK — between Week ${explanation.previous!.week} (ends ${explanation.previous!.end}) and Week ${explanation.next!.week} (begins ${explanation.next!.start}). ` +
        `Substituted "?" in the suggested title. Tell the teacher the date is during a break (it may be unintended); if intended, ask which adjacent week number to use. Do NOT estimate a week number yourself.`;
      break;
    case "before_year":
      warning =
        `${subject} is before the school year's first configured week (Week ${explanation.next!.week} begins ${explanation.next!.start}). ` +
        `Substituted "?" in the suggested title — confirm the intended date and week with the teacher. Do NOT estimate a week number yourself.`;
      break;
    case "after_year":
      warning =
        `${subject} is after the school year's last configured week (Week ${explanation.previous!.week} ends ${explanation.previous!.end}). ` +
        `Substituted "?" in the suggested title — confirm the intended date and week with the teacher. Do NOT estimate a week number yourself.`;
      break;
    default:
      warning =
        `No academic calendar is configured, so the week number is unknown — substituted "?" in the suggested title. Ask the teacher for the week number; do NOT estimate one yourself.`;
  }
  return { week: null, warning };
}

function assertAssessmentFlagsProvided(
  toolName: string,
  finalAsmt: boolean | undefined,
  fairAsmt: boolean | undefined,
): void {
  if (finalAsmt !== undefined && fairAsmt !== undefined) return;
  throw new Error(
    `${toolName}: template 'assessment' requires final_asmt and fair_asmt. Ask the teacher: is this a FINAL assessment (counts toward the final grade)? Is it a FAIR assessment (published to the continuous reporting tool for parents, including grade, rubric, and comments)? Then retry with both flags.`,
  );
}

// {fair_flag}{final_flag} order from the assessment titleFormat — FAIR before FINAL.
function suggestedTitleFlags(fairAsmt: boolean, finalAsmt: boolean): string {
  return `${fairAsmt ? "FAIR " : ""}${finalAsmt ? "FINAL " : ""}`;
}

function assessmentTitleWarnings(name: string, fairAsmt: boolean, finalAsmt: boolean): string[] {
  const warnings: string[] = [];
  if (!name.trimEnd().endsWith("ASMT")) {
    warnings.push(
      `Assessment name "${name}" does not end with "ASMT" — Franklin assessment titles end with "{fair_flag}{final_flag}ASMT". The name is the teacher's call; flagging in case it was unintentional.`,
    );
  }
  const hasFinalToken = /\bFINAL\b/.test(name);
  const hasFairToken = /\bFAIR\b/.test(name);
  if (finalAsmt && !hasFinalToken) {
    warnings.push(
      `final_asmt is true but the name "${name}" lacks the FINAL tag — expected the title to include "FINAL" before "ASMT".`,
    );
  }
  if (!finalAsmt && hasFinalToken) {
    warnings.push(
      `final_asmt is false but the name "${name}" contains the FINAL tag — parents/students will read it as counting toward the final grade.`,
    );
  }
  if (fairAsmt && !hasFairToken) {
    warnings.push(
      `fair_asmt is true but the name "${name}" lacks the FAIR tag — expected the title to include "FAIR" before "ASMT".`,
    );
  }
  if (!fairAsmt && hasFairToken) {
    warnings.push(
      `fair_asmt is false but the name "${name}" contains the FAIR tag — it will read as published to the continuous reporting tool when it is not.`,
    );
  }
  return warnings;
}

interface GroupAndPercentResolution {
  group: CanvasAssignmentGroup;
  percent?: number;
  warnings: string[];
}

async function resolveGroupAndPercent(
  toolName: string,
  canvas: CanvasClient,
  courseId: number,
  args: { assignment_group?: string | number; asmt_percent?: number },
  usingAssessmentTemplate: boolean,
): Promise<GroupAndPercentResolution | null> {
  if (args.assignment_group === undefined && !usingAssessmentTemplate) return null;
  const groups = await fetchAssignmentGroups(canvas, courseId);
  if (usingAssessmentTemplate) {
    assertAssessmentGroupProvided(toolName, args.assignment_group, groups);
  }
  const group = resolveAssignmentGroup(toolName, groups, args.assignment_group!);
  if (!usingAssessmentTemplate) return { group, warnings: [] };
  const { percent, warnings } = resolveAssessmentPercent(toolName, group, args.asmt_percent);
  return { group, percent, warnings };
}

function displayAssignmentGroup(group: CanvasAssignmentGroup): Record<string, unknown> {
  return { id: group.id, name: group.name ?? null, group_weight: group.group_weight ?? null };
}

export function registerAssignmentTools(
  server: McpServer,
  canvas: CanvasClient,
  anonymizer: Anonymizer,
  schoolConfig: SchoolConfig | null = null,
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

        let finalAssignments = assignments;
        if (anonymous && hasSubmissionInclude) {
          finalAssignments = await Promise.all(
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
          );

          // anonymizeSubmission covers the submitter but not comment authors —
          // those arrive role-less, so they're classified against the staff
          // roster (same pass list_submissions runs). Roster is fetched only
          // when an embedded submission actually carries comments.
          const submissionHasComments = (submission: unknown): boolean =>
            !!submission &&
            typeof submission === "object" &&
            Array.isArray((submission as Record<string, unknown>).submission_comments) &&
            ((submission as Record<string, unknown>).submission_comments as unknown[]).length > 0;
          const hasAnyComments = finalAssignments.some(
            (assignment) =>
              submissionHasComments(assignment.submission) ||
              (Array.isArray(assignment.submission_history) &&
                assignment.submission_history.some(submissionHasComments)),
          );
          if (hasAnyComments) {
            const staffIds = await buildStaffIdSet(canvas, courseId);
            finalAssignments = await Promise.all(
              finalAssignments.map(async (assignment) => {
                const copy: CanvasAssignment = { ...assignment };
                if (copy.submission) {
                  copy.submission = await anonymizeNonStaffCommentAuthors(
                    anonymizer,
                    courseId,
                    copy.submission as Record<string, unknown>,
                    staffIds,
                  );
                }
                if (Array.isArray(copy.submission_history)) {
                  copy.submission_history = await Promise.all(
                    copy.submission_history.map((entry) =>
                      anonymizeNonStaffCommentAuthors(anonymizer, courseId, entry, staffIds),
                    ),
                  );
                }
                return copy;
              }),
            );
          }
        }
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
    "list_assignment_groups",
    {
      description:
        "List a course's Canvas assignment groups (id, name, position, group_weight) plus the course's apply_assignment_group_weights flag. " +
        "For assessments the group carries the title semantics: the group name IS the {type} in the assessment title format and its group_weight IS the {percent} (Canvas weighted assignment groups) — " +
        "ask the teacher which group an assessment belongs to, then take the percent from this tool's output rather than the teacher's memory. " +
        "When apply_assignment_group_weights is false, group weights do not affect grading.",
      inputSchema: LIST_ASSIGNMENT_GROUPS_INPUT,
    },
    async (input) => {
      const args = input as { course_identifier: string | number };
      return safeHandler("list_assignment_groups", async () => {
        const courseId = await canvas.resolveCourseId(args.course_identifier);
        const { items: groups, truncated, pages } = await canvas.getPaginated<CanvasAssignmentGroup>(
          `/api/v1/courses/${courseId}/assignment_groups`,
        );
        const course = await canvas.get<CanvasCourseLite & { apply_assignment_group_weights?: boolean }>(
          `/api/v1/courses/${courseId}`,
        );
        const weightsApplied = course.apply_assignment_group_weights === true;
        const trimmedGroups = groups.map((group) => ({
          id: group.id,
          name: group.name ?? null,
          position: group.position ?? null,
          group_weight: group.group_weight ?? null,
        }));
        return jsonResult(
          {
            course_id: courseId,
            count: trimmedGroups.length,
            pages,
            truncated,
            apply_assignment_group_weights: weightsApplied,
            assignment_groups: trimmedGroups,
          },
          {
            summary:
              `Course ${courseId}: ${trimmedGroups.length} assignment group(s).` +
              (weightsApplied
                ? ""
                : " Note: assignment group weights are NOT applied to grades in this course (apply_assignment_group_weights=false) — group_weight values do not affect grading."),
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
        "The description is wrapped in the school's 'default' page template automatically; pass template='assessment' for Franklin assessments — discover slot names and the ASMT title format via list_page_templates — or template='none' to skip wrapping. " +
        "template='assessment' REQUIRES final_asmt (counts toward the final grade → FINAL title tag), fair_asmt (published to the parent-facing continuous reporting tool → FAIR title tag), and assignment_group (the Canvas assignment group — its name is the {type} in the assessment title and its group_weight is the {percent}): ask the teacher all three, never assume; the weight then comes from Canvas, not the teacher's memory. " +
        "The response returns suggested_title composed from the school's assessment title format — propose it to the teacher and let them adjust. " +
        "Conduct: ask the assessment questions in plain language (never surface parameter names like final_asmt to the teacher); do NOT offer to skip the school template — template='none' exists only for when the teacher explicitly asks for an untemplated assignment; never ask whether to create as a draft — assignments are ALWAYS created unpublished. " +
        "assignment_group also works on non-assessment assignments as a plain group placement. " +
        "Multi-slot templates need content via slots={...}; include_sections / omit_sections override the template's default optional-section state per-call. " +
        SUBMISSION_TYPES_DESCRIPTION,
      inputSchema: CREATE_ASSIGNMENT_INPUT,
    },
    async (input) => {
      const args = input as z.infer<z.ZodObject<typeof CREATE_ASSIGNMENT_INPUT>>;
      return safeHandler("create_assignment", async () => {
        const usingAssessmentTemplate = args.template === ASSESSMENT_TEMPLATE_NAME;
        if (usingAssessmentTemplate) {
          assertAssessmentFlagsProvided("create_assignment", args.final_asmt, args.fair_asmt);
        }

        const courseId = await canvas.resolveCourseId(args.course_identifier, { bypassCache: true });

        const groupResolution = await resolveGroupAndPercent(
          "create_assignment",
          canvas,
          courseId,
          args,
          usingAssessmentTemplate,
        );

        const assignmentPayload: Record<string, unknown> = { name: args.name, published: false };
        if (groupResolution) assignmentPayload.assignment_group_id = groupResolution.group.id;
        // Assignments legitimately exist without descriptions — only engage the
        // template machinery when the caller supplied content, so we never
        // create chrome-only descriptions.
        const hasDescriptionContent = args.description !== undefined || args.slots !== undefined;
        let templateApplication: ReturnType<typeof applyPageTemplate> | null = null;
        if (hasDescriptionContent) {
          const courseName = await fetchCourseNameIfTemplateNeedsIt(canvas, schoolConfig, args.template, courseId);
          templateApplication = applyPageTemplate(
            schoolConfig,
            {
              title: args.name,
              body: args.description,
              slots: args.slots,
              courseName,
              courseId,
              courseUrl: deriveCourseUrl(canvas.baseUrl, courseId),
            },
            args.template,
            {
              includeSections: args.include_sections,
              omitSections: args.omit_sections,
            },
          );
          assignmentPayload.description = templateApplication.body;
        }
        if (args.due_at !== undefined) assignmentPayload.due_at = args.due_at;
        if (args.unlock_at !== undefined) assignmentPayload.unlock_at = args.unlock_at;
        if (args.lock_at !== undefined) assignmentPayload.lock_at = args.lock_at;
        if (args.points_possible !== undefined) assignmentPayload.points_possible = args.points_possible;
        if (args.submission_types !== undefined) assignmentPayload.submission_types = args.submission_types;

        const created = await canvas.post<CanvasAssignment>(
          `/api/v1/courses/${courseId}/assignments`,
          { assignment: assignmentPayload },
        );

        const responsePayload: Record<string, unknown> = {
          course_id: courseId,
          assignment: displayAssignment(created, { includeDescription: false }),
        };
        if (templateApplication) {
          responsePayload.template_applied = templateApplication.appliedTemplate;
          if (templateApplication.includedSections.length > 0)
            responsePayload.included_sections = templateApplication.includedSections;
          if (templateApplication.omittedSections.length > 0)
            responsePayload.omitted_sections = templateApplication.omittedSections;
        }

        const warnings: string[] = [...(templateApplication?.warnings ?? [])];
        if (groupResolution) {
          responsePayload.assignment_group = displayAssignmentGroup(groupResolution.group);
          warnings.push(...groupResolution.warnings);
        }
        if (usingAssessmentTemplate) {
          const fairAsmt = args.fair_asmt === true;
          const finalAsmt = args.final_asmt === true;
          responsePayload.suggested_title_flags = suggestedTitleFlags(fairAsmt, finalAsmt);
          responsePayload.resolved_percent = groupResolution!.percent;
          const titleFormat = schoolConfig?.pageTemplates?.[ASSESSMENT_TEMPLATE_NAME]?.titleFormat;
          if (titleFormat !== undefined) {
            const weekResolution = assessmentWeekFor(args.due_at, schoolConfig);
            const composed = composeSuggestedTitle(
              titleFormat,
              {
                type: groupResolution!.group.name ?? "",
                name: args.name,
                week: weekResolution.week,
                percent: groupResolution!.percent!,
                fair_flag: fairAsmt ? "FAIR " : "",
                final_flag: finalAsmt ? "FINAL " : "",
              },
              weekResolution.warning,
            );
            responsePayload.suggested_title = composed.title;
            warnings.push(...composed.warnings);
          }
          warnings.push(...assessmentTitleWarnings(args.name, fairAsmt, finalAsmt));
        }
        if (warnings.length > 0) responsePayload.warnings = warnings;

        return jsonResult(responsePayload, {
          summary:
            `Created draft assignment "${created.name ?? args.name}" (id ${created.id}) in course ${courseId}.` +
            (templateApplication?.appliedTemplate ? ` Template: ${templateApplication.appliedTemplate}.` : "") +
            " Assignment is unpublished — teacher publishes manually after review.",
        });
      });
    },
  );

  server.registerTool(
    "update_assignment",
    {
      description:
        "Update fields on an existing Canvas assignment. Sends only the provided fields and never touches the published state. " +
        "Two modes: (1) Simple field update — provided fields (description included) are sent verbatim. " +
        "(2) Re-apply template — pass `template`, `slots`, and/or `include_sections`/`omit_sections` to rebuild the description from the school template (same machinery as create_assignment; pass template='assessment' for Franklin assessments — discover slot names via list_page_templates). " +
        "Re-applying template='assessment' REQUIRES final_asmt (counts toward the final grade → FINAL title tag), fair_asmt (published to the parent-facing continuous reporting tool → FAIR title tag), and assignment_group (the Canvas assignment group — its name is the {type} in the assessment title and its group_weight is the {percent}): ask the teacher, never assume; the response returns suggested_title composed from the school's title format — propose it to the teacher and let them adjust. " +
        "Conduct: ask in plain language (never surface parameter names to the teacher) and do NOT offer to skip the school template — template='none' exists only for when the teacher explicitly asks. " +
        "In simple mode, assignment_group works as a plain regroup (sets assignment_group_id; numeric id or exact case-insensitive group name). " +
        "When re-applying a template, pass ALL slots you want in the result, not just the ones that changed — the description is rebuilt from scratch. Pass template='none' to force simple mode. " +
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

        const hasTemplateArgs =
          args.template !== undefined ||
          args.slots !== undefined ||
          args.include_sections !== undefined ||
          args.omit_sections !== undefined;
        const usingTemplate = hasTemplateArgs && args.template !== "none";
        const usingAssessmentTemplate = usingTemplate && args.template === ASSESSMENT_TEMPLATE_NAME;

        if (Object.keys(assignmentPayload).length === 0 && !usingTemplate && args.assignment_group === undefined) {
          throw new Error(
            "update_assignment: provide at least one field to update (name/description/due_at/unlock_at/lock_at/points_possible/submission_types/assignment_group) or template args (template/slots/include_sections/omit_sections).",
          );
        }
        if (usingAssessmentTemplate) {
          assertAssessmentFlagsProvided("update_assignment", args.final_asmt, args.fair_asmt);
        }

        const courseId = await canvas.resolveCourseId(args.course_identifier, { bypassCache: true });

        const groupResolution = await resolveGroupAndPercent(
          "update_assignment",
          canvas,
          courseId,
          args,
          usingAssessmentTemplate,
        );
        if (groupResolution) assignmentPayload.assignment_group_id = groupResolution.group.id;

        let templateApplication: ReturnType<typeof applyPageTemplate> | null = null;
        let resolvedName = args.name;
        if (usingTemplate) {
          // Need the name to fill {{title}}; fetch existing if not being updated
          if (resolvedName === undefined) {
            const current = await canvas.get<CanvasAssignment>(
              `/api/v1/courses/${courseId}/assignments/${args.assignment_id}`,
            );
            resolvedName = current.name ?? "";
          }

          const courseName = await fetchCourseNameIfTemplateNeedsIt(canvas, schoolConfig, args.template, courseId);
          templateApplication = applyPageTemplate(
            schoolConfig,
            {
              title: resolvedName,
              body: args.description,
              slots: args.slots,
              courseName,
              courseId,
              courseUrl: deriveCourseUrl(canvas.baseUrl, courseId),
            },
            args.template,
            {
              includeSections: args.include_sections,
              omitSections: args.omit_sections,
            },
          );
          assignmentPayload.description = templateApplication.body;
        }

        const updated = await canvas.put<CanvasAssignment>(
          `/api/v1/courses/${courseId}/assignments/${args.assignment_id}`,
          { assignment: assignmentPayload },
        );

        const warnings: string[] = [...(templateApplication?.warnings ?? [])];
        if (groupResolution) warnings.push(...groupResolution.warnings);
        let suggestedFlags: string | undefined;
        let suggestedTitle: string | undefined;
        let resolvedPercent: number | undefined;
        if (usingAssessmentTemplate) {
          const fairAsmt = args.fair_asmt === true;
          const finalAsmt = args.final_asmt === true;
          suggestedFlags = suggestedTitleFlags(fairAsmt, finalAsmt);
          resolvedPercent = groupResolution!.percent;
          const titleFormat = schoolConfig?.pageTemplates?.[ASSESSMENT_TEMPLATE_NAME]?.titleFormat;
          if (titleFormat !== undefined) {
            const weekResolution = assessmentWeekFor(args.due_at, schoolConfig);
            const composed = composeSuggestedTitle(
              titleFormat,
              {
                type: groupResolution!.group.name ?? "",
                name: resolvedName ?? updated.name ?? "",
                week: weekResolution.week,
                percent: groupResolution!.percent!,
                fair_flag: fairAsmt ? "FAIR " : "",
                final_flag: finalAsmt ? "FINAL " : "",
              },
              weekResolution.warning,
            );
            suggestedTitle = composed.title;
            warnings.push(...composed.warnings);
          }
          warnings.push(...assessmentTitleWarnings(resolvedName ?? updated.name ?? "", fairAsmt, finalAsmt));
        }
        let submissionTypesIgnored = false;
        if (
          args.submission_types !== undefined &&
          !submissionTypesMatch(args.submission_types, updated.submission_types)
        ) {
          submissionTypesIgnored = true;
          warnings.push(
            `Canvas ignored the requested submission_types change (requested: [${args.submission_types.join(", ")}], returned: [${(updated.submission_types ?? []).join(", ")}]). Canvas silently rejects submission_types edits once an assignment has student submissions.`,
          );
        }

        const responsePayload: Record<string, unknown> = {
          course_id: courseId,
          // Templated descriptions are not echoed back — same token-saving rule
          // as create_page's body_omitted.
          assignment: displayAssignment(updated, {
            includeDescription: args.description !== undefined && !templateApplication,
          }),
        };
        if (templateApplication) {
          responsePayload.template_applied = templateApplication.appliedTemplate;
          if (templateApplication.includedSections.length > 0)
            responsePayload.included_sections = templateApplication.includedSections;
          if (templateApplication.omittedSections.length > 0)
            responsePayload.omitted_sections = templateApplication.omittedSections;
        }
        if (groupResolution) responsePayload.assignment_group = displayAssignmentGroup(groupResolution.group);
        if (suggestedFlags !== undefined) responsePayload.suggested_title_flags = suggestedFlags;
        if (resolvedPercent !== undefined) responsePayload.resolved_percent = resolvedPercent;
        if (suggestedTitle !== undefined) responsePayload.suggested_title = suggestedTitle;
        if (warnings.length > 0) responsePayload.warnings = warnings;

        return jsonResult(responsePayload, {
          summary:
            `Updated assignment ${args.assignment_id} ("${updated.name ?? ""}") in course ${courseId}.` +
            (templateApplication?.appliedTemplate ? ` Template: ${templateApplication.appliedTemplate}.` : "") +
            (submissionTypesIgnored ? " [warning: submission_types change ignored by Canvas]" : ""),
        });
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
