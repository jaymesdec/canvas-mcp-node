import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { z } from "zod";

import {
  buildMockCanvas,
  buildToolHarness,
  parseJsonResult,
  type FakeResponse,
  type ToolResponse,
} from "../_helpers/mockCanvas.js";
import { Anonymizer } from "../../src/anonymizer.js";
import { registerDiscussionTools } from "../../src/tools/discussions.js";
import { DISCUSSION_SCRUB_NOTE } from "../../src/tools/discussionAnonymizer.js";

const COURSE_ID = 60366;

const STAFF_PAGE: FakeResponse = {
  status: 200,
  data: [{ id: 5000, name: "Mr. Smith" }],
};

const STUDENT_PAGE: FakeResponse = {
  status: 200,
  data: [
    { id: 1001, name: "Grace Park" },
    { id: 1002, name: "Ana Maria" },
  ],
};

let anonRoot: string;
let anonymizer: Anonymizer;
beforeEach(async () => {
  anonRoot = await fs.mkdtemp(path.join(os.tmpdir(), "canvas-anon-disc-tools-"));
  anonymizer = new Anonymizer({ rootDir: anonRoot });
  await anonymizer.init();
});
afterEach(async () => {
  await fs.rm(anonRoot, { recursive: true, force: true });
  delete process.env.CANVAS_MCP_ALLOW_DEANONYMIZE;
  delete process.env.CANVAS_MCP_MIN_ANNOUNCEMENT_DELAY_MINUTES;
});

function buildHarness(responses: FakeResponse[]) {
  const { client, requests } = buildMockCanvas(responses);
  const harness = buildToolHarness();
  registerDiscussionTools(harness.server as never, client, anonymizer);
  return { harness, requests };
}

function inputSchemaOf(harness: ReturnType<typeof buildToolHarness>, toolName: string): z.ZodObject<z.ZodRawShape> {
  const tool = harness.tools.get(toolName);
  if (!tool) throw new Error(`tool ${toolName} not registered`);
  return z.object(tool.inputSchema as z.ZodRawShape);
}

function minutesFromNow(minutes: number): string {
  return new Date(Date.now() + minutes * 60_000).toISOString();
}

describe("registerDiscussionTools", () => {
  it("registers all nine discussion/announcement tools", () => {
    const { harness } = buildHarness([]);
    expect([...harness.tools.keys()].sort()).toEqual([
      "create_announcement",
      "create_discussion",
      "delete_announcement",
      "delete_discussion",
      "get_discussion",
      "list_announcements",
      "list_discussions",
      "update_announcement",
      "update_discussion",
    ]);
  });

  describe("list_discussions", () => {
    it("returns trimmed topics with reply_count from discussion_subentry_count", async () => {
      const { harness, requests } = buildHarness([
        {
          status: 200,
          data: [
            {
              id: 11,
              title: "Week 5 debate",
              published: true,
              posted_at: "2026-05-01T12:00:00Z",
              discussion_type: "threaded",
              locked: false,
              pinned: true,
              delayed_post_at: null,
              discussion_subentry_count: 7,
              message: "<p>huge body that must not appear</p>",
              permissions: { attach: true },
            },
          ],
        },
      ]);
      const result = (await harness.call("list_discussions", { course_identifier: COURSE_ID })) as ToolResponse;
      expect(requests[0]?.url).toBe(`/api/v1/courses/${COURSE_ID}/discussion_topics`);
      const payload = parseJsonResult(result);
      expect(payload.discussions).toEqual([
        {
          id: 11,
          title: "Week 5 debate",
          published: true,
          posted_at: "2026-05-01T12:00:00Z",
          discussion_type: "threaded",
          locked: false,
          pinned: true,
          delayed_post_at: null,
          reply_count: 7,
        },
      ]);
    });
  });

  describe("get_discussion", () => {
    const TOPIC: FakeResponse = {
      status: 200,
      data: {
        id: 42,
        title: "Partner feedback",
        message: "<p>Reply to your assigned partner: Grace Park or Ana Maria.</p>",
        published: true,
        posted_at: "2026-05-01T12:00:00Z",
        delayed_post_at: null,
        discussion_type: "threaded",
        locked: false,
        pinned: false,
        is_announcement: false,
        user_name: "Mr. Smith",
        author: { id: 5000, display_name: "Mr. Smith" },
      },
    };

    const ENTRIES: FakeResponse = {
      status: 200,
      data: [
        {
          id: 101,
          user_id: 1001,
          user_name: "Grace Park",
          message: "I agree with Ana Maria!",
          created_at: "2026-05-02T09:00:00Z",
          recent_replies: [
            { id: 201, user_id: 1002, user_name: "Ana Maria", message: "Thanks Grace" },
          ],
        },
        { id: 102, user_id: 5000, user_name: "Mr. Smith", message: "Great thread.", created_at: "2026-05-02T10:00:00Z" },
      ],
    };

    it("anonymizes student entry authors, keeps staff verbatim, and scrubs the topic body (R3a: raw names absent everywhere)", async () => {
      const { harness, requests } = buildHarness([TOPIC, ENTRIES, STAFF_PAGE, STUDENT_PAGE]);
      const result = (await harness.call("get_discussion", {
        course_identifier: COURSE_ID,
        topic_id: 42,
      })) as ToolResponse;

      expect(requests[1]?.url).toBe(`/api/v1/courses/${COURSE_ID}/discussion_topics/42/entries`);
      const payload = parseJsonResult(result);
      expect(payload.anonymized).toBe(true);
      const topic = payload.topic as { message: string; author: { id: number; name: string } };
      expect(topic.message).toBe("<p>Reply to your assigned partner: Student 1 or Student 2.</p>");
      expect(topic.author).toEqual({ id: 5000, name: "Mr. Smith" });

      const entries = payload.entries as Array<{
        user_name: string;
        message: string;
        recent_replies: Array<{ user_name: string; message: string }> | null;
      }>;
      expect(entries[0]?.user_name).toBe("Student 1");
      expect(entries[0]?.message).toBe("I agree with Student 2!");
      expect(entries[0]?.recent_replies?.[0]?.user_name).toBe("Student 2");
      expect(entries[0]?.recent_replies?.[0]?.message).toBe("Thanks Student 1");
      expect(entries[1]?.user_name).toBe("Mr. Smith");

      const serialized = JSON.stringify(payload);
      expect(serialized).not.toContain("Grace");
      expect(serialized).not.toContain("Park");
      expect(serialized).not.toContain("Ana");
      expect(serialized).not.toContain("Maria");
      expect(serialized).toContain("Mr. Smith");
      expect(payload.warnings).toContain(DISCUSSION_SCRUB_NOTE);
    });

    it("scrubs the topic body and warns even when entries are not fetched", async () => {
      const { harness, requests } = buildHarness([TOPIC, STAFF_PAGE, STUDENT_PAGE]);
      const result = (await harness.call("get_discussion", {
        course_identifier: COURSE_ID,
        topic_id: 42,
        include_entries: false,
      })) as ToolResponse;

      expect(requests.filter((request) => request.url.endsWith("/entries"))).toHaveLength(0);
      const payload = parseJsonResult(result);
      expect((payload.topic as { message: string }).message).toContain("Student 1");
      expect(payload.entries).toBeNull();
      expect(payload.warnings).toContain(DISCUSSION_SCRUB_NOTE);
    });

    it("forces anonymous and adds a warning when anonymous=false without the env gate", async () => {
      const { harness } = buildHarness([TOPIC, ENTRIES, STAFF_PAGE, STUDENT_PAGE]);
      const result = (await harness.call("get_discussion", {
        course_identifier: COURSE_ID,
        topic_id: 42,
        anonymous: false,
      })) as ToolResponse;

      const payload = parseJsonResult(result);
      expect(payload.anonymized).toBe(true);
      const warnings = payload.warnings as string[];
      expect(warnings.some((warning) => warning.includes("CANVAS_MCP_ALLOW_DEANONYMIZE"))).toBe(true);
      expect(JSON.stringify(payload)).not.toContain("Grace Park");
    });

    it("surfaces an entries-fetch 403 as a structured error naming the tool", async () => {
      const { harness } = buildHarness([
        TOPIC,
        { status: 403, data: { errors: [{ message: "require_initial_post" }] } },
      ]);
      const result = (await harness.call("get_discussion", {
        course_identifier: COURSE_ID,
        topic_id: 42,
      })) as ToolResponse;
      expect(result.isError).toBe(true);
      expect(result.content?.[0]?.text).toMatch(/^get_discussion: /);
      expect(result.content?.[0]?.text).toContain("403");
    });

    it("returns real names for anonymous=false when the env gate is set", async () => {
      process.env.CANVAS_MCP_ALLOW_DEANONYMIZE = "true";
      const { harness, requests } = buildHarness([TOPIC, ENTRIES]);
      const result = (await harness.call("get_discussion", {
        course_identifier: COURSE_ID,
        topic_id: 42,
        anonymous: false,
      })) as ToolResponse;

      expect(requests).toHaveLength(2);
      const payload = parseJsonResult(result);
      expect(payload.anonymized).toBe(false);
      expect(payload.warnings).toBeUndefined();
      const entries = payload.entries as Array<{ user_name: string }>;
      expect(entries[0]?.user_name).toBe("Grace Park");
      expect((payload.topic as { message: string }).message).toContain("Grace Park");
    });
  });

  describe("create_discussion", () => {
    it("always sends published: false", async () => {
      const { harness, requests } = buildHarness([
        { status: 200, data: { id: 55, title: "New topic", published: false } },
      ]);
      const result = (await harness.call("create_discussion", {
        course_identifier: COURSE_ID,
        title: "New topic",
        message: "<p>Hello</p>",
        discussion_type: "threaded",
      })) as ToolResponse;

      expect(requests[0]?.method).toBe("POST");
      expect(requests[0]?.url).toBe(`/api/v1/courses/${COURSE_ID}/discussion_topics`);
      expect(requests[0]?.data).toMatchObject({
        title: "New topic",
        message: "<p>Hello</p>",
        discussion_type: "threaded",
        published: false,
      });
      const text = result.content?.[0]?.text ?? "";
      expect(text).toContain("draft");
    });
  });

  describe("update_discussion", () => {
    it("sends a partial PUT with only the provided fields", async () => {
      const { harness, requests } = buildHarness([
        { status: 200, data: { id: 42, is_announcement: false } },
        { status: 200, data: { id: 42, title: "Renamed" } },
      ]);
      const result = (await harness.call("update_discussion", {
        course_identifier: COURSE_ID,
        topic_id: 42,
        title: "Renamed",
      })) as ToolResponse;

      expect(result.isError).toBeFalsy();
      expect(requests[1]?.method).toBe("PUT");
      expect(requests[1]?.url).toBe(`/api/v1/courses/${COURSE_ID}/discussion_topics/42`);
      expect(requests[1]?.data).toEqual({ title: "Renamed" });
    });

    it("refuses announcements with a pointer to update_announcement and zero PUTs", async () => {
      const { harness, requests } = buildHarness([
        { status: 200, data: { id: 43, is_announcement: true } },
      ]);
      const result = (await harness.call("update_discussion", {
        course_identifier: COURSE_ID,
        topic_id: 43,
        title: "Sneaky rename",
      })) as ToolResponse;

      expect(result.isError).toBe(true);
      expect(result.content?.[0]?.text).toContain("update_announcement");
      expect(requests.filter((request) => request.method === "PUT")).toHaveLength(0);
    });

    it("rejects published: true at the schema level and accepts published: false", () => {
      const { harness } = buildHarness([]);
      const schema = inputSchemaOf(harness, "update_discussion");
      expect(
        schema.safeParse({ course_identifier: COURSE_ID, topic_id: 42, published: true }).success,
      ).toBe(false);
      expect(
        schema.safeParse({ course_identifier: COURSE_ID, topic_id: 42, published: false }).success,
      ).toBe(true);
    });

    it("errors when no updatable field is provided, with zero Canvas calls", async () => {
      const { harness, requests } = buildHarness([]);
      const result = (await harness.call("update_discussion", {
        course_identifier: COURSE_ID,
        topic_id: 42,
      })) as ToolResponse;
      expect(result.isError).toBe(true);
      expect(requests).toHaveLength(0);
    });
  });

  describe("list_announcements", () => {
    it("lists with only_announcements=true and surfaces post_delayed items with their scheduled time", async () => {
      const { harness, requests } = buildHarness([
        {
          status: 200,
          data: [
            {
              id: 61,
              title: "Live announcement",
              posted_at: "2026-05-01T12:00:00Z",
              delayed_post_at: null,
              workflow_state: "active",
              published: true,
            },
            {
              id: 62,
              title: "Scheduled announcement",
              posted_at: null,
              delayed_post_at: "2026-09-01T13:00:00Z",
              workflow_state: "post_delayed",
              published: true,
            },
          ],
        },
      ]);
      const result = (await harness.call("list_announcements", { course_identifier: COURSE_ID })) as ToolResponse;

      expect(requests[0]?.url).toBe(`/api/v1/courses/${COURSE_ID}/discussion_topics`);
      expect(requests[0]?.params).toMatchObject({ only_announcements: true });
      const announcements = parseJsonResult(result).announcements as Array<Record<string, unknown>>;
      expect(announcements).toHaveLength(2);
      expect(announcements[1]).toEqual({
        id: 62,
        title: "Scheduled announcement",
        posted_at: null,
        delayed_post_at: "2026-09-01T13:00:00Z",
        workflow_state: "post_delayed",
        published: true,
      });
    });
  });

  describe("create_announcement", () => {
    it("requires delayed_post_at at the schema level and errors at runtime with zero POSTs", async () => {
      const { harness, requests } = buildHarness([]);
      const schema = inputSchemaOf(harness, "create_announcement");
      expect(
        schema.safeParse({ course_identifier: COURSE_ID, title: "T", message: "M" }).success,
      ).toBe(false);

      const result = (await harness.call("create_announcement", {
        course_identifier: COURSE_ID,
        title: "T",
        message: "M",
      })) as ToolResponse;
      expect(result.isError).toBe(true);
      expect(result.content?.[0]?.text).toContain("delayed_post_at");
      expect(requests).toHaveLength(0);
    });

    it("rejects a past timestamp with zero POSTs", async () => {
      const { harness, requests } = buildHarness([]);
      const result = (await harness.call("create_announcement", {
        course_identifier: COURSE_ID,
        title: "T",
        message: "M",
        delayed_post_at: minutesFromNow(-60),
      })) as ToolResponse;
      expect(result.isError).toBe(true);
      expect(result.content?.[0]?.text).toContain("minutes in the future");
      expect(requests).toHaveLength(0);
    });

    it("rejects a 10-minute-out timestamp under the default 30-minute floor with zero POSTs", async () => {
      const { harness, requests } = buildHarness([]);
      const result = (await harness.call("create_announcement", {
        course_identifier: COURSE_ID,
        title: "T",
        message: "M",
        delayed_post_at: minutesFromNow(10),
      })) as ToolResponse;
      expect(result.isError).toBe(true);
      expect(result.content?.[0]?.text).toContain("30");
      expect(requests).toHaveLength(0);
    });

    it("rejects an unparseable timestamp with zero POSTs", async () => {
      const { harness, requests } = buildHarness([]);
      const result = (await harness.call("create_announcement", {
        course_identifier: COURSE_ID,
        title: "T",
        message: "M",
        delayed_post_at: "2026-02-30T99:99:99Z",
      })) as ToolResponse;
      expect(result.isError).toBe(true);
      expect(result.content?.[0]?.text).toContain("parseable");
      expect(requests).toHaveLength(0);
    });

    it("rejects an offset-less ISO string with zero POSTs", async () => {
      const { harness, requests } = buildHarness([]);
      const result = (await harness.call("create_announcement", {
        course_identifier: COURSE_ID,
        title: "T",
        message: "M",
        delayed_post_at: "2099-01-01T12:00:00",
      })) as ToolResponse;
      expect(result.isError).toBe(true);
      expect(result.content?.[0]?.text).toContain("offset");
      expect(requests).toHaveLength(0);
    });

    it("creates with is_announcement: true, echoes the scheduled time in the summary and the message in the payload", async () => {
      const delayedPostAt = minutesFromNow(60);
      const { harness, requests } = buildHarness([
        {
          status: 200,
          data: {
            id: 70,
            title: "Field trip",
            message: "<p>Details</p>",
            workflow_state: "post_delayed",
            delayed_post_at: delayedPostAt,
            published: true,
          },
        },
      ]);
      const result = (await harness.call("create_announcement", {
        course_identifier: COURSE_ID,
        title: "Field trip",
        message: "<p>Details</p>",
        delayed_post_at: delayedPostAt,
      })) as ToolResponse;

      expect(result.isError).toBeFalsy();
      expect(requests[0]?.method).toBe("POST");
      expect(requests[0]?.data).toMatchObject({
        title: "Field trip",
        message: "<p>Details</p>",
        is_announcement: true,
        delayed_post_at: delayedPostAt,
      });
      expect(result.content?.[0]?.text).toContain(delayedPostAt);
      expect(result.content?.[0]?.text).toContain("goes live at");
      const announcement = parseJsonResult(result).announcement as Record<string, unknown>;
      expect(announcement.message).toBe("<p>Details</p>");
    });

    it("deletes the created topic and raises an error carrying its id when Canvas returns workflow_state active", async () => {
      const { harness, requests } = buildHarness([
        { status: 200, data: { id: 71, title: "Oops", workflow_state: "active" } },
        { status: 200, data: {} },
      ]);
      const result = (await harness.call("create_announcement", {
        course_identifier: COURSE_ID,
        title: "Oops",
        message: "M",
        delayed_post_at: minutesFromNow(60),
      })) as ToolResponse;

      expect(result.isError).toBe(true);
      expect(result.content?.[0]?.text).toContain("71");
      expect(result.content?.[0]?.text).toContain("went live immediately");
      expect(requests[1]?.method).toBe("DELETE");
      expect(requests[1]?.url).toBe(`/api/v1/courses/${COURSE_ID}/discussion_topics/71`);
    });

    it("still raises the went-live error carrying the id when the cleanup DELETE itself fails", async () => {
      const { harness, requests } = buildHarness([
        { status: 200, data: { id: 72, title: "Oops", workflow_state: "active" } },
        { status: 500, data: { errors: [{ message: "boom" }] } },
      ]);
      const result = (await harness.call("create_announcement", {
        course_identifier: COURSE_ID,
        title: "Oops",
        message: "M",
        delayed_post_at: minutesFromNow(60),
      })) as ToolResponse;

      expect(result.isError).toBe(true);
      expect(result.content?.[0]?.text).toContain("72");
      expect(result.content?.[0]?.text).toContain("verify in Canvas now");
      expect(requests[1]?.method).toBe("DELETE");
    });

    it("env override 5 accepts a 10-minute-out timestamp", async () => {
      process.env.CANVAS_MCP_MIN_ANNOUNCEMENT_DELAY_MINUTES = "5";
      const delayedPostAt = minutesFromNow(10);
      const { harness, requests } = buildHarness([
        { status: 200, data: { id: 73, title: "Soon", workflow_state: "post_delayed" } },
      ]);
      const result = (await harness.call("create_announcement", {
        course_identifier: COURSE_ID,
        title: "Soon",
        message: "M",
        delayed_post_at: delayedPostAt,
      })) as ToolResponse;
      expect(result.isError).toBeFalsy();
      expect(requests[0]?.method).toBe("POST");
    });

    it("env override 1 clamps to 5: 4-minute-out rejected, 6-minute-out accepted", async () => {
      process.env.CANVAS_MCP_MIN_ANNOUNCEMENT_DELAY_MINUTES = "1";
      const { harness, requests } = buildHarness([
        { status: 200, data: { id: 74, title: "Clamped", workflow_state: "post_delayed" } },
      ]);

      const rejected = (await harness.call("create_announcement", {
        course_identifier: COURSE_ID,
        title: "Clamped",
        message: "M",
        delayed_post_at: minutesFromNow(4),
      })) as ToolResponse;
      expect(rejected.isError).toBe(true);
      expect(rejected.content?.[0]?.text).toContain("5 minutes");
      expect(requests).toHaveLength(0);

      const accepted = (await harness.call("create_announcement", {
        course_identifier: COURSE_ID,
        title: "Clamped",
        message: "M",
        delayed_post_at: minutesFromNow(6),
      })) as ToolResponse;
      expect(accepted.isError).toBeFalsy();
      expect(requests[0]?.method).toBe("POST");
    });
  });

  describe("update_announcement", () => {
    it("rejects an empty delayed_post_at at the schema level and at runtime with zero Canvas calls", async () => {
      const { harness, requests } = buildHarness([]);
      const schema = inputSchemaOf(harness, "update_announcement");
      expect(
        schema.safeParse({ course_identifier: COURSE_ID, topic_id: 80, delayed_post_at: "" }).success,
      ).toBe(false);
      expect(
        schema.safeParse({ course_identifier: COURSE_ID, topic_id: 80, delayed_post_at: null }).success,
      ).toBe(false);

      const result = (await harness.call("update_announcement", {
        course_identifier: COURSE_ID,
        topic_id: 80,
        delayed_post_at: "",
      })) as ToolResponse;
      expect(result.isError).toBe(true);
      expect(requests).toHaveLength(0);
    });

    it("moves the scheduled time via a partial PUT when the response stays post_delayed, echoing the message", async () => {
      const delayedPostAt = minutesFromNow(90);
      const { harness, requests } = buildHarness([
        {
          status: 200,
          data: {
            id: 80,
            title: "Trip",
            message: "<p>Trip details</p>",
            workflow_state: "post_delayed",
            delayed_post_at: delayedPostAt,
          },
        },
      ]);
      const result = (await harness.call("update_announcement", {
        course_identifier: COURSE_ID,
        topic_id: 80,
        delayed_post_at: delayedPostAt,
      })) as ToolResponse;

      expect(result.isError).toBeFalsy();
      expect(requests[0]?.method).toBe("PUT");
      expect(requests[0]?.url).toBe(`/api/v1/courses/${COURSE_ID}/discussion_topics/80`);
      expect(requests[0]?.data).toEqual({ delayed_post_at: delayedPostAt });
      expect(result.content?.[0]?.text).toContain(delayedPostAt);
      const announcement = parseJsonResult(result).announcement as Record<string, unknown>;
      expect(announcement.message).toBe("<p>Trip details</p>");
    });

    it("errors with the topic id and issues no DELETE when the response comes back active", async () => {
      const { harness, requests } = buildHarness([
        { status: 200, data: { id: 81, title: "Trip", workflow_state: "active" } },
      ]);
      const result = (await harness.call("update_announcement", {
        course_identifier: COURSE_ID,
        topic_id: 81,
        delayed_post_at: minutesFromNow(90),
      })) as ToolResponse;

      expect(result.isError).toBe(true);
      expect(result.content?.[0]?.text).toContain("81");
      expect(result.content?.[0]?.text).toContain("went live");
      expect(requests).toHaveLength(1);
      expect(requests.filter((request) => request.method === "DELETE")).toHaveLength(0);
    });

    it("errors when no updatable field is provided, with zero Canvas calls", async () => {
      const { harness, requests } = buildHarness([]);
      const result = (await harness.call("update_announcement", {
        course_identifier: COURSE_ID,
        topic_id: 80,
      })) as ToolResponse;
      expect(result.isError).toBe(true);
      expect(requests).toHaveLength(0);
    });
  });

  describe("delete_discussion", () => {
    it("pre-GETs the topic then DELETEs it, naming it in the summary", async () => {
      const { harness, requests } = buildHarness([
        { status: 200, data: { id: 42, title: "Old debate", is_announcement: false, published: true } },
        { status: 200, data: { id: 42, title: "Old debate" } },
      ]);
      const result = (await harness.call("delete_discussion", {
        course_identifier: COURSE_ID,
        topic_id: 42,
      })) as ToolResponse;

      expect(result.isError).toBeFalsy();
      expect(requests[0]?.method).toBe("GET");
      expect(requests[0]?.url).toBe(`/api/v1/courses/${COURSE_ID}/discussion_topics/42`);
      expect(requests[1]?.method).toBe("DELETE");
      expect(requests[1]?.url).toBe(`/api/v1/courses/${COURSE_ID}/discussion_topics/42`);
      expect(result.content?.[0]?.text).toContain('Deleted discussion 42: "Old debate"');
      expect(parseJsonResult(result).deleted).toBe(true);
    });

    it("refuses announcements with a pointer to delete_announcement and zero DELETEs", async () => {
      const { harness, requests } = buildHarness([
        { status: 200, data: { id: 43, title: "Actually an announcement", is_announcement: true } },
      ]);
      const result = (await harness.call("delete_discussion", {
        course_identifier: COURSE_ID,
        topic_id: 43,
      })) as ToolResponse;

      expect(result.isError).toBe(true);
      expect(result.content?.[0]?.text).toContain("delete_announcement");
      expect(requests.filter((request) => request.method === "DELETE")).toHaveLength(0);
    });
  });

  describe("delete_announcement", () => {
    it("pre-GETs the topic then DELETEs it, noting deletion works before or after the post time", async () => {
      const { harness, requests } = buildHarness([
        {
          status: 200,
          data: { id: 90, title: "Scheduled trip", is_announcement: true, workflow_state: "post_delayed" },
        },
        { status: 200, data: { id: 90, title: "Scheduled trip" } },
      ]);
      const result = (await harness.call("delete_announcement", {
        course_identifier: COURSE_ID,
        topic_id: 90,
      })) as ToolResponse;

      expect(result.isError).toBeFalsy();
      expect(requests[0]?.method).toBe("GET");
      expect(requests[1]?.method).toBe("DELETE");
      expect(requests[1]?.url).toBe(`/api/v1/courses/${COURSE_ID}/discussion_topics/90`);
      expect(result.content?.[0]?.text).toContain("never went live");
      expect(result.content?.[0]?.text).toContain("before or after the post time");
      expect(parseJsonResult(result).deleted).toBe(true);
    });

    it("refuses plain discussions with a pointer to delete_discussion and zero DELETEs", async () => {
      const { harness, requests } = buildHarness([
        { status: 200, data: { id: 91, title: "Plain topic", is_announcement: false } },
      ]);
      const result = (await harness.call("delete_announcement", {
        course_identifier: COURSE_ID,
        topic_id: 91,
      })) as ToolResponse;

      expect(result.isError).toBe(true);
      expect(result.content?.[0]?.text).toContain("delete_discussion");
      expect(requests.filter((request) => request.method === "DELETE")).toHaveLength(0);
    });
  });
});
