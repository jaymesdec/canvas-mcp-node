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
  body: z.string().describe("Page body, HTML. Will be wrapped in the school's page template unless template='none'."),
  editing_roles: z.string().optional().describe("Canvas editing_roles string (e.g., 'teachers,students')."),
  template: z
    .string()
    .optional()
    .describe(
      "Named page template from the school config (e.g., 'lesson', 'assessment', 'default'). Omit to apply the school's 'default' template if configured. Pass 'none' to skip wrapping entirely. Use list_page_templates to discover what's available.",
    ),
};

const EDIT_PAGE_CONTENT_INPUT = {
  course_identifier: z.union([z.string(), z.number()]),
  page_url: z.string(),
  title: z.string().optional(),
  body: z.string().optional(),
  editing_roles: z.string().optional(),
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

/** Strip the body field from a Canvas page response so it doesn't burn Claude tokens echoing the wrapped HTML back. */
function trimResponseBody(page: CanvasPageLite): Omit<CanvasPageLite, "body"> & { body_omitted: true } {
  const { body: _body, ...rest } = page;
  return { ...rest, body_omitted: true };
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
        "Create a Canvas wiki page. published is forced false per Franklin School cross-project rule — teacher publishes after review. By default the school's 'default' page template is applied to the body; pass template='lesson' / 'assessment' / etc. to apply a specific named template, or template='none' to skip wrapping.",
      inputSchema: CREATE_PAGE_INPUT,
    },
    async (input) => {
      const args = input as {
        course_identifier: string | number;
        title: string;
        body: string;
        editing_roles?: string;
        template?: string;
      };
      return safeHandler("create_page", async () => {
        const courseId = await canvas.resolveCourseId(args.course_identifier);
        const application = applyPageTemplate(schoolConfig, args.body, args.title, args.template);

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
        if (application.warnings.length > 0) responsePayload.warnings = application.warnings;

        const summary =
          `Created draft page "${created.title}" (slug: ${created.url})` +
          (application.appliedTemplate ? `, template: ${application.appliedTemplate}` : ", no template") +
          ".";
        return jsonResult(responsePayload, { summary });
      });
    },
  );

  server.registerTool(
    "edit_page_content",
    {
      description: "Update a Canvas wiki page's body, title, or editing_roles. Only sets fields explicitly provided. Does NOT re-apply the school template — pass already-wrapped HTML if you need it, or use create_page for a fresh template-wrapped page.",
      inputSchema: EDIT_PAGE_CONTENT_INPUT,
    },
    async (input) => {
      const args = input as {
        course_identifier: string | number;
        page_url: string;
        title?: string;
        body?: string;
        editing_roles?: string;
      };
      return safeHandler("edit_page_content", async () => {
        const courseId = await canvas.resolveCourseId(args.course_identifier);
        const wikiPagePayload: Record<string, unknown> = {};
        if (args.title !== undefined) wikiPagePayload.title = args.title;
        if (args.body !== undefined) wikiPagePayload.body = args.body;
        if (args.editing_roles !== undefined) wikiPagePayload.editing_roles = args.editing_roles;
        if (Object.keys(wikiPagePayload).length === 0) {
          throw new Error("edit_page_content: at least one of title/body/editing_roles must be provided.");
        }
        const updated = await canvas.put<CanvasPageLite>(
          `/api/v1/courses/${courseId}/pages/${encodeURIComponent(args.page_url)}`,
          { wiki_page: wikiPagePayload },
        );
        return jsonResult(trimResponseBody(updated), { summary: `Updated page "${updated.title}".` });
      });
    },
  );

  server.registerTool(
    "list_page_templates",
    {
      description:
        "List the named page templates configured in the school config. Returns template names and descriptions only — not the full HTML, to keep Claude's context light. Use the returned names with create_page(template: '<name>').",
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
        const entries = Object.entries(templates).map(([name, template]) => ({
          name,
          description: template.description ?? null,
          is_default: name === "default",
        }));
        return jsonResult(
          {
            configured: true,
            count: entries.length,
            templates: entries,
            default_applied_automatically: Boolean(templates.default),
            usage_hint:
              "Pass template: '<name>' to create_page to use a specific template. Omit the template arg to apply 'default' if configured. Pass template: 'none' to bypass wrapping.",
          },
          { summary: `${entries.length} page template(s) configured: ${entries.map((entry) => entry.name).join(", ")}.` },
        );
      });
    },
  );
}
