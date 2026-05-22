import { describe, expect, it } from "vitest";

import { buildMockCanvas, buildToolHarness } from "../_helpers/mockCanvas.js";
import { registerPageTools } from "../../src/tools/pages.js";

interface ToolResponse {
  content?: Array<{ type: string; text: string }>;
  isError?: boolean;
  structuredContent?: Record<string, unknown>;
}

describe("registerPageTools", () => {
  it("registers all four page tools", () => {
    const { client } = buildMockCanvas([]);
    const harness = buildToolHarness();
    registerPageTools(harness.server as never, client);
    expect([...harness.tools.keys()].sort()).toEqual([
      "create_page",
      "edit_page_content",
      "get_page_content",
      "list_pages",
    ]);
  });

  it("list_pages returns slug+title+published+updated_at per item", async () => {
    const { client, requests } = buildMockCanvas([
      {
        status: 200,
        data: [
          { url: "intro", title: "Intro", published: true, updated_at: "2025-09-01T12:00:00Z" },
          { url: "syllabus", title: "Syllabus", published: false, updated_at: "2025-09-02T12:00:00Z" },
        ],
      },
    ]);
    const harness = buildToolHarness();
    registerPageTools(harness.server as never, client);

    const result = (await harness.call("list_pages", { course_identifier: 60366 })) as ToolResponse;
    expect(result.isError).toBeFalsy();
    expect(requests[0]?.url).toBe("/api/v1/courses/60366/pages");
    const pages = result.structuredContent?.wiki_pages as Array<{ url: string; published: boolean }>;
    expect(pages.map((page) => page.url)).toEqual(["intro", "syllabus"]);
    expect(pages[1]?.published).toBe(false);
  });

  it("get_page_content URL-encodes the slug and returns the body", async () => {
    const { client, requests } = buildMockCanvas([
      { status: 200, data: { url: "weird slug", title: "Weird", body: "<p>body</p>" } },
    ]);
    const harness = buildToolHarness();
    registerPageTools(harness.server as never, client);

    const result = (await harness.call("get_page_content", {
      course_identifier: 60366,
      page_url: "weird slug",
    })) as ToolResponse;
    expect(result.isError).toBeFalsy();
    expect(requests[0]?.url).toBe("/api/v1/courses/60366/pages/weird%20slug");
    expect(result.structuredContent?.body).toBe("<p>body</p>");
  });

  it("create_page forces published: false", async () => {
    const { client, requests } = buildMockCanvas([
      { status: 200, data: { url: "new", title: "New", published: false } },
    ]);
    const harness = buildToolHarness();
    registerPageTools(harness.server as never, client);

    await harness.call("create_page", {
      course_identifier: 60366,
      title: "New Page",
      body: "<p>hello</p>",
      // Caller does not pass published — and even if they did, we force false.
    });
    const payload = (requests[0]?.data as { wiki_page: Record<string, unknown> }).wiki_page;
    expect(payload.title).toBe("New Page");
    expect(payload.body).toBe("<p>hello</p>");
    expect(payload.published).toBe(false);
  });

  it("edit_page_content only sends fields explicitly provided", async () => {
    const { client, requests } = buildMockCanvas([
      { status: 200, data: { url: "intro", title: "Intro updated" } },
    ]);
    const harness = buildToolHarness();
    registerPageTools(harness.server as never, client);

    await harness.call("edit_page_content", {
      course_identifier: 60366,
      page_url: "intro",
      title: "Intro updated",
    });
    expect(requests[0]?.method).toBe("PUT");
    expect(requests[0]?.url).toBe("/api/v1/courses/60366/pages/intro");
    const payload = (requests[0]?.data as { wiki_page: Record<string, unknown> }).wiki_page;
    expect(payload).toEqual({ title: "Intro updated" });
    expect(payload).not.toHaveProperty("body");
  });

  it("edit_page_content errors when no fields are provided", async () => {
    const { client } = buildMockCanvas([]);
    const harness = buildToolHarness();
    registerPageTools(harness.server as never, client);

    const result = (await harness.call("edit_page_content", {
      course_identifier: 60366,
      page_url: "intro",
    })) as ToolResponse;
    expect(result.isError).toBe(true);
    expect(result.content?.[0]?.text).toMatch(/at least one of title\/body\/editing_roles/);
  });
});
