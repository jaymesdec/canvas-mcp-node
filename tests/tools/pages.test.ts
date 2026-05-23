import { describe, expect, it } from "vitest";

import { buildMockCanvas, buildToolHarness } from "../_helpers/mockCanvas.js";
import { registerPageTools } from "../../src/tools/pages.js";
import type { SchoolConfig } from "../../src/schoolConfig.js";

interface ToolResponse {
  content?: Array<{ type: string; text: string }>;
  isError?: boolean;
  structuredContent?: Record<string, unknown>;
}

const templatedConfig: SchoolConfig = {
  schoolName: "Test School",
  pageTemplates: {
    default: {
      description: "Generic header wrap",
      html: "<div class=\"wrap\"><h1>{{title}}</h1>{{body}}</div>",
    },
    lesson: {
      description: "Lesson page",
      html: "<article class=\"lesson\"><h2>{{title}}</h2><section>{{body}}</section></article>",
    },
    assessment: {
      description: "Assessment page",
      html: "<article class=\"assessment\"><h2>{{title}}</h2>{{body}}</article>",
    },
    headerOnly: {
      description: "Header without a body token — body should append.",
      html: "<header>{{title}}</header>",
    },
    multiSlot: {
      description: "Template with named slots and conditional sections",
      html:
        "<header data-course=\"{{course_name}}\" data-id=\"{{course_id}}\">\n" +
        "  <a href=\"{{course_url}}/modules\">Modules</a>\n" +
        "  <h1>{{title}}</h1>\n" +
        "</header>\n" +
        "<section class=\"about\">{{slot:about}}</section>\n" +
        "<section class=\"skills\">{{slot:to}}</section>\n" +
        "<!-- SECTION:discussion -->\n" +
        "<section class=\"discussion\">{{slot:discussion}}</section>\n" +
        "<!-- /SECTION:discussion -->\n" +
        "<!-- SECTION:assessment -->\n" +
        "<section class=\"assessment\">{{slot:assessment}}</section>\n" +
        "<!-- /SECTION:assessment -->",
      slots: {
        about: { description: "What the lesson covers" },
        to: { description: "Skills students gain" },
        discussion: { description: "Discussion prompt — only when used" },
        assessment: { description: "Linked assessment" },
      },
      sections: {
        discussion: { default: "omit", description: "Discussion accordion. Off by default." },
        assessment: { default: "include", description: "Linked assessment accordion. On by default." },
      },
    },
  },
};

describe("registerPageTools", () => {
  it("registers all five page tools", () => {
    const { client } = buildMockCanvas([]);
    const harness = buildToolHarness();
    registerPageTools(harness.server as never, client);
    expect([...harness.tools.keys()].sort()).toEqual([
      "create_page",
      "edit_page_content",
      "get_page_content",
      "list_page_templates",
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

  describe("page templates", () => {
    it("create_page applies the 'default' template when no template arg is passed", async () => {
      const { client, requests } = buildMockCanvas([
        { status: 200, data: { url: "lesson-1", title: "Lesson 1", body: "<wrapped/>", published: false } },
      ]);
      const harness = buildToolHarness();
      registerPageTools(harness.server as never, client, templatedConfig);

      const result = (await harness.call("create_page", {
        course_identifier: 60366,
        title: "Lesson 1",
        body: "<p>Hello</p>",
      })) as ToolResponse;
      expect(result.isError).toBeFalsy();
      const payload = (requests[0]?.data as { wiki_page: { body: string } }).wiki_page;
      expect(payload.body).toBe('<div class="wrap"><h1>Lesson 1</h1><p>Hello</p></div>');
      expect(result.structuredContent?.template_applied).toBe("default");
      // Response should NOT echo the wrapped body back (token-saving).
      expect(result.structuredContent).not.toHaveProperty("body");
      expect(result.structuredContent?.body_omitted).toBe(true);
    });

    it("create_page uses the explicit lesson template when template='lesson'", async () => {
      const { client, requests } = buildMockCanvas([
        { status: 200, data: { url: "x", title: "Lesson X", published: false } },
      ]);
      const harness = buildToolHarness();
      registerPageTools(harness.server as never, client, templatedConfig);

      const result = (await harness.call("create_page", {
        course_identifier: 60366,
        title: "Lesson X",
        body: "<p>Body</p>",
        template: "lesson",
      })) as ToolResponse;
      const payload = (requests[0]?.data as { wiki_page: { body: string } }).wiki_page;
      expect(payload.body).toBe('<article class="lesson"><h2>Lesson X</h2><section><p>Body</p></section></article>');
      expect(result.structuredContent?.template_applied).toBe("lesson");
    });

    it("create_page uses the assessment template when template='assessment'", async () => {
      const { client, requests } = buildMockCanvas([
        { status: 200, data: { url: "x", title: "Quiz 1", published: false } },
      ]);
      const harness = buildToolHarness();
      registerPageTools(harness.server as never, client, templatedConfig);

      await harness.call("create_page", {
        course_identifier: 60366,
        title: "Quiz 1",
        body: "<p>Take the quiz.</p>",
        template: "assessment",
      });
      const payload = (requests[0]?.data as { wiki_page: { body: string } }).wiki_page;
      expect(payload.body).toBe('<article class="assessment"><h2>Quiz 1</h2><p>Take the quiz.</p></article>');
    });

    it("create_page with template='none' bypasses wrapping entirely", async () => {
      const { client, requests } = buildMockCanvas([
        { status: 200, data: { url: "raw", title: "Raw", published: false } },
      ]);
      const harness = buildToolHarness();
      registerPageTools(harness.server as never, client, templatedConfig);

      const result = (await harness.call("create_page", {
        course_identifier: 60366,
        title: "Raw",
        body: "<p>Untouched</p>",
        template: "none",
      })) as ToolResponse;
      const payload = (requests[0]?.data as { wiki_page: { body: string } }).wiki_page;
      expect(payload.body).toBe("<p>Untouched</p>");
      expect(result.structuredContent?.template_applied).toBeNull();
    });

    it("create_page surfaces a clear error when an unknown template name is passed", async () => {
      const { client, requests } = buildMockCanvas([]);
      const harness = buildToolHarness();
      registerPageTools(harness.server as never, client, templatedConfig);

      const result = (await harness.call("create_page", {
        course_identifier: 60366,
        title: "x",
        body: "<p>x</p>",
        template: "rubric",
      })) as ToolResponse;
      expect(result.isError).toBe(true);
      expect(result.content?.[0]?.text).toMatch(/Unknown page template "rubric"/);
      expect(result.content?.[0]?.text).toMatch(/Configured templates: default, lesson, assessment, headerOnly/);
      // Importantly: no Canvas write happened.
      expect(requests).toHaveLength(0);
    });

    it("create_page appends body when a template has no {{body}} token + surfaces a warning", async () => {
      const { client, requests } = buildMockCanvas([
        { status: 200, data: { url: "x", title: "Hdr", published: false } },
      ]);
      const harness = buildToolHarness();
      registerPageTools(harness.server as never, client, templatedConfig);
      const result = (await harness.call("create_page", {
        course_identifier: 60366,
        title: "Hdr",
        body: "<p>Body</p>",
        template: "headerOnly",
      })) as ToolResponse;
      const payload = (requests[0]?.data as { wiki_page: { body: string } }).wiki_page;
      expect(payload.body).toBe("<header>Hdr</header>\n<p>Body</p>");
      const warnings = result.structuredContent?.warnings as string[];
      expect(warnings?.[0]).toMatch(/no \{\{body\}\} token/);
    });

    it("create_page works unchanged when no schoolConfig is loaded (generic deployment)", async () => {
      const { client, requests } = buildMockCanvas([
        { status: 200, data: { url: "x", title: "x", published: false } },
      ]);
      const harness = buildToolHarness();
      registerPageTools(harness.server as never, client, null);
      const result = (await harness.call("create_page", {
        course_identifier: 60366,
        title: "Plain",
        body: "<p>Plain body</p>",
      })) as ToolResponse;
      const payload = (requests[0]?.data as { wiki_page: { body: string } }).wiki_page;
      expect(payload.body).toBe("<p>Plain body</p>");
      expect(result.structuredContent?.template_applied).toBeNull();
    });

    it("create_page HTML-escapes the title when substituting into the template", async () => {
      const { client, requests } = buildMockCanvas([
        { status: 200, data: { url: "x", title: "x", published: false } },
      ]);
      const harness = buildToolHarness();
      registerPageTools(harness.server as never, client, templatedConfig);
      await harness.call("create_page", {
        course_identifier: 60366,
        title: 'Bobby <script>alert("xss")</script>',
        body: "<p>safe</p>",
      });
      const payload = (requests[0]?.data as { wiki_page: { body: string } }).wiki_page;
      expect(payload.body).toContain("&lt;script&gt;");
      expect(payload.body).not.toContain("<script>alert");
    });

    it("list_page_templates returns names + descriptions only (no HTML)", async () => {
      const { client } = buildMockCanvas([]);
      const harness = buildToolHarness();
      registerPageTools(harness.server as never, client, templatedConfig);
      const result = (await harness.call("list_page_templates")) as ToolResponse;
      expect(result.isError).toBeFalsy();
      const templates = result.structuredContent?.templates as Array<Record<string, unknown>>;
      expect(templates.map((entry) => entry.name).sort()).toEqual(["assessment", "default", "headerOnly", "lesson", "multiSlot"]);
      // No 'html' field on any entry — we don't burn tokens echoing back the template HTML.
      for (const entry of templates) {
        expect(entry).not.toHaveProperty("html");
      }
      expect(result.structuredContent?.default_applied_automatically).toBe(true);
    });

    it("list_page_templates returns a 'not configured' response when no templates exist", async () => {
      const { client } = buildMockCanvas([]);
      const harness = buildToolHarness();
      registerPageTools(harness.server as never, client, null);
      const result = (await harness.call("list_page_templates")) as ToolResponse;
      expect(result.structuredContent?.configured).toBe(false);
      expect(result.structuredContent?.count).toBe(0);
      expect(result.structuredContent?.message).toMatch(/SCHOOL_CONFIG/i);
    });
  });

  describe("slots + sections (multi-slot templates)", () => {
    it("substitutes named slots and built-in course tokens; default-omit sections are stripped", async () => {
      const { client, requests } = buildMockCanvas([
        // course details fetch for {{course_name}}
        { status: 200, data: { id: 60366, name: "Design 9", course_code: "DSGN_9_120251" } },
        // create_page POST
        { status: 200, data: { url: "lesson-1", title: "Lesson 1", published: false } },
      ]);
      const harness = buildToolHarness();
      registerPageTools(harness.server as never, client, templatedConfig);
      const result = (await harness.call("create_page", {
        course_identifier: 60366,
        title: "Lesson 1",
        template: "multiSlot",
        slots: {
          about: "<p>The water cycle</p>",
          to: "<ul><li>Diagram a watershed</li></ul>",
          assessment: "<p>Quiz on Friday</p>",
        },
      })) as ToolResponse;

      expect(result.isError).toBeFalsy();
      const payload = (requests[1]?.data as { wiki_page: { body: string } }).wiki_page;
      expect(payload.body).toContain("data-course=\"Design 9\"");
      expect(payload.body).toContain("data-id=\"60366\"");
      expect(payload.body).toContain("href=\"https://canvas.example.com/courses/60366/modules\"");
      expect(payload.body).toContain("<h1>Lesson 1</h1>");
      expect(payload.body).toContain("<p>The water cycle</p>");
      expect(payload.body).toContain("<li>Diagram a watershed</li>");
      // assessment is default-include — should be present
      expect(payload.body).toContain("<p>Quiz on Friday</p>");
      expect(payload.body).toContain("class=\"assessment\"");
      // discussion is default-omit — should NOT be present
      expect(payload.body).not.toContain("class=\"discussion\"");
      // SECTION markers themselves should be stripped
      expect(payload.body).not.toContain("<!-- SECTION:");
      expect(payload.body).not.toContain("<!-- /SECTION:");
      // structuredContent surfaces what was included/omitted
      expect(result.structuredContent?.included_sections).toEqual(["assessment"]);
      expect(result.structuredContent?.omitted_sections).toEqual(["discussion"]);
    });

    it("include_sections forces a default-omit section ON", async () => {
      const { client, requests } = buildMockCanvas([
        { status: 200, data: { id: 60366, name: "Design 9" } },
        { status: 200, data: { url: "x", title: "x", published: false } },
      ]);
      const harness = buildToolHarness();
      registerPageTools(harness.server as never, client, templatedConfig);
      const result = (await harness.call("create_page", {
        course_identifier: 60366,
        title: "Debate",
        template: "multiSlot",
        slots: { about: "x", to: "x", discussion: "<p>What do you think?</p>" },
        include_sections: ["discussion"],
      })) as ToolResponse;
      const payload = (requests[1]?.data as { wiki_page: { body: string } }).wiki_page;
      expect(payload.body).toContain("class=\"discussion\"");
      expect(payload.body).toContain("<p>What do you think?</p>");
      expect(result.structuredContent?.included_sections).toEqual(
        expect.arrayContaining(["discussion", "assessment"]),
      );
    });

    it("omit_sections forces a default-include section OFF", async () => {
      const { client, requests } = buildMockCanvas([
        { status: 200, data: { id: 60366, name: "Design 9" } },
        { status: 200, data: { url: "x", title: "x", published: false } },
      ]);
      const harness = buildToolHarness();
      registerPageTools(harness.server as never, client, templatedConfig);
      const result = (await harness.call("create_page", {
        course_identifier: 60366,
        title: "Formative only",
        template: "multiSlot",
        slots: { about: "x", to: "x" },
        omit_sections: ["assessment"],
      })) as ToolResponse;
      const payload = (requests[1]?.data as { wiki_page: { body: string } }).wiki_page;
      expect(payload.body).not.toContain("class=\"assessment\"");
      expect(result.structuredContent?.omitted_sections).toEqual(
        expect.arrayContaining(["assessment", "discussion"]),
      );
    });

    it("warns when a template has a slot token but the call doesn't provide content", async () => {
      const { client } = buildMockCanvas([
        { status: 200, data: { id: 60366, name: "Design 9" } },
        { status: 200, data: { url: "x", title: "x", published: false } },
      ]);
      const harness = buildToolHarness();
      registerPageTools(harness.server as never, client, templatedConfig);
      const result = (await harness.call("create_page", {
        course_identifier: 60366,
        title: "Empty Slots",
        template: "multiSlot",
        slots: { about: "x" },
        // 'to' is in the template but not provided — should warn
      })) as ToolResponse;
      const warnings = result.structuredContent?.warnings as string[];
      expect(warnings.some((line) => line.includes("{{slot:to}}"))).toBe(true);
    });

    it("HTML-escapes the course_name token (defense against malicious course rename)", async () => {
      const { client, requests } = buildMockCanvas([
        { status: 200, data: { id: 60366, name: '<img src=x onerror="alert(1)">' } },
        { status: 200, data: { url: "x", title: "x", published: false } },
      ]);
      const harness = buildToolHarness();
      registerPageTools(harness.server as never, client, templatedConfig);
      await harness.call("create_page", {
        course_identifier: 60366,
        title: "x",
        template: "multiSlot",
        slots: { about: "x", to: "x" },
      });
      const payload = (requests[1]?.data as { wiki_page: { body: string } }).wiki_page;
      expect(payload.body).toContain("&lt;img");
      expect(payload.body).not.toContain('onerror="alert(1)"');
    });

    it("list_page_templates surfaces slot + section metadata (descriptions only, no HTML)", async () => {
      const { client } = buildMockCanvas([]);
      const harness = buildToolHarness();
      registerPageTools(harness.server as never, client, templatedConfig);
      const result = (await harness.call("list_page_templates")) as ToolResponse;
      const templates = result.structuredContent?.templates as Array<{
        name: string;
        slots: Array<{ name: string; description: string | null }>;
        sections: Array<{ name: string; default: string }>;
      }>;
      const multiSlot = templates.find((entry) => entry.name === "multiSlot")!;
      expect(multiSlot.slots.map((slot) => slot.name).sort()).toEqual([
        "about",
        "assessment",
        "discussion",
        "to",
      ]);
      expect(multiSlot.sections).toEqual(
        expect.arrayContaining([
          { name: "discussion", description: expect.any(String), default: "omit" },
          { name: "assessment", description: expect.any(String), default: "include" },
        ]),
      );
    });
  });
});
