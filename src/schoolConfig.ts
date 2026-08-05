import { promises as fs } from "node:fs";
import * as path from "node:path";
import { z } from "zod";

/**
 * School-specific configuration loaded from a JSON file path in the
 * SCHOOL_CONFIG env var. The MCP core itself is generic — anything that varies
 * by school (competency framework, future page templates, calendar conventions)
 * lives here so it can be swapped without rebuilding.
 *
 * The Franklin preset ships in-repo at configs/franklin.json. Other schools
 * provide their own JSON file with the same shape.
 */

const CompetencySchema = z.object({
  key: z
    .string()
    .min(1)
    .describe("Short stable identifier — snake_case or kebab-case (e.g., 'collaboration')."),
  name: z.string().min(1).describe("Display name (e.g., 'Collaboration')."),
  description: z.string().min(1),
});

const CompetencyFrameworkSchema = z.object({
  name: z.string().min(1).describe("Framework display name, e.g., \"Franklin's 9 Transdisciplinary Competencies\"."),
  description: z.string().optional(),
  competencies: z.array(CompetencySchema).min(1),
});

const SlotMetaSchema = z.object({
  description: z
    .string()
    .optional()
    .describe(
      "What content goes in this slot. Surfaced to Claude via list_page_templates so the planning skill knows what to generate.",
    ),
});

const SectionMetaSchema = z.object({
  description: z.string().optional(),
  default: z
    .enum(["include", "omit"])
    .default("include")
    .describe(
      "Whether this section is present by default. 'include' = on unless omit_sections asks otherwise; 'omit' = off unless include_sections asks otherwise.",
    ),
});

const PageTemplateSchema = z.object({
  description: z
    .string()
    .optional()
    .describe(
      "What this template is for, in a sentence. Surfaced by list_page_templates so Claude can pick the right one without seeing the HTML.",
    ),
  titleFormat: z
    .string()
    .optional()
    .describe(
      "School-specific format string for page titles created with this template. Uses {var} placeholders that the calling skill fills (e.g., '{type}: {name} [Week {week}] {percent}% {fair_flag}{final_flag}ASMT'). Surfaced via list_page_templates so skills generate titles to the school's convention. Omit when no convention applies (generic schools can leave it off and let the skill propose a title).",
    ),
  html: z
    .string()
    .min(1)
    .describe(
      "Template HTML. Use {{title}}, {{course_name}}, {{course_id}}, {{course_url}}, {{slot:NAME}}, and {{body}} tokens (which the server substitutes per-call). Use <!-- SECTION:NAME --> ... <!-- /SECTION:NAME --> markers around optional accordions or blocks.",
    ),
  slots: z
    .record(z.string(), SlotMetaSchema)
    .optional()
    .describe(
      "Named content slots in this template. Each entry corresponds to a {{slot:NAME}} token in the HTML. Surfacing them lets Claude know what content to generate without seeing the full template.",
    ),
  sections: z
    .record(z.string(), SectionMetaSchema)
    .optional()
    .describe(
      "Optional/conditional sections wrapped in <!-- SECTION:NAME --> markers. Each entry sets a default include/omit state; per-call create_page args (include_sections / omit_sections) override.",
    ),
});

export const SchoolConfigSchema = z.object({
  schoolName: z.string().optional().describe("Human-readable school name, used in summaries."),
  competencyFramework: CompetencyFrameworkSchema.optional(),
  pageTemplates: z
    .record(z.string(), PageTemplateSchema)
    .optional()
    .describe(
      "Named HTML wrappers for Canvas wiki pages. A 'default' entry is applied automatically when create_page is called without an explicit template. Conventional names: 'default' (header-only generic wrap), 'lesson' (lesson-plan layout), 'assessment' (assessment-page layout). Schools can add more names.",
    ),
  academicCalendar: z
    .object({
      weeksPerYear: z.number().int().positive().optional(),
      termNames: z.array(z.string()).optional(),
      classPeriodMinutes: z
        .number()
        .int()
        .positive()
        .optional()
        .describe(
          "Default class period length in minutes (e.g., 50). Used by lesson-planning skills to set Stage-3 arc timing without asking the teacher. Omit if periods vary.",
        ),
      yearStart: z
        .string()
        .regex(/^\d{4}-\d{2}-\d{2}$/)
        .optional()
        .describe(
          "ISO date (YYYY-MM-DD) of the first day of classes for the school year. Lets skills compute the academic week number for a given due date. Week 1 = yearStart through yearStart+6 days.",
        ),
      weeks: z
        .array(
          z.object({
            week: z.number().int().min(0),
            start: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
          }),
        )
        .optional()
        .describe(
          "Official week-number table from the school's published calendar: each entry maps a week number to the Monday (YYYY-MM-DD) it starts. A date belongs to a week when start <= date < start+7 days; dates falling in gaps between entries are school breaks. When present this table takes precedence over yearStart math. Regenerate yearly with scripts/import-week-calendar.mjs from the school's iCal feed.",
        ),
    })
    .optional(),
});

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Compute the academic week number a given date falls in.
 *
 * When the calendar has a `weeks` table, that is the official published
 * calendar with breaks already skipped (week numbers may start at 0 and jump
 * over vacation weeks) — the date is looked up against the table's 7-day
 * windows, and dates in gaps (school breaks) or outside the year return null.
 *
 * The weeks-since-yearStart math is only an approximation for schools without
 * a table: breaks are NOT skipped, so by spring it can drift several weeks
 * from the school's own numbering. It clamps to [1, weeksPerYear] and returns
 * null only when yearStart isn't configured.
 */
export function computeAcademicWeek(
  date: Date,
  calendar: NonNullable<SchoolConfig["academicCalendar"]> | undefined,
): number | null {
  if (!calendar) return null;

  if (calendar.weeks && calendar.weeks.length > 0) {
    const dateMs = date.getTime();
    let matchedWeek: { week: number; startMs: number } | null = null;
    for (const entry of calendar.weeks) {
      const startMs = Date.parse(`${entry.start}T00:00:00Z`);
      if (Number.isNaN(startMs)) continue;
      if (startMs <= dateMs && (matchedWeek === null || startMs > matchedWeek.startMs)) {
        matchedWeek = { week: entry.week, startMs };
      }
    }
    if (matchedWeek !== null && dateMs < matchedWeek.startMs + WEEK_MS) {
      return matchedWeek.week;
    }
    return null;
  }

  if (!calendar.yearStart) return null;
  const start = new Date(`${calendar.yearStart}T00:00:00Z`);
  if (Number.isNaN(start.getTime())) return null;
  const diffMs = date.getTime() - start.getTime();
  const week = Math.floor(diffMs / WEEK_MS) + 1;
  const max = calendar.weeksPerYear ?? Infinity;
  return Math.max(1, Math.min(week, max));
}

export interface AcademicWeekExplanation {
  week: number | null;
  reason: "ok" | "break" | "before_year" | "after_year" | "no_calendar";
  /** Nearest configured week before the date (break/after_year cases). `end` is that week's last day. */
  previous?: { week: number; end: string };
  /** Nearest configured week after the date (break/before_year cases). */
  next?: { week: number; start: string };
}

const DAY_MS = 24 * 60 * 60 * 1000;

function isoDate(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/**
 * Like computeAcademicWeek, but when no week matches it says WHY — a date on a
 * school break is materially different from a missing calendar, and collapsing
 * them into one message invites the model to guess a week number on the
 * teacher's behalf (e.g., raw-math estimates during vacations).
 */
export function explainAcademicWeek(
  date: Date,
  calendar: NonNullable<SchoolConfig["academicCalendar"]> | undefined,
): AcademicWeekExplanation {
  const week = computeAcademicWeek(date, calendar);
  if (week !== null) return { week, reason: "ok" };

  const weeks = calendar?.weeks;
  if (!weeks || weeks.length === 0) return { week: null, reason: "no_calendar" };

  const sorted = [...weeks].sort((a, b) => a.start.localeCompare(b.start));
  const dateMs = date.getTime();
  const firstEntry = sorted[0]!;
  const firstStartMs = Date.parse(`${firstEntry.start}T00:00:00Z`);
  if (dateMs < firstStartMs) {
    return { week: null, reason: "before_year", next: { week: firstEntry.week, start: firstEntry.start } };
  }
  const lastEntry = sorted[sorted.length - 1]!;
  const lastEndMs = Date.parse(`${lastEntry.start}T00:00:00Z`) + 7 * DAY_MS;
  if (dateMs >= lastEndMs) {
    return { week: null, reason: "after_year", previous: { week: lastEntry.week, end: isoDate(lastEndMs - DAY_MS) } };
  }

  let previousEntry = firstEntry;
  let nextEntry: (typeof sorted)[number] | undefined;
  for (const entry of sorted) {
    const startMs = Date.parse(`${entry.start}T00:00:00Z`);
    if (startMs <= dateMs) {
      previousEntry = entry;
    } else {
      nextEntry = entry;
      break;
    }
  }
  const previousEndMs = Date.parse(`${previousEntry.start}T00:00:00Z`) + 6 * DAY_MS;
  return {
    week: null,
    reason: "break",
    previous: { week: previousEntry.week, end: isoDate(previousEndMs) },
    ...(nextEntry ? { next: { week: nextEntry.week, start: nextEntry.start } } : {}),
  };
}

export type Competency = z.infer<typeof CompetencySchema>;
export type CompetencyFramework = z.infer<typeof CompetencyFrameworkSchema>;
export type PageTemplate = z.infer<typeof PageTemplateSchema>;
export type SchoolConfig = z.infer<typeof SchoolConfigSchema>;

export interface TemplateContext {
  title: string;
  /** Body content used to fill the implicit {{body}} token (and the slots.body entry if not otherwise set). */
  body?: string;
  /** Named slots used to fill {{slot:NAME}} tokens. */
  slots?: Record<string, string>;
  /** Course context, substituted into {{course_name}}, {{course_id}}, {{course_url}}. */
  courseName?: string;
  courseId?: number;
  courseUrl?: string;
}

export interface TemplateOverrides {
  /** Section names forced on (overrides default: omit). */
  includeSections?: string[];
  /** Section names forced off (overrides default: include). */
  omitSections?: string[];
}

export interface TemplateApplication {
  body: string;
  appliedTemplate: string | null;
  includedSections: string[];
  omittedSections: string[];
  warnings: string[];
}

/**
 * Apply a named page template, processing optional sections and substituting
 * built-in tokens, slot tokens, and the legacy {{body}}/{{title}} tokens.
 *
 * Template lookup:
 *   - templateName === "none"     → no wrap (returns body verbatim)
 *   - templateName === undefined  → "default" if configured, else no wrap
 *   - templateName === "<other>"  → that named template, throws if missing
 *
 * Section processing (only applies when a template is in use):
 *   - For each section declared in template.sections, decide include vs omit:
 *     include if (default === "include" AND not in omitSections) OR in includeSections
 *     omit if (default === "omit" AND not in includeSections) OR in omitSections
 *   - Omitted sections: their <!-- SECTION:NAME --> ... <!-- /SECTION:NAME --> block is stripped.
 *   - Included sections: just the markers are stripped; their content stays.
 *   - Any leftover SECTION markers (sections not declared in config) are stripped as markers only.
 *
 * Token substitution order: sections → slots → built-ins ({{body}}, {{title}}, {{course_*}}).
 */
export function applyPageTemplate(
  schoolConfig: SchoolConfig | null,
  context: TemplateContext,
  templateName?: string,
  overrides: TemplateOverrides = {},
): TemplateApplication {
  const body = context.body ?? context.slots?.body ?? "";
  const result: TemplateApplication = {
    body,
    appliedTemplate: null,
    includedSections: [],
    omittedSections: [],
    warnings: [],
  };

  if (templateName === "none") return result;
  const templates = schoolConfig?.pageTemplates;
  if (!templates || Object.keys(templates).length === 0) return result;

  const name = templateName ?? "default";
  const template = templates[name];
  if (!template) {
    if (templateName === undefined) return result;
    const available = Object.keys(templates).join(", ");
    throw new Error(
      `Unknown page template "${templateName}". Configured templates: ${available || "(none)"}. ` +
        `Pass template: "none" to bypass wrapping.`,
    );
  }

  let html = template.html;

  // --- Section processing ---
  const declaredSections = template.sections ?? {};
  const includeSet = new Set(overrides.includeSections ?? []);
  const omitSet = new Set(overrides.omitSections ?? []);
  for (const [sectionName, meta] of Object.entries(declaredSections)) {
    const explicitlyIncluded = includeSet.has(sectionName);
    const explicitlyOmitted = omitSet.has(sectionName);
    const shouldInclude =
      explicitlyIncluded || (meta.default === "include" && !explicitlyOmitted);
    if (shouldInclude) {
      result.includedSections.push(sectionName);
    } else {
      result.omittedSections.push(sectionName);
      html = stripSectionBlock(html, sectionName);
    }
  }
  // Strip any leftover SECTION markers (declared-and-kept, or undeclared)
  html = html.replace(/<!--\s*\/?SECTION:[\w-]+\s*-->\s*/g, "");

  // --- Slot substitution ---
  const slots: Record<string, string> = { ...(context.slots ?? {}) };
  if (body !== "" && slots.body === undefined) slots.body = body;
  const slotTokensInTemplate = new Set<string>();
  for (const match of template.html.matchAll(/\{\{slot:([\w-]+)\}\}/g)) {
    slotTokensInTemplate.add(match[1]!);
  }
  for (const slotName of slotTokensInTemplate) {
    const content = slots[slotName] ?? "";
    html = html.split(`{{slot:${slotName}}}`).join(content);
    if (slots[slotName] === undefined) {
      result.warnings.push(`Template "${name}" has slot "{{slot:${slotName}}}" but no content was provided — substituted empty.`);
    }
  }

  // --- Built-in tokens ---
  if (html.includes("{{body}}")) {
    html = html.split("{{body}}").join(body);
  } else if (body !== "" && !slotTokensInTemplate.has("body") && Object.keys(slotTokensInTemplate).length === 0) {
    // Pure single-slot legacy template with no {{body}} token and no slots — append.
    result.warnings.push(
      `Template "${name}" has no {{body}} token; body content was appended after the template HTML.`,
    );
    html = `${html}\n${body}`;
  }
  html = html.split("{{title}}").join(escapeHtml(context.title));
  if (context.courseName !== undefined) {
    html = html.split("{{course_name}}").join(escapeHtml(context.courseName));
  }
  if (context.courseId !== undefined) {
    html = html.split("{{course_id}}").join(String(context.courseId));
  }
  if (context.courseUrl !== undefined) {
    html = html.split("{{course_url}}").join(context.courseUrl);
  }

  result.body = html;
  result.appliedTemplate = name;
  return result;
}

function stripSectionBlock(html: string, sectionName: string): string {
  const escaped = sectionName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(
    `<!--\\s*SECTION:${escaped}\\s*-->[\\s\\S]*?<!--\\s*/SECTION:${escaped}\\s*-->\\s*`,
    "g",
  );
  return html.replace(pattern, "");
}

function escapeHtml(input: string): string {
  return input
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export interface LoadSchoolConfigOptions {
  /** Override path for testing. When omitted, reads SCHOOL_CONFIG env var. */
  configPath?: string;
  /** Where to send warnings about unreadable / invalid configs. Defaults to process.stderr. */
  warn?: (message: string) => void;
}

/**
 * Load a school config from the path supplied (or SCHOOL_CONFIG env var).
 * Returns null when no path is configured. Returns null AND writes a warning
 * when the file is missing or invalid — the MCP keeps running with generic
 * defaults; school-specific tools just behave as if no preset is loaded.
 */
export async function loadSchoolConfig(
  options: LoadSchoolConfigOptions = {},
): Promise<SchoolConfig | null> {
  const warn = options.warn ?? ((message) => process.stderr.write(`${message}\n`));
  const configPath = options.configPath ?? process.env.SCHOOL_CONFIG?.trim();
  if (!configPath) return null;

  const resolved = path.resolve(configPath);
  let raw: string;
  try {
    raw = await fs.readFile(resolved, "utf8");
  } catch (error) {
    warn(`[canvas-mcp] SCHOOL_CONFIG points at "${resolved}" but the file could not be read: ${(error as Error).message}. Continuing without a school preset.`);
    return null;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    warn(`[canvas-mcp] SCHOOL_CONFIG at "${resolved}" is not valid JSON: ${(error as Error).message}. Continuing without a school preset.`);
    return null;
  }

  const validation = SchoolConfigSchema.safeParse(parsed);
  if (!validation.success) {
    warn(
      `[canvas-mcp] SCHOOL_CONFIG at "${resolved}" failed validation: ${validation.error.issues
        .map((issue) => `${issue.path.join(".") || "<root>"}: ${issue.message}`)
        .join("; ")}. Continuing without a school preset.`,
    );
    return null;
  }

  return validation.data;
}
