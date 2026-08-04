import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import type { CanvasClient } from "../canvasClient.js";
import type { Anonymizer } from "../anonymizer.js";
import { CanvasApiError } from "../types.js";
import { DEANON_DENIED_NOTE, resolveAnonymous } from "../featureFlags.js";
import { jsonResult, pickFields, safeHandler } from "./toolHelpers.js";
import {
  DISCUSSION_SCRUB_NOTE,
  anonymizeDiscussionEntries,
  buildCourseScrubber,
  type CourseScrubber,
  type DiscussionEntryLike,
} from "./discussionAnonymizer.js";

export const MIN_ANNOUNCEMENT_DELAY_MINUTES = 30;
// The floor doubles as the clock-skew buffer between this machine and Canvas,
// so operator overrides clamp to a hard 5-minute lower bound.
const MIN_DELAY_CLAMP_MINUTES = 5;

function minimumDelayMinutes(): number {
  const raw = process.env.CANVAS_MCP_MIN_ANNOUNCEMENT_DELAY_MINUTES;
  if (raw === undefined || raw.trim() === "") return MIN_ANNOUNCEMENT_DELAY_MINUTES;
  const parsed = Number(raw.trim());
  if (!Number.isFinite(parsed)) return MIN_ANNOUNCEMENT_DELAY_MINUTES;
  return Math.max(parsed, MIN_DELAY_CLAMP_MINUTES);
}

const EXPLICIT_OFFSET_PATTERN = /(?:Z|[+-]\d{2}:?\d{2})$/;

/**
 * Fail-closed validation of an announcement post time, run before ANY Canvas
 * call. Offset-less ISO strings are rejected outright: JS parses them as
 * server-local time while Canvas reads them as UTC, a divergence that can
 * silently defeat the delay floor.
 */
function validateDelayedPostAt(toolName: string, value: string | undefined): string {
  if (value === undefined || value.trim() === "") {
    throw new CanvasApiError({
      code: "VALIDATION",
      message: `${toolName}: delayed_post_at is required and must be a non-empty ISO-8601 timestamp.`,
    });
  }
  if (!EXPLICIT_OFFSET_PATTERN.test(value.trim())) {
    throw new CanvasApiError({
      code: "VALIDATION",
      message:
        `${toolName}: delayed_post_at "${value}" must carry an explicit UTC offset or Z suffix ` +
        `(e.g. 2026-08-05T14:00:00Z or 2026-08-05T10:00:00-04:00). Offset-less timestamps are ` +
        `rejected because local-vs-UTC parsing divergence can defeat the delay floor.`,
    });
  }
  const parsedMs = Date.parse(value);
  if (Number.isNaN(parsedMs)) {
    throw new CanvasApiError({
      code: "VALIDATION",
      message: `${toolName}: delayed_post_at "${value}" is not a parseable ISO-8601 timestamp.`,
    });
  }
  const floorMinutes = minimumDelayMinutes();
  if (parsedMs < Date.now() + floorMinutes * 60_000) {
    throw new CanvasApiError({
      code: "VALIDATION",
      message:
        `${toolName}: delayed_post_at "${value}" must be at least ${floorMinutes} minutes in the ` +
        `future (a past or near timestamp would make the announcement visible immediately).`,
    });
  }
  return value;
}

const LIST_DISCUSSIONS_INPUT = {
  course_identifier: z.union([z.string(), z.number()]),
};

const GET_DISCUSSION_INPUT = {
  course_identifier: z.union([z.string(), z.number()]),
  topic_id: z.union([z.string(), z.number()]),
  include_entries: z
    .boolean()
    .optional()
    .describe("Fetch the topic's entries (replies). Defaults to true."),
  anonymous: z
    .boolean()
    .optional()
    .describe(
      "When true (default), student entry authors are pseudonymized and roster names are scrubbed from message bodies. Override only takes effect when CANVAS_MCP_ALLOW_DEANONYMIZE=true on the server.",
    ),
};

const CREATE_DISCUSSION_INPUT = {
  course_identifier: z.union([z.string(), z.number()]),
  title: z.string(),
  message: z.string().describe("Topic body HTML."),
  discussion_type: z
    .enum(["side_comment", "threaded"])
    .optional()
    .describe("Canvas discussion_type. Defaults to Canvas's own default (threaded)."),
  delayed_post_at: z
    .string()
    .optional()
    .describe("Optional ISO-8601 time before which the topic stays hidden from students."),
};

const UPDATE_DISCUSSION_INPUT = {
  course_identifier: z.union([z.string(), z.number()]),
  topic_id: z.union([z.string(), z.number()]),
  title: z.string().optional(),
  message: z.string().optional().describe("Replacement topic body HTML."),
  discussion_type: z.enum(["side_comment", "threaded"]).optional(),
  delayed_post_at: z.string().optional(),
  published: z
    .literal(false)
    .optional()
    .describe(
      "Only false is accepted (revert to draft). Publishing stays manual in the Canvas UI per the no-auto-publish rule.",
    ),
};

const LIST_ANNOUNCEMENTS_INPUT = {
  course_identifier: z.union([z.string(), z.number()]),
};

const CREATE_ANNOUNCEMENT_INPUT = {
  course_identifier: z.union([z.string(), z.number()]),
  title: z.string(),
  message: z.string().describe("Announcement body HTML."),
  delayed_post_at: z
    .string()
    .describe(
      "REQUIRED future ISO-8601 timestamp with an explicit offset or Z. Announcements cannot be drafts, so the scheduled time is the only review window — it must be at least the configured delay floor (default 30 minutes) in the future.",
    ),
};

const UPDATE_ANNOUNCEMENT_INPUT = {
  course_identifier: z.union([z.string(), z.number()]),
  topic_id: z.union([z.string(), z.number()]),
  title: z.string().optional(),
  message: z.string().optional().describe("Replacement announcement body HTML."),
  delayed_post_at: z
    .string()
    .min(1)
    .refine((value) => value.trim().length > 0, {
      message: "delayed_post_at must not be empty — Canvas clears the delay on empty, posting immediately",
    })
    .optional()
    .describe(
      "New scheduled post time (ISO-8601 with explicit offset or Z, at least the delay floor in the future). Null/empty is rejected — Canvas clears the delay on empty, which posts immediately.",
    ),
};

interface CanvasDiscussionTopic {
  id: number;
  title?: string;
  message?: string | null;
  published?: boolean;
  posted_at?: string | null;
  delayed_post_at?: string | null;
  discussion_type?: string;
  locked?: boolean;
  pinned?: boolean;
  workflow_state?: string;
  is_announcement?: boolean;
  discussion_subentry_count?: number;
  user_name?: string | null;
  author?: { id?: number | string; display_name?: string } | null;
}

const DISCUSSION_LIST_DISPLAY_KEYS = [
  "id",
  "title",
  "published",
  "posted_at",
  "discussion_type",
  "locked",
  "pinned",
  "delayed_post_at",
] as const;

const DISCUSSION_TOPIC_DISPLAY_KEYS = [
  "id",
  "title",
  "published",
  "posted_at",
  "delayed_post_at",
  "discussion_type",
  "locked",
  "pinned",
] as const;

const ANNOUNCEMENT_DISPLAY_KEYS = [
  "id",
  "title",
  "posted_at",
  "delayed_post_at",
  "workflow_state",
  "published",
] as const;

const ENTRY_DISPLAY_KEYS = ["id", "user_id", "user_name", "message", "created_at"] as const;

function displayDiscussion(topic: CanvasDiscussionTopic): Record<string, unknown> {
  const trimmed = pickFields(topic as unknown as Record<string, unknown>, DISCUSSION_LIST_DISPLAY_KEYS);
  trimmed.reply_count = topic.discussion_subentry_count ?? null;
  return trimmed;
}

function displayAnnouncement(topic: CanvasDiscussionTopic): Record<string, unknown> {
  return pickFields(topic as unknown as Record<string, unknown>, ANNOUNCEMENT_DISPLAY_KEYS);
}

function displayEntry(entry: DiscussionEntryLike): Record<string, unknown> {
  const trimmed = pickFields(entry as Record<string, unknown>, ENTRY_DISPLAY_KEYS);
  trimmed.recent_replies = Array.isArray(entry.recent_replies)
    ? entry.recent_replies.map(displayEntry)
    : null;
  return trimmed;
}

function discussionTopicsPath(courseId: number): string {
  return `/api/v1/courses/${courseId}/discussion_topics`;
}

export function registerDiscussionTools(
  server: McpServer,
  canvas: CanvasClient,
  anonymizer: Anonymizer,
): void {
  server.registerTool(
    "list_discussions",
    {
      description:
        "List discussion topics in a Canvas course (announcements are excluded — use list_announcements). Returns trimmed topics: id, title, published, posted_at, discussion_type, locked, pinned, delayed_post_at, reply_count.",
      inputSchema: LIST_DISCUSSIONS_INPUT,
    },
    async (input) => {
      const args = input as z.infer<z.ZodObject<typeof LIST_DISCUSSIONS_INPUT>>;
      return safeHandler("list_discussions", async () => {
        const courseId = await canvas.resolveCourseId(args.course_identifier);
        const { items: topics, truncated, pages } = await canvas.getPaginated<CanvasDiscussionTopic>(
          discussionTopicsPath(courseId),
        );
        return jsonResult(
          {
            course_id: courseId,
            count: topics.length,
            pages,
            truncated,
            discussions: topics.map(displayDiscussion),
          },
          { summary: `Course ${courseId}: ${topics.length} discussion topic(s).` },
        );
      });
    },
  );

  server.registerTool(
    "get_discussion",
    {
      description:
        "Fetch one discussion topic and (by default) its entries. Entries come from the paginated /entries endpoint rather than /view — /view can 503 while its cache builds and 403s on require_initial_post topics even for a teacher token. " +
        "Student entry authors are pseudonymized and roster names are scrubbed from the topic body and every entry body by default (FERPA gate); set anonymous=false only with CANVAS_MCP_ALLOW_DEANONYMIZE=true on the server.",
      inputSchema: GET_DISCUSSION_INPUT,
    },
    async (input) => {
      const args = input as z.infer<z.ZodObject<typeof GET_DISCUSSION_INPUT>>;
      return safeHandler("get_discussion", async () => {
        const courseId = await canvas.resolveCourseId(args.course_identifier);
        const { anonymous, overridden } = resolveAnonymous(args.anonymous);
        const includeEntries = args.include_entries !== false;

        const topic = await canvas.get<CanvasDiscussionTopic>(
          `${discussionTopicsPath(courseId)}/${args.topic_id}`,
        );

        let rawEntries: DiscussionEntryLike[] = [];
        let entriesTruncated = false;
        if (includeEntries) {
          const { items, truncated } = await canvas.getPaginated<DiscussionEntryLike>(
            `${discussionTopicsPath(courseId)}/${args.topic_id}/entries`,
          );
          rawEntries = items;
          entriesTruncated = truncated;
        }

        const warnings: string[] = [];
        if (overridden) warnings.push(DEANON_DENIED_NOTE);

        let topicMessage = topic.message ?? null;
        let entries = rawEntries;
        let scrubber: CourseScrubber | null = null;
        if (anonymous) {
          scrubber = await buildCourseScrubber({ canvas, anonymizer }, courseId);
          if (typeof topicMessage === "string") {
            topicMessage = scrubber.scrub(topicMessage);
            warnings.push(DISCUSSION_SCRUB_NOTE);
          }
          warnings.push(...scrubber.warnings);
          if (includeEntries) {
            const anonymized = await anonymizeDiscussionEntries(
              { canvas, anonymizer },
              courseId,
              rawEntries,
              scrubber,
            );
            entries = anonymized.entries;
            warnings.push(...anonymized.warnings);
          }
        }

        const authorId = topic.author?.id ?? null;
        let authorName: string | null = topic.user_name ?? topic.author?.display_name ?? null;
        let author: { id: number | string; name: string | null } | null = null;
        if (authorId !== null && authorId !== undefined) {
          if (anonymous && scrubber && !scrubber.staffIdSet.has(String(authorId))) {
            const { pseudonym } = await anonymizer.getOrAllocate(courseId, {
              id: authorId,
              name: authorName ?? undefined,
            });
            authorName = pseudonym;
          }
          author = { id: authorId, name: authorName };
        }

        const trimmedTopic = pickFields(
          topic as unknown as Record<string, unknown>,
          DISCUSSION_TOPIC_DISPLAY_KEYS,
        );
        trimmedTopic.message = topicMessage;
        trimmedTopic.author = author;

        const uniqueWarnings = [...new Set(warnings)];
        return jsonResult(
          {
            course_id: courseId,
            topic: trimmedTopic,
            entries_included: includeEntries,
            entry_count: includeEntries ? entries.length : null,
            entries_truncated: includeEntries ? entriesTruncated : null,
            anonymized: anonymous,
            ...(uniqueWarnings.length > 0 ? { warnings: uniqueWarnings } : {}),
            entries: includeEntries ? entries.map(displayEntry) : null,
          },
          {
            summary:
              `Discussion ${topic.id}: "${topic.title ?? ""}"` +
              (includeEntries ? `, ${entries.length} entr(y/ies)` : ", entries not fetched") +
              (anonymous ? " (anonymized)" : "") +
              ".",
          },
        );
      });
    },
  );

  server.registerTool(
    "create_discussion",
    {
      description:
        "Create a NEW Canvas discussion topic as an unpublished draft — published is forced false per the no-auto-publish rule; the teacher publishes after review. Body is sent verbatim (no page-template wrapping — discussion topics, not wiki pages). For announcements use create_announcement.",
      inputSchema: CREATE_DISCUSSION_INPUT,
    },
    async (input) => {
      const args = input as z.infer<z.ZodObject<typeof CREATE_DISCUSSION_INPUT>>;
      return safeHandler("create_discussion", async () => {
        const courseId = await canvas.resolveCourseId(args.course_identifier, { bypassCache: true });
        const payload: Record<string, unknown> = {
          title: args.title,
          message: args.message,
          published: false,
        };
        if (args.discussion_type !== undefined) payload.discussion_type = args.discussion_type;
        if (args.delayed_post_at !== undefined) payload.delayed_post_at = args.delayed_post_at;

        const created = await canvas.post<CanvasDiscussionTopic>(discussionTopicsPath(courseId), payload);
        return jsonResult(
          { course_id: courseId, discussion: displayDiscussion(created) },
          {
            summary: `Created draft discussion "${created.title ?? args.title}" (id ${created.id}) — unpublished; publish after review in Canvas.`,
          },
        );
      });
    },
  );

  server.registerTool(
    "update_discussion",
    {
      description:
        "Update an existing Canvas discussion topic (partial: only provided fields are sent). Refuses announcements — use update_announcement, which enforces the scheduling floor. published accepts only false (revert to draft); publishing stays manual in Canvas.",
      inputSchema: UPDATE_DISCUSSION_INPUT,
    },
    async (input) => {
      const args = input as z.infer<z.ZodObject<typeof UPDATE_DISCUSSION_INPUT>>;
      return safeHandler("update_discussion", async () => {
        const payload: Record<string, unknown> = {};
        if (args.title !== undefined) payload.title = args.title;
        if (args.message !== undefined) payload.message = args.message;
        if (args.discussion_type !== undefined) payload.discussion_type = args.discussion_type;
        if (args.delayed_post_at !== undefined) payload.delayed_post_at = args.delayed_post_at;
        if (args.published !== undefined) payload.published = false;
        if (Object.keys(payload).length === 0) {
          throw new CanvasApiError({
            code: "VALIDATION",
            message:
              "update_discussion: at least one of title/message/discussion_type/delayed_post_at/published must be provided.",
          });
        }

        const courseId = await canvas.resolveCourseId(args.course_identifier, { bypassCache: true });
        const existing = await canvas.get<CanvasDiscussionTopic>(
          `${discussionTopicsPath(courseId)}/${args.topic_id}`,
        );
        if (existing.is_announcement === true) {
          throw new CanvasApiError({
            code: "VALIDATION",
            message:
              `update_discussion: topic ${args.topic_id} is an announcement — use update_announcement instead, ` +
              `which enforces the scheduled-post-time floor.`,
          });
        }

        const updated = await canvas.put<CanvasDiscussionTopic>(
          `${discussionTopicsPath(courseId)}/${args.topic_id}`,
          payload,
        );
        return jsonResult(
          { course_id: courseId, discussion: displayDiscussion(updated) },
          { summary: `Updated discussion ${updated.id}: "${updated.title ?? ""}".` },
        );
      });
    },
  );

  server.registerTool(
    "list_announcements",
    {
      description:
        "List a course's announcements via discussion_topics?only_announcements=true — unlike GET /api/v1/announcements this has no ±14-day window, so scheduled (post_delayed) announcements appear with their delayed_post_at.",
      inputSchema: LIST_ANNOUNCEMENTS_INPUT,
    },
    async (input) => {
      const args = input as z.infer<z.ZodObject<typeof LIST_ANNOUNCEMENTS_INPUT>>;
      return safeHandler("list_announcements", async () => {
        const courseId = await canvas.resolveCourseId(args.course_identifier);
        const { items: topics, truncated, pages } = await canvas.getPaginated<CanvasDiscussionTopic>(
          discussionTopicsPath(courseId),
          { params: { only_announcements: true } },
        );
        return jsonResult(
          {
            course_id: courseId,
            count: topics.length,
            pages,
            truncated,
            announcements: topics.map(displayAnnouncement),
          },
          { summary: `Course ${courseId}: ${topics.length} announcement(s).` },
        );
      });
    },
  );

  server.registerTool(
    "create_announcement",
    {
      description:
        "Create a SCHEDULED Canvas announcement. Announcements cannot be drafts, so delayed_post_at is REQUIRED: an ISO-8601 timestamp with an explicit offset or Z, at least the delay floor (default 30 minutes, CANVAS_MCP_MIN_ANNOUNCEMENT_DELAY_MINUTES to override, clamped to >=5) in the future. Missing/past/near/offset-less timestamps fail before any Canvas call. If Canvas reports the announcement went live immediately anyway, the tool deletes it best-effort and raises an error.",
      inputSchema: CREATE_ANNOUNCEMENT_INPUT,
    },
    async (input) => {
      const args = input as z.infer<z.ZodObject<typeof CREATE_ANNOUNCEMENT_INPUT>>;
      return safeHandler("create_announcement", async () => {
        const delayedPostAt = validateDelayedPostAt("create_announcement", args.delayed_post_at);
        const courseId = await canvas.resolveCourseId(args.course_identifier, { bypassCache: true });

        const created = await canvas.post<CanvasDiscussionTopic>(discussionTopicsPath(courseId), {
          title: args.title,
          message: args.message,
          is_announcement: true,
          delayed_post_at: delayedPostAt,
        });

        if (created.workflow_state !== "post_delayed") {
          try {
            await canvas.del(`${discussionTopicsPath(courseId)}/${created.id}`);
          } catch {
            // best-effort cleanup — the thrown error below carries the remediation either way
          }
          throw new CanvasApiError({
            code: "VALIDATION",
            message:
              `create_announcement: announcement ${created.id} went live immediately ` +
              `(workflow_state "${created.workflow_state ?? "unknown"}" instead of "post_delayed") — ` +
              `attempted automatic delete; verify in Canvas now.`,
          });
        }

        return jsonResult(
          { course_id: courseId, announcement: displayAnnouncement(created) },
          {
            summary: `Created scheduled announcement "${created.title ?? args.title}" (id ${created.id}) — goes live at ${delayedPostAt}.`,
          },
        );
      });
    },
  );

  server.registerTool(
    "update_announcement",
    {
      description:
        "Update an existing Canvas announcement (partial: only provided fields are sent). A new delayed_post_at obeys the same offset + delay-floor rules as create_announcement; null/empty is rejected because Canvas clears the delay on empty, posting immediately. WARNING: edits to an announcement whose post time has passed are live edits visible to students.",
      inputSchema: UPDATE_ANNOUNCEMENT_INPUT,
    },
    async (input) => {
      const args = input as z.infer<z.ZodObject<typeof UPDATE_ANNOUNCEMENT_INPUT>>;
      return safeHandler("update_announcement", async () => {
        const payload: Record<string, unknown> = {};
        if (args.title !== undefined) payload.title = args.title;
        if (args.message !== undefined) payload.message = args.message;
        if (args.delayed_post_at !== undefined) {
          payload.delayed_post_at = validateDelayedPostAt("update_announcement", args.delayed_post_at);
        }
        if (Object.keys(payload).length === 0) {
          throw new CanvasApiError({
            code: "VALIDATION",
            message: "update_announcement: at least one of title/message/delayed_post_at must be provided.",
          });
        }

        const courseId = await canvas.resolveCourseId(args.course_identifier, { bypassCache: true });
        const updated = await canvas.put<CanvasDiscussionTopic>(
          `${discussionTopicsPath(courseId)}/${args.topic_id}`,
          payload,
        );

        if (args.delayed_post_at !== undefined && updated.workflow_state !== "post_delayed") {
          // No delete here — this is a pre-existing announcement, not something we created.
          throw new CanvasApiError({
            code: "VALIDATION",
            message:
              `update_announcement: announcement ${args.topic_id} went live ` +
              `(workflow_state "${updated.workflow_state ?? "unknown"}" instead of "post_delayed") — ` +
              `verify in Canvas now.`,
          });
        }

        return jsonResult(
          { course_id: courseId, announcement: displayAnnouncement(updated) },
          {
            summary:
              `Updated announcement ${updated.id}: "${updated.title ?? ""}"` +
              (args.delayed_post_at !== undefined ? ` — goes live at ${args.delayed_post_at}` : "") +
              ".",
          },
        );
      });
    },
  );
}
