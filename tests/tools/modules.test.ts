import { describe, expect, it } from "vitest";

import { buildMockCanvas, buildToolHarness } from "../_helpers/mockCanvas.js";
import { registerModuleTools } from "../../src/tools/modules.js";

interface ToolResponse {
  content?: Array<{ type: string; text: string }>;
  isError?: boolean;
  structuredContent?: Record<string, unknown>;
}

describe("registerModuleTools", () => {
  it("registers list_modules and add_module_item", () => {
    const { client } = buildMockCanvas([]);
    const harness = buildToolHarness();
    registerModuleTools(harness.server as never, client);
    expect([...harness.tools.keys()].sort()).toEqual(["add_module_item", "list_modules"]);
  });

  it("list_modules with include_items=true threads include[]=items", async () => {
    const { client, requests } = buildMockCanvas([
      {
        status: 200,
        data: [
          {
            id: 11,
            name: "Week 1",
            items: [{ id: 100, title: "Welcome", type: "SubHeader" }],
          },
        ],
      },
    ]);
    const harness = buildToolHarness();
    registerModuleTools(harness.server as never, client);

    const result = (await harness.call("list_modules", {
      course_identifier: 60366,
      include_items: true,
    })) as ToolResponse;
    expect(result.isError).toBeFalsy();
    expect(requests[0]?.url).toBe("/api/v1/courses/60366/modules");
    expect(requests[0]?.params).toMatchObject({ "include[]": ["items"] });
    const modules = result.structuredContent?.modules as Array<{ items: unknown[] }>;
    expect(modules[0]?.items).toHaveLength(1);
  });

  it("add_module_item for a Page routes content_id to module_item.page_url (Canvas API requirement)", async () => {
    const { client, requests } = buildMockCanvas([
      { status: 200, data: { id: 555, module_id: 11, position: 1, title: "Lesson Notes", type: "Page", page_url: "lesson-notes" } },
    ]);
    const harness = buildToolHarness();
    registerModuleTools(harness.server as never, client);

    const result = (await harness.call("add_module_item", {
      course_identifier: 60366,
      module_id: 11,
      type: "Page",
      title: "Lesson Notes",
      content_id: "lesson-notes",
      position: 1,
    })) as ToolResponse;
    expect(result.isError).toBeFalsy();
    expect(requests[0]?.method).toBe("POST");
    expect(requests[0]?.url).toBe("/api/v1/courses/60366/modules/11/items");
    const payload = (requests[0]?.data as { module_item: Record<string, unknown> }).module_item;
    // Canvas needs page_url for Page items, NOT content_id
    expect(payload).toEqual({ type: "Page", title: "Lesson Notes", page_url: "lesson-notes", position: 1 });
    expect(payload).not.toHaveProperty("content_id");
  });

  it("add_module_item for an Assignment routes content_id to module_item.content_id", async () => {
    const { client, requests } = buildMockCanvas([
      { status: 200, data: { id: 556, module_id: 11, position: 2, title: "HW1", type: "Assignment", content_id: 9999 } },
    ]);
    const harness = buildToolHarness();
    registerModuleTools(harness.server as never, client);
    await harness.call("add_module_item", {
      course_identifier: 60366,
      module_id: 11,
      type: "Assignment",
      title: "HW1",
      content_id: 9999,
    });
    const payload = (requests[0]?.data as { module_item: Record<string, unknown> }).module_item;
    expect(payload).toEqual({ type: "Assignment", title: "HW1", content_id: 9999 });
  });

  it("add_module_item for an ExternalUrl routes content_id to module_item.external_url", async () => {
    const { client, requests } = buildMockCanvas([
      { status: 200, data: { id: 557, module_id: 11, position: 3, title: "Reading", type: "ExternalUrl" } },
    ]);
    const harness = buildToolHarness();
    registerModuleTools(harness.server as never, client);
    await harness.call("add_module_item", {
      course_identifier: 60366,
      module_id: 11,
      type: "ExternalUrl",
      title: "Reading",
      content_id: "https://example.com/reading",
    });
    const payload = (requests[0]?.data as { module_item: Record<string, unknown> }).module_item;
    expect(payload).toEqual({
      type: "ExternalUrl",
      title: "Reading",
      external_url: "https://example.com/reading",
    });
    expect(payload).not.toHaveProperty("content_id");
  });

  it("add_module_item for a SubHeader omits content_id without erroring", async () => {
    const { client, requests } = buildMockCanvas([
      { status: 200, data: { id: 1, module_id: 11, position: 1, title: "Section", type: "SubHeader" } },
    ]);
    const harness = buildToolHarness();
    registerModuleTools(harness.server as never, client);

    const result = (await harness.call("add_module_item", {
      course_identifier: 60366,
      module_id: 11,
      type: "SubHeader",
      title: "Section",
    })) as ToolResponse;
    expect(result.isError).toBeFalsy();
    expect((requests[0]?.data as { module_item: Record<string, unknown> }).module_item).not.toHaveProperty("content_id");
  });

  it("add_module_item for Page without content_id returns a structured error", async () => {
    const { client } = buildMockCanvas([]);
    const harness = buildToolHarness();
    registerModuleTools(harness.server as never, client);

    const result = (await harness.call("add_module_item", {
      course_identifier: 60366,
      module_id: 11,
      type: "Page",
      title: "Lesson",
    })) as ToolResponse;
    expect(result.isError).toBe(true);
    expect(result.content?.[0]?.text).toMatch(/content_id is required/);
  });
});
