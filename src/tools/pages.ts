import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import type { CanvasClient } from "../canvasClient.js";
import { applyPageTemplate, type SchoolConfig } from "../schoolConfig.js";
import { jsonResult, safeHandler } from "./toolHelpers.js";

const LIST_PAGES_INPUT = {
  course_identifier: z.union([z.string(), z.number()]),
};

const GET_PAGE_CONTENT_INPUT = {
  course_identifier: z.union([z.string(), z.number()]),
  page_url: z.string().describe("Canvas page url slug (the part after /pages/)."),
};

const CREATE_PAGE_INPUT = {
  course_identifier: z.union([z.string(), z.number()]),
  title: z.string(),
  body: z
    .string()
    .optional()
    .describe(
      "Page body HTML used for single-slot templates (filled into the {{body}} token). For multi-slot templates like 'lesson', pass `slots` instead.",
    ),
  slots: z
    .record(z.string(), z.string())
    .optional()
    .describe(
      "Named content for multi-slot templates. Keys map to {{slot:NAME}} tokens in the template HTML. Discover slot names via list_page_templates.",
    ),
  editing_roles: z.string().optional().describe("Canvas editing_roles string (e.g., 'teachers,students')."),
  template: z
    .string()
    .optional()
    .describe(
      "Named page template from the school config (e.g., 'lesson', 'assessment', 'default'). Omit to apply 'default'. Pass 'none' to skip wrapping. Use list_page_templates to discover what's available.",
    ),
  include_sections: z
    .array(z.string())
    .optional()
    .describe(
      "Force-add optional sections that are default-omit (e.g., ['discussion']). Discover section names via list_page_templates.",
    ),
  omit_sections: z
    .array(z.string())
    .optional()
    .describe(
      "Force-remove sections that are default-include (e.g., ['assessment']). Discover section names via list_page_templates.",
    ),
};

const EDIT_PAGE_CONTENT_INPUT = {
  course_identifier: z.union([z.string(), z.number()]),
  page_url: z.string(),
  title: z.string().optional(),
  body: z
    .string()
    .optional()
    .describe(
      "Page body HTML. For multi-slot templates, pass `slots` instead. Sent verbatim only when no template machinery is engaged.",
    ),
  slots: z
    .record(z.string(), z.string())
    .optional()
    .describe(
      "Named content for multi-slot templates. When provided (or when `template` / `include_sections` / `omit_sections` is provided), the body is REBUILT from the template using these slots — pass ALL slots you want in the new page, not just the ones that changed. Use get_page_content first if you need the current values.",
    ),
  editing_roles: z.string().optional(),
  template: z
    .string()
    .optional()
    .describe(
      "Named page template from the school config (e.g., 'lesson', 'assessment'). Pass to re-apply the template with the supplied slots. Pass 'none' to skip template machinery entirely (only `title`, `body`, `editing_roles` are sent). When omitted with no other template args, behaves as a simple field-update.",
    ),
  include_sections: z
    .array(z.string())
    .optional()
    .describe(
      "When re-applying a template, force-add optional sections that are default-omit (e.g., ['discussion']).",
    ),
  omit_sections: z
    .array(z.string())
    .optional()
    .describe(
      "When re-applying a template, force-remove sections that are default-include (e.g., ['assessment']).",
    ),
};

const DELETE_PAGE_INPUT = {
  course_identifier: z.union([z.string(), z.number()]),
  page_url: z.string().describe("Page URL slug (the part after /pages/ in the Canvas URL)."),
};

interface CanvasPageLite {
  url: string;
  title: string;
  body?: string;
  published?: boolean;
  updated_at?: string;
  editing_roles?: string;
  html_url?: string;
}

interface CanvasCourseLite {
  id: number;
  name?: string;
  course_code?: string;
}

function trimResponseBody(page: CanvasPageLite): Omit<CanvasPageLite, "body"> & { body_omitted: true } {
  const { body: _body, ...rest } = page;
  return { ...rest, body_omitted: true };
}

/** Derive https://<host>/courses/<id> from CANVAS_API_URL + course id. */
function deriveCourseUrl(canvas: CanvasClient, courseId: number): string {
  const base = canvas.baseUrl.replace(/\/+$/, "").replace(/\/api\/v1$/, "");
  return `${base}/courses/${courseId}`;
}

export function registerPageTools(
  server: McpServer,
  canvas: CanvasClient,
  schoolConfig: SchoolConfig | null = null,
): void {
  server.registerTool(
    "list_pages",
    {
      description: "List wiki pages in a Canvas course (slug, title, published flag, updated_at).",
      inputSchema: LIST_PAGES_INPUT,
    },
    async (input) => {
      const args = input as { course_identifier: string | number };
      return safeHandler("list_pages", async () => {
        const courseId = await canvas.resolveCourseId(args.course_identifier);
        const { items: pages, truncated, pages: pageCount } = await canvas.getPaginated<CanvasPageLite>(
          `/api/v1/courses/${courseId}/pages`,
        );
        return jsonResult(
          {
            course_id: courseId,
            count: pages.length,
            pages: pageCount,
            truncated,
            wiki_pages: pages.map((page) => ({
              url: page.url,
              title: page.title,
              published: page.published ?? null,
              updated_at: page.updated_at ?? null,
            })),
          },
          { summary: `Course ${courseId}: ${pages.length} page(s).` },
        );
      });
    },
  );

  server.registerTool(
    "get_page_content",
    {
      description: "Fetch the full body and metadata of a Canvas wiki page by url slug.",
      inputSchema: GET_PAGE_CONTENT_INPUT,
    },
    async (input) => {
      const args = input as { course_identifier: string | number; page_url: string };
      return safeHandler("get_page_content", async () => {
        const courseId = await canvas.resolveCourseId(args.course_identifier);
        const page = await canvas.get<CanvasPageLite>(
          `/api/v1/courses/${courseId}/pages/${encodeURIComponent(args.page_url)}`,
        );
        return jsonResult(page, { summary: `Page ${page.url}: "${page.title}"` });
      });
    },
  );

  server.registerTool(
    "create_page",
    {
      description:
        "Create a NEW Canvas wiki page. **For changes to an existing page (adding a section, swapping content, etc.), use edit_page_content instead — create_page on an existing title creates a duplicate with a -2/-3 slug.** " +
        "published is forced false per Franklin School cross-project rule — teacher publishes after review. " +
        "Body is wrapped in the school's 'default' page template by default; pass template='lesson' / 'assessment' / etc. to choose a specific named template, or template='none' to skip wrapping. " +
        "Multi-slot templates (like 'lesson') need content via slots={about: ..., concepts: ..., ...}; discover slot names via list_page_templates. " +
        "include_sections / omit_sections override the template's default optional-section state per-call.",
      inputSchema: CREATE_PAGE_INPUT,
    },
    async (input) => {
      const args = input as {
        course_identifier: string | number;
        title: string;
        body?: string;
        slots?: Record<string, string>;
        editing_roles?: string;
        template?: string;
        include_sections?: string[];
        omit_sections?: string[];
      };
      return safeHandler("create_page", async () => {
        const courseId = await canvas.resolveCourseId(args.course_identifier, { bypassCache: true });

        // Fetch course.name only when the chosen template actually needs it.
        // Saves an API call per create_page when the template doesn't use {{course_name}}.
        let courseName: string | undefined;
        const templateName = args.template ?? "default";
        const chosenTemplate = schoolConfig?.pageTemplates?.[templateName];
        if (chosenTemplate?.html.includes("{{course_name}}")) {
          try {
            const course = await canvas.get<CanvasCourseLite>(`/api/v1/courses/${courseId}`);
            courseName = course.name;
          } catch {
            // ignore; the {{course_name}} token will substitute as empty
          }
        }

        const application = applyPageTemplate(
          schoolConfig,
          {
            title: args.title,
            body: args.body,
            slots: args.slots,
            courseName,
            courseId,
            courseUrl: deriveCourseUrl(canvas, courseId),
          },
          args.template,
          {
            includeSections: args.include_sections,
            omitSections: args.omit_sections,
          },
        );

        const wikiPagePayload: Record<string, unknown> = {
          title: args.title,
          body: application.body,
          published: false,
        };
        if (args.editing_roles) wikiPagePayload.editing_roles = args.editing_roles;

        const created = await canvas.post<CanvasPageLite>(
          `/api/v1/courses/${courseId}/pages`,
          { wiki_page: wikiPagePayload },
        );

        const responsePayload: Record<string, unknown> = {
          ...trimResponseBody(created),
          template_applied: application.appliedTemplate,
        };
        if (application.includedSections.length > 0) responsePayload.included_sections = application.includedSections;
        if (application.omittedSections.length > 0) responsePayload.omitted_sections = application.omittedSections;
        if (application.warnings.length > 0) responsePayload.warnings = application.warnings;

        const summary =
          `Created draft page "${created.title}" (slug: ${created.url})` +
          (application.appliedTemplate ? `, template: ${application.appliedTemplate}` : ", no template") +
          (application.omittedSections.length > 0 ? `, omitted: ${application.omittedSections.join(", ")}` : "") +
          ".";
        return jsonResult(responsePayload, { summary });
      });
    },
  );

  server.registerTool(
    "edit_page_content",
    {
      description:
        "Update an existing Canvas wiki page (use this, not create_page, for any change to a page that already exists). " +
        "Two modes: " +
        "(1) Simple field update — pass any of `title`, `body`, `editing_roles` and they replace the existing values; nothing else is touched. " +
        "(2) Re-apply template — pass `template`, `slots`, and/or `include_sections`/`omit_sections` to rebuild the body from the school template (same machinery as create_page). " +
        "When re-applying a template, pass ALL slots you want in the result, not just the ones that changed — the body is rebuilt from scratch. " +
        "Pass `template: 'none'` to force simple-field-update mode even if slots/section args are also provided.",
      inputSchema: EDIT_PAGE_CONTENT_INPUT,
    },
    async (input) => {
      const args = input as {
        course_identifier: string | number;
        page_url: string;
        title?: string;
        body?: string;
        slots?: Record<string, string>;
        editing_roles?: string;
        template?: string;
        include_sections?: string[];
        omit_sections?: string[];
      };
      return safeHandler("edit_page_content", async () => {
        const courseId = await canvas.resolveCourseId(args.course_identifier, { bypassCache: true });

        // Decide whether to engage template machinery
        const hasTemplateArgs =
          args.template !== undefined ||
          args.slots !== undefined ||
          args.include_sections !== undefined ||
          args.omit_sections !== undefined;
        const skipTemplate = args.template === "none";
        const usingTemplate = hasTemplateArgs && !skipTemplate;

        const wikiPagePayload: Record<string, unknown> = {};
        let templateInfo: {
          appliedTemplate: string | null;
          includedSections: string[];
          omittedSections: string[];
          warnings: string[];
        } | null = null;

        if (usingTemplate) {
          // Need the title to fill {{title}}; fetch existing if not provided
          let resolvedTitle = args.title;
          if (resolvedTitle === undefined) {
            const current = await canvas.get<CanvasPageLite>(
              `/api/v1/courses/${courseId}/pages/${encodeURIComponent(args.page_url)}`,
            );
            resolvedTitle = current.title;
          }

          // Fetch course.name only if the chosen template references {{course_name}}
          let courseName: string | undefined;
          const templateName = args.template ?? "default";
          const chosenTemplate = schoolConfig?.pageTemplates?.[templateName];
          if (chosenTemplate?.html.includes("{{course_name}}")) {
            try {
              const course = await canvas.get<CanvasCourseLite>(`/api/v1/courses/${courseId}`);
              courseName = course.name;
            } catch {
              // ignore — {{course_name}} substitutes as empty
            }
          }

          const application = applyPageTemplate(
            schoolConfig,
            {
              title: resolvedTitle,
              body: args.body,
              slots: args.slots,
              courseName,
              courseId,
              courseUrl: deriveCourseUrl(canvas, courseId),
            },
            args.template,
            {
              includeSections: args.include_sections,
              omitSections: args.omit_sections,
            },
          );
          templateInfo = {
            appliedTemplate: application.appliedTemplate,
            includedSections: application.includedSections,
            omittedSections: application.omittedSections,
            warnings: application.warnings,
          };

          // Only include the title in the PUT if the caller explicitly passed one.
          // (We fetched the existing title just to fill {{title}}; we don't want
          // to overwrite the Canvas title field with a value the caller didn't ask
          // to change.)
          if (args.title !== undefined) wikiPagePayload.title = args.title;
          wikiPagePayload.body = application.body;
        } else {
          if (args.title !== undefined) wikiPagePayload.title = args.title;
          if (args.body !== undefined) wikiPagePayload.body = args.body;
        }
        if (args.editing_roles !== undefined) wikiPagePayload.editing_roles = args.editing_roles;

        if (Object.keys(wikiPagePayload).length === 0) {
          throw new Error(
            "edit_page_content: at least one of title/body/slots/template/include_sections/omit_sections/editing_roles must be provided.",
          );
        }

        const updated = await canvas.put<CanvasPageLite>(
          `/api/v1/courses/${courseId}/pages/${encodeURIComponent(args.page_url)}`,
          { wiki_page: wikiPagePayload },
        );

        const responsePayload: Record<string, unknown> = { ...trimResponseBody(updated) };
        if (templateInfo) {
          responsePayload.template_applied = templateInfo.appliedTemplate;
          if (templateInfo.includedSections.length > 0)
            responsePayload.included_sections = templateInfo.includedSections;
          if (templateInfo.omittedSections.length > 0)
            responsePayload.omitted_sections = templateInfo.omittedSections;
          if (templateInfo.warnings.length > 0) responsePayload.warnings = templateInfo.warnings;
        }

        const summary =
          `Updated page "${updated.title}"` +
          (templateInfo?.appliedTemplate ? ` (template: ${templateInfo.appliedTemplate})` : "") +
          (templateInfo && templateInfo.omittedSections.length > 0
            ? `, omitted: ${templateInfo.omittedSections.join(", ")}`
            : "") +
          ".";
        return jsonResult(responsePayload, { summary });
      });
    },
  );

  server.registerTool(
    "delete_page",
    {
      description:
        "Permanently delete a Canvas wiki page. Bypasses the course-code cache (re-resolves every call) so a rename can't misroute the delete. Use for cleaning up orphan/test/duplicate pages.",
      inputSchema: DELETE_PAGE_INPUT,
    },
    async (input) => {
      const args = input as { course_identifier: string | number; page_url: string };
      return safeHandler("delete_page", async () => {
        const courseId = await canvas.resolveCourseId(args.course_identifier, { bypassCache: true });
        const deleted = await canvas.del<CanvasPageLite>(
          `/api/v1/courses/${courseId}/pages/${encodeURIComponent(args.page_url)}`,
        );
        return jsonResult(
          { course_id: courseId, page_url: args.page_url, deleted: trimResponseBody(deleted) },
          { summary: `Deleted page "${deleted.title}" (slug: ${args.page_url}) from course ${courseId}.` },
        );
      });
    },
  );

  server.registerTool(
    "list_page_templates",
    {
      description:
        "List the named page templates configured in the school config — including their slot names (multi-section content holes) and optional sections (default include/omit state). Returns names + descriptions only; the full HTML stays server-side to keep Claude's context light.",
      inputSchema: {},
    },
    async () => {
      return safeHandler("list_page_templates", async () => {
        const templates = schoolConfig?.pageTemplates;
        if (!templates || Object.keys(templates).length === 0) {
          return jsonResult(
            {
              configured: false,
              count: 0,
              templates: [],
              message:
                "No page templates configured. Set SCHOOL_CONFIG in the MCP server env to a JSON file containing a 'pageTemplates' object with named entries (e.g., 'default', 'lesson', 'assessment') to apply institutional HTML wrappers automatically on create_page. See configs/example.json in the canvas-mcp repo for the expected shape.",
            },
            { summary: "No page templates configured." },
          );
        }
        const entries = Object.entries(templates).map(([name, template]) => {
          const slots = template.slots
            ? Object.entries(template.slots).map(([slotName, meta]) => ({
                name: slotName,
                description: meta.description ?? null,
              }))
            : [];
          const sections = template.sections
            ? Object.entries(template.sections).map(([sectionName, meta]) => ({
                name: sectionName,
                description: meta.description ?? null,
                default: meta.default,
              }))
            : [];
          return {
            name,
            description: template.description ?? null,
            title_format: template.titleFormat ?? null,
            is_default: name === "default",
            slots,
            sections,
          };
        });
        return jsonResult(
          {
            configured: true,
            count: entries.length,
            templates: entries,
            default_applied_automatically: Boolean(templates.default),
            usage_hint:
              "create_page(template: '<name>', slots: {...}, include_sections: [...], omit_sections: [...]). " +
              "For multi-slot templates, populate slots with one entry per slot name from the template's `slots` list. " +
              "Optional sections obey their default include/omit state unless override arrays say otherwise. " +
              "When `title_format` is set on a template, generate the page title to that format ({var} placeholders are filled by the calling skill); when null, propose your own title.",
          },
          { summary: `${entries.length} page template(s) configured: ${entries.map((entry) => entry.name).join(", ")}.` },
        );
      });
    },
  );
}
