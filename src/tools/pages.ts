import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import type { CanvasClient } from "../canvasClient.js";
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
  body: z.string().describe("Page body, HTML."),
  editing_roles: z.string().optional().describe("Canvas editing_roles string (e.g., 'teachers,students')."),
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
}

export function registerPageTools(server: McpServer, canvas: CanvasClient): void {
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
        "Create a Canvas wiki page. published is forced false per Franklin School cross-project rule — teacher publishes after review.",
      inputSchema: CREATE_PAGE_INPUT,
    },
    async (input) => {
      const args = input as {
        course_identifier: string | number;
        title: string;
        body: string;
        editing_roles?: string;
      };
      return safeHandler("create_page", async () => {
        const courseId = await canvas.resolveCourseId(args.course_identifier);
        const wikiPagePayload: Record<string, unknown> = {
          title: args.title,
          body: args.body,
          published: false,
        };
        if (args.editing_roles) wikiPagePayload.editing_roles = args.editing_roles;

        const created = await canvas.post<CanvasPageLite>(
          `/api/v1/courses/${courseId}/pages`,
          { wiki_page: wikiPagePayload },
        );
        return jsonResult(created, {
          summary: `Created draft page "${created.title}" (slug: ${created.url}).`,
        });
      });
    },
  );

  server.registerTool(
    "edit_page_content",
    {
      description: "Update a Canvas wiki page's body, title, or editing_roles. Only sets fields explicitly provided.",
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
        return jsonResult(updated, { summary: `Updated page "${updated.title}".` });
      });
    },
  );
}
