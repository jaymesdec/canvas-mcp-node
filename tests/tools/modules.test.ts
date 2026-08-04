import { describe, expect, it } from "vitest";

import { buildMockCanvas, buildToolHarness, parseJsonResult, type ToolResponse } from "../_helpers/mockCanvas.js";
import { registerModuleTools } from "../../src/tools/modules.js";

describe("registerModuleTools", () => {
  it("registers the module tools", () => {
    const { client } = buildMockCanvas([]);
    const harness = buildToolHarness();
    registerModuleTools(harness.server as never, client);
    expect([...harness.tools.keys()].sort()).toEqual([
      "add_module_item",
      "create_module",
      "delete_module",
      "delete_module_item",
      "list_modules",
      "update_module",
      "update_module_item",
    ]);
  });

  describe("create_module", () => {
    it("POSTs the module name and returns the created module", async () => {
      const { client, requests } = buildMockCanvas([
        {
          status: 200,
          data: {
            id: 999,
            name: "Module 4: Vibe Coding: Transforming Text into Functional Software with AI (Weeks 24-36)",
            position: 4,
            workflow_state: "unpublished",
          },
        },
      ]);
      const harness = buildToolHarness();
      registerModuleTools(harness.server as never, client);
      const result = (await harness.call("create_module", {
        course_identifier: 60366,
        name: "Module 4: Vibe Coding: Transforming Text into Functional Software with AI (Weeks 24-36)",
      })) as ToolResponse;
      expect(result.isError).toBeFalsy();
      expect(requests[0]?.method).toBe("POST");
      expect(requests[0]?.url).toBe("/api/v1/courses/60366/modules");
      const payload = (requests[0]?.data as { module: Record<string, unknown> }).module;
      // Does NOT include any publish-related fields — relies on Canvas's unpublished default
      expect(payload).not.toHaveProperty("published");
      expect(payload).not.toHaveProperty("workflow_state");
      expect(payload.name).toContain("Module 4");
      const created = (parseJsonResult(result).module as { workflow_state?: string });
      expect(created.workflow_state).toBe("unpublished");
    });

    it("threads optional prerequisite_module_ids, position, and unlock_at", async () => {
      const { client, requests } = buildMockCanvas([
        { status: 200, data: { id: 1000, name: "Module 5", workflow_state: "unpublished" } },
      ]);
      const harness = buildToolHarness();
      registerModuleTools(harness.server as never, client);
      await harness.call("create_module", {
        course_identifier: 60366,
        name: "Module 5",
        position: 5,
        prerequisite_module_ids: [999],
        require_sequential_progress: true,
        unlock_at: "2026-09-01T08:00:00Z",
      });
      const payload = (requests[0]?.data as { module: Record<string, unknown> }).module;
      expect(payload).toEqual({
        name: "Module 5",
        position: 5,
        prerequisite_module_ids: [999],
        require_sequential_progress: true,
        unlock_at: "2026-09-01T08:00:00Z",
      });
    });
  });

  it("list_modules with include_items=true threads include[]=items and returns trimmed modules + items", async () => {
    const { client, requests } = buildMockCanvas([
      {
        status: 200,
        data: [
          {
            id: 11,
            name: "Week 1",
            position: 1,
            workflow_state: "active",
            published: true,
            items_count: 1,
            unlock_at: null,
            require_sequential_progress: false,
            prerequisite_module_ids: [],
            items_url: "https://canvas.example.com/api/v1/courses/60366/modules/11/items",
            items: [
              {
                id: 100,
                title: "Welcome",
                type: "SubHeader",
                position: 1,
                published: true,
                indent: 0,
                html_url: "https://canvas.example.com/courses/60366/modules/items/100",
              },
            ],
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
    const modules = parseJsonResult(result).modules as Array<Record<string, unknown>>;
    expect(modules[0]?.items).toHaveLength(1);
    expect(Object.keys(modules[0]!).sort()).toEqual(
      [
        "id",
        "name",
        "position",
        "workflow_state",
        "published",
        "items_count",
        "unlock_at",
        "require_sequential_progress",
        "prerequisite_module_ids",
        "items",
      ].sort(),
    );
    const items = modules[0]?.items as Array<Record<string, unknown>>;
    expect(Object.keys(items[0]!).sort()).toEqual(
      ["id", "title", "type", "content_id", "page_url", "position", "published"].sort(),
    );
    expect(JSON.stringify(parseJsonResult(result))).not.toContain("items_url");
  });

  it("list_modules without include_items returns trimmed modules with no items key", async () => {
    const { client } = buildMockCanvas([
      { status: 200, data: [{ id: 11, name: "Week 1", position: 1, workflow_state: "active" }] },
    ]);
    const harness = buildToolHarness();
    registerModuleTools(harness.server as never, client);
    const result = (await harness.call("list_modules", { course_identifier: 60366 })) as ToolResponse;
    const modules = parseJsonResult(result).modules as Array<Record<string, unknown>>;
    expect(modules[0]).not.toHaveProperty("items");
    expect(modules[0]?.name).toBe("Week 1");
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

  it("add_module_item re-resolves a cached course code instead of trusting the cache (bypassCache)", async () => {
    const enrollmentListResponse = {
      status: 200,
      data: [{ id: 60366, course_code: "DSGN_9_120251", name: "Design 9", workflow_state: "available", term: { name: "Fall 2025" } }],
    };
    const { client, requests } = buildMockCanvas([
      enrollmentListResponse,
      enrollmentListResponse,
      { status: 200, data: { id: 556, module_id: 11, position: 2, title: "HW1", type: "Assignment", content_id: 9999 } },
    ]);
    await client.resolveCourseId("DSGN_9_120251"); // warm the cache
    const harness = buildToolHarness();
    registerModuleTools(harness.server as never, client);
    const result = (await harness.call("add_module_item", {
      course_identifier: "DSGN_9_120251",
      module_id: 11,
      type: "Assignment",
      title: "HW1",
      content_id: 9999,
    })) as ToolResponse;
    expect(result.isError).toBeFalsy();
    expect(requests.filter((request) => request.url === "/api/v1/courses")).toHaveLength(2);
    expect(requests.at(-1)?.url).toBe("/api/v1/courses/60366/modules/11/items");
  });

  describe("update_module", () => {
    it("PUTs only the provided fields and never includes published anywhere in the payload", async () => {
      const { client, requests } = buildMockCanvas([
        {
          status: 200,
          data: {
            id: 999,
            name: "Module 4: Renamed",
            position: 2,
            workflow_state: "unpublished",
            published: false,
          },
        },
      ]);
      const harness = buildToolHarness();
      registerModuleTools(harness.server as never, client);

      const result = (await harness.call("update_module", {
        course_identifier: 60366,
        module_id: 999,
        name: "Module 4: Renamed",
        position: 2,
      })) as ToolResponse;
      expect(result.isError).toBeFalsy();
      expect(requests[0]?.method).toBe("PUT");
      expect(requests[0]?.url).toBe("/api/v1/courses/60366/modules/999");
      const body = requests[0]?.data as { module: Record<string, unknown> };
      expect(body.module).toEqual({ name: "Module 4: Renamed", position: 2 });
      expect(JSON.stringify(body)).not.toContain("published");
      const payload = parseJsonResult(result);
      expect((payload.module as { name?: string }).name).toBe("Module 4: Renamed");
    });

    it("threads prerequisite_module_ids, require_sequential_progress, and unlock_at when provided", async () => {
      const { client, requests } = buildMockCanvas([
        { status: 200, data: { id: 999, name: "Module 4", workflow_state: "unpublished" } },
      ]);
      const harness = buildToolHarness();
      registerModuleTools(harness.server as never, client);
      await harness.call("update_module", {
        course_identifier: 60366,
        module_id: 999,
        prerequisite_module_ids: [998],
        require_sequential_progress: true,
        unlock_at: "2026-09-01T08:00:00Z",
      });
      const body = requests[0]?.data as { module: Record<string, unknown> };
      expect(body.module).toEqual({
        prerequisite_module_ids: [998],
        require_sequential_progress: true,
        unlock_at: "2026-09-01T08:00:00Z",
      });
      expect(JSON.stringify(body)).not.toContain("published");
    });

    it("returns a structured error when no updatable fields are provided", async () => {
      const { client, requests } = buildMockCanvas([]);
      const harness = buildToolHarness();
      registerModuleTools(harness.server as never, client);
      const result = (await harness.call("update_module", {
        course_identifier: 60366,
        module_id: 999,
      })) as ToolResponse;
      expect(result.isError).toBe(true);
      expect(result.content?.[0]?.text).toMatch(/no fields to update/);
      expect(requests).toHaveLength(0);
    });
  });

  describe("delete_module", () => {
    it("DELETEs the module and names it in a summary stating content survives", async () => {
      const { client, requests } = buildMockCanvas([
        {
          status: 200,
          data: { id: 999, name: "Module 4: Duplicate", position: 4, workflow_state: "unpublished" },
        },
      ]);
      const harness = buildToolHarness();
      registerModuleTools(harness.server as never, client);

      const result = (await harness.call("delete_module", {
        course_identifier: 60366,
        module_id: 999,
      })) as ToolResponse;
      expect(result.isError).toBeFalsy();
      expect(requests[0]?.method).toBe("DELETE");
      expect(requests[0]?.url).toBe("/api/v1/courses/60366/modules/999");
      const summaryText = result.content?.[0]?.text ?? "";
      expect(summaryText).toContain('Deleted module "Module 4: Duplicate"');
      expect(summaryText).toContain("pages/assignments inside remain in the course");
    });

    it("surfaces a 404 for a nonexistent module with tool context", async () => {
      const { client } = buildMockCanvas([
        { status: 404, data: { errors: [{ message: "The specified resource does not exist." }] } },
      ]);
      const harness = buildToolHarness();
      registerModuleTools(harness.server as never, client);
      const result = (await harness.call("delete_module", {
        course_identifier: 60366,
        module_id: 424242,
      })) as ToolResponse;
      expect(result.isError).toBe(true);
      expect(result.content?.[0]?.text).toMatch(/^delete_module: /);
      expect(result.content?.[0]?.text).toContain("404");
    });
  });

  describe("delete_module_item", () => {
    it("DELETEs the item at the nested items path, names item and module in the summary, and trims the item", async () => {
      const { client, requests } = buildMockCanvas([
        {
          status: 200,
          data: {
            id: 555,
            module_id: 11,
            position: 1,
            title: "Lesson Notes",
            type: "Page",
            page_url: "lesson-notes",
            published: false,
            html_url: "https://canvas.example.com/courses/60366/modules/items/555",
            url: "https://canvas.example.com/api/v1/courses/60366/pages/lesson-notes",
          },
        },
      ]);
      const harness = buildToolHarness();
      registerModuleTools(harness.server as never, client);

      const result = (await harness.call("delete_module_item", {
        course_identifier: 60366,
        module_id: 11,
        item_id: 555,
      })) as ToolResponse;
      expect(result.isError).toBeFalsy();
      expect(requests[0]?.method).toBe("DELETE");
      expect(requests[0]?.url).toBe("/api/v1/courses/60366/modules/11/items/555");
      const summaryText = result.content?.[0]?.text ?? "";
      expect(summaryText).toContain('"Lesson Notes"');
      expect(summaryText).toContain("module 11");
      const item = parseJsonResult(result).item as Record<string, unknown>;
      expect(Object.keys(item).sort()).toEqual(
        ["id", "title", "type", "content_id", "page_url", "position", "published"].sort(),
      );
      expect(JSON.stringify(item)).not.toContain("html_url");
    });

    it("surfaces a 404 for a nonexistent item with tool context", async () => {
      const { client } = buildMockCanvas([
        { status: 404, data: { errors: [{ message: "The specified resource does not exist." }] } },
      ]);
      const harness = buildToolHarness();
      registerModuleTools(harness.server as never, client);
      const result = (await harness.call("delete_module_item", {
        course_identifier: 60366,
        module_id: 11,
        item_id: 424242,
      })) as ToolResponse;
      expect(result.isError).toBe(true);
      expect(result.content?.[0]?.text).toMatch(/^delete_module_item: /);
      expect(result.content?.[0]?.text).toContain("404");
    });
  });

  describe("update_module_item", () => {
    it("PUTs only the provided fields to the nested items path and returns the trimmed item", async () => {
      const { client, requests } = buildMockCanvas([
        {
          status: 200,
          data: {
            id: 555,
            module_id: 11,
            position: 3,
            title: "Renamed Notes",
            type: "Page",
            page_url: "lesson-notes",
            published: false,
            indent: 1,
            html_url: "https://canvas.example.com/courses/60366/modules/items/555",
          },
        },
      ]);
      const harness = buildToolHarness();
      registerModuleTools(harness.server as never, client);

      const result = (await harness.call("update_module_item", {
        course_identifier: 60366,
        module_id: 11,
        item_id: 555,
        title: "Renamed Notes",
        position: 3,
      })) as ToolResponse;
      expect(result.isError).toBeFalsy();
      expect(requests[0]?.method).toBe("PUT");
      expect(requests[0]?.url).toBe("/api/v1/courses/60366/modules/11/items/555");
      const body = requests[0]?.data as { module_item: Record<string, unknown> };
      expect(body.module_item).toEqual({ title: "Renamed Notes", position: 3 });
      expect(JSON.stringify(body)).not.toContain("published");
      const item = parseJsonResult(result).item as Record<string, unknown>;
      expect(Object.keys(item).sort()).toEqual(
        ["id", "title", "type", "content_id", "page_url", "position", "published"].sort(),
      );
      expect(item.title).toBe("Renamed Notes");
      expect(JSON.stringify(item)).not.toContain("html_url");
    });

    it("threads indent and new_tab when provided", async () => {
      const { client, requests } = buildMockCanvas([
        { status: 200, data: { id: 557, module_id: 11, position: 3, title: "Reading", type: "ExternalUrl" } },
      ]);
      const harness = buildToolHarness();
      registerModuleTools(harness.server as never, client);
      await harness.call("update_module_item", {
        course_identifier: 60366,
        module_id: 11,
        item_id: 557,
        indent: 2,
        new_tab: true,
      });
      const body = requests[0]?.data as { module_item: Record<string, unknown> };
      expect(body.module_item).toEqual({ indent: 2, new_tab: true });
    });

    it("returns a structured error when no updatable fields are provided, with zero Canvas calls", async () => {
      const { client, requests } = buildMockCanvas([]);
      const harness = buildToolHarness();
      registerModuleTools(harness.server as never, client);
      const result = (await harness.call("update_module_item", {
        course_identifier: 60366,
        module_id: 11,
        item_id: 555,
      })) as ToolResponse;
      expect(result.isError).toBe(true);
      expect(result.content?.[0]?.text).toMatch(/no fields to update/);
      expect(requests).toHaveLength(0);
    });
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
