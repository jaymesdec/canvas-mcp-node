import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import type { CanvasClient } from "../canvasClient.js";
import { jsonResult, safeHandler } from "./toolHelpers.js";

/** Module item types supported in this first cut. The full Canvas enum is larger;
 *  we ship what the plan-lesson / create-quiz skills need today and extend on demand. */
const SUPPORTED_MODULE_ITEM_TYPES = ["Page", "Assignment", "Quiz", "SubHeader"] as const;
type SupportedModuleItemType = (typeof SUPPORTED_MODULE_ITEM_TYPES)[number];

const LIST_MODULES_INPUT = {
  course_identifier: z
    .union([z.string(), z.number()])
    .describe("Canvas course code or numeric id."),
  include_items: z
    .boolean()
    .optional()
    .describe("If true, includes each module's items inline (Canvas include[]=items)."),
};

const ADD_MODULE_ITEM_INPUT = {
  course_identifier: z.union([z.string(), z.number()]),
  module_id: z.union([z.string(), z.number()]),
  type: z.enum(SUPPORTED_MODULE_ITEM_TYPES).describe(
    "Module item type. Supported: Page, Assignment, Quiz, SubHeader. Extend on demand.",
  ),
  title: z.string(),
  content_id: z
    .union([z.string(), z.number()])
    .optional()
    .describe(
      "Canvas resource id (page url, assignment id, quiz id). Required for non-SubHeader types.",
    ),
  position: z.number().int().positive().optional(),
  /** SubHeader-specific (Canvas uses 'page_url' for pages, but for SubHeader nothing extra is required). */
};

interface CanvasModule {
  id: number;
  name: string;
  position?: number;
  workflow_state?: string;
  items_count?: number;
  items?: Array<{ id: number; title: string; type: string; content_id?: number }>;
}

interface CanvasModuleItem {
  id: number;
  module_id: number;
  position: number;
  title: string;
  type: string;
  content_id?: number;
  page_url?: string;
}

export function registerModuleTools(server: McpServer, canvas: CanvasClient): void {
  server.registerTool(
    "list_modules",
    {
      description: "List Canvas modules for a course. Pass include_items=true to inline each module's items.",
      inputSchema: LIST_MODULES_INPUT,
    },
    async (input) => {
      const args = input as { course_identifier: string | number; include_items?: boolean };
      return safeHandler("list_modules", async () => {
        const courseId = await canvas.resolveCourseId(args.course_identifier);
        const params: Record<string, unknown> = {};
        if (args.include_items) params["include[]"] = ["items"];
        const { items: modules, truncated, pages } = await canvas.getPaginated<CanvasModule>(
          `/api/v1/courses/${courseId}/modules`,
          { params },
        );
        return jsonResult(
          { course_id: courseId, count: modules.length, pages, truncated, modules },
          { summary: `Course ${courseId}: ${modules.length} module(s).` },
        );
      });
    },
  );

  server.registerTool(
    "add_module_item",
    {
      description:
        "Add a single item to a Canvas module. content_id is required for Page/Assignment/Quiz; ignored for SubHeader.",
      inputSchema: ADD_MODULE_ITEM_INPUT,
    },
    async (input) => {
      const args = input as {
        course_identifier: string | number;
        module_id: string | number;
        type: SupportedModuleItemType;
        title: string;
        content_id?: string | number;
        position?: number;
      };
      return safeHandler("add_module_item", async () => {
        if (args.type !== "SubHeader" && args.content_id === undefined) {
          throw new Error(`add_module_item: content_id is required for type "${args.type}".`);
        }
        const courseId = await canvas.resolveCourseId(args.course_identifier);
        const moduleItemPayload: Record<string, unknown> = {
          type: args.type,
          title: args.title,
        };
        if (args.content_id !== undefined) moduleItemPayload.content_id = args.content_id;
        if (args.position !== undefined) moduleItemPayload.position = args.position;

        const created = await canvas.post<CanvasModuleItem>(
          `/api/v1/courses/${courseId}/modules/${args.module_id}/items`,
          { module_item: moduleItemPayload },
        );
        return jsonResult(created, {
          summary: `Added ${args.type} "${args.title}" to module ${args.module_id} (item id ${created.id}).`,
        });
      });
    },
  );
}
