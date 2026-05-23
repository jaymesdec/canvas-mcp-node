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
      "Template HTML. Use {{title}} and {{body}} tokens where the page title and body content should be injected. If {{body}} is missing, the body is appended after the template (useful for header-only templates).",
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

export interface TemplateApplication {
  /** The resulting body to POST to Canvas. */
  body: string;
  /** Which template was applied (e.g., "default", "lesson"), or null if none. */
  appliedTemplate: string | null;
  /** Non-fatal warnings (e.g., "{{body}} missing — appended at end"). */
  warnings: string[];
}

/**
 * Apply a named page template to `body`, using `{{title}}` and `{{body}}` as
 * substitution tokens. Returns the body unchanged when no template is configured
 * or `templateName` is "none".
 *
 * Lookup rules:
 *   - templateName === "none"         → no wrap (returns body verbatim)
 *   - templateName === undefined      → uses "default" if configured, else no wrap
 *   - templateName === "<other>"      → uses that named template, throws if missing
 */
export function applyPageTemplate(
  schoolConfig: SchoolConfig | null,
  body: string,
  title: string,
  templateName?: string,
): TemplateApplication {
  if (templateName === "none") {
    return { body, appliedTemplate: null, warnings: [] };
  }
  const templates = schoolConfig?.pageTemplates;
  if (!templates || Object.keys(templates).length === 0) {
    return { body, appliedTemplate: null, warnings: [] };
  }
  const name = templateName ?? "default";
  const template = templates[name];
  if (!template) {
    if (templateName === undefined) {
      // Caller didn't ask for one; "default" simply isn't configured.
      return { body, appliedTemplate: null, warnings: [] };
    }
    const available = Object.keys(templates).join(", ");
    throw new Error(
      `Unknown page template "${templateName}". Configured templates: ${available || "(none)"}. ` +
        `Pass template: "none" to bypass wrapping.`,
    );
  }

  const warnings: string[] = [];
  let html = template.html;
  const hasBodyToken = html.includes("{{body}}");
  if (hasBodyToken) {
    html = html.split("{{body}}").join(body);
  } else {
    warnings.push(
      `Template "${name}" has no {{body}} token; body content was appended after the template HTML.`,
    );
    html = `${html}\n${body}`;
  }
  // Title substitution is optional. Templates without {{title}} just don't get it.
  html = html.split("{{title}}").join(escapeHtml(title));
  return { body: html, appliedTemplate: name, warnings };
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
