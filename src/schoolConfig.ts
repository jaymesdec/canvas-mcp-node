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
    })
    .optional(),
});

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
