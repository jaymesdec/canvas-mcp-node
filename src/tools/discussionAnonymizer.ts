import type { Anonymizer } from "../anonymizer.js";
import type { CanvasClient } from "../canvasClient.js";
import { buildStaffIdSet, fetchStudentRoster } from "./roster.js";

export const DISCUSSION_SCRUB_NOTE =
  "Discussion content has been anonymized on a best-effort basis: free-text may still contain " +
  "identifying details that could not be mapped to roster names (nicknames, misspellings, indirect " +
  "references), and name substitutions may have altered quoted student text.";

export const ROSTER_TRUNCATED_NOTE =
  "The student roster fetch was truncated before all pages were retrieved; names of students on " +
  "unfetched pages may remain unscrubbed in message bodies.";

export const FORMER_PARTICIPANT_NAME = "Former participant";

export interface DiscussionAnonymizerDeps {
  canvas: CanvasClient;
  anonymizer: Anonymizer;
}

export interface DiscussionEntryLike {
  id?: number | string;
  user_id?: number | string | null;
  user_name?: string | null;
  message?: string | null;
  created_at?: string;
  recent_replies?: DiscussionEntryLike[];
  [key: string]: unknown;
}

export interface NameReplacement {
  name: string;
  pseudonym: string;
}

export interface CourseScrubber {
  staffIdSet: Set<string>;
  scrub: (text: string) => string;
  warnings: string[];
}

export function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Case-insensitive, word-boundary, longest-match-first replacement over full
 * names and bare first-name tokens. Case-insensitivity means a common word
 * colliding with a student's name ("grace") is also replaced — the accepted
 * fail-closed tradeoff.
 */
export function buildNameScrubber(replacements: NameReplacement[]): (text: string) => string {
  const tokens: Array<{ token: string; pseudonym: string }> = [];
  for (const { name, pseudonym } of replacements) {
    const fullName = name.trim();
    if (!fullName) continue;
    tokens.push({ token: fullName, pseudonym });
    const firstName = fullName.split(/\s+/)[0]!;
    if (firstName !== fullName) tokens.push({ token: firstName, pseudonym });
  }
  tokens.sort((a, b) => b.token.length - a.token.length);
  // Lookarounds instead of \b: \b anchors to \w = [A-Za-z0-9_], so a name that
  // starts/ends in a non-word char (accented letters like "René", "Jr.", a
  // trailing apostrophe) would demand an adjacent word char and silently fail
  // to match — leaking the name. The lookarounds only require the neighbor to
  // not be a word char, which holds at string edges too.
  const patterns = tokens.map(({ token, pseudonym }) => ({
    regex: new RegExp(`(?<![A-Za-z0-9_])${escapeRegExp(token)}(?![A-Za-z0-9_])`, "gi"),
    pseudonym,
  }));

  return (text: string) => {
    if (!text) return text;
    let scrubbed = text;
    for (const { regex, pseudonym } of patterns) {
      scrubbed = scrubbed.replace(regex, () => pseudonym);
    }
    return scrubbed;
  };
}

/**
 * Fetch the staff-id set and student roster for a course (per invocation — no
 * cross-call cache; a stale roster is a FERPA leak vector) and build a text
 * scrubber whose replacements share the course's persistent pseudonym map, so
 * body substitutions stay consistent with author substitutions. Staff-fetch
 * failure propagates (fail closed); student-roster truncation is recorded in
 * `warnings` (fail open for the body scrub only). Reused by topic-level and
 * announcement body scrubbing.
 */
export async function buildCourseScrubber(
  deps: DiscussionAnonymizerDeps,
  courseId: number,
): Promise<CourseScrubber> {
  const [staffIdSet, roster] = await Promise.all([
    buildStaffIdSet(deps.canvas, courseId),
    fetchStudentRoster(deps.canvas, courseId),
  ]);

  const replacements: NameReplacement[] = [];
  for (const student of roster.students) {
    const { pseudonym } = await deps.anonymizer.getOrAllocate(courseId, {
      id: student.id,
      name: student.name,
    });
    if (student.name.trim()) replacements.push({ name: student.name, pseudonym });
  }

  return {
    staffIdSet,
    scrub: buildNameScrubber(replacements),
    warnings: roster.truncated ? [ROSTER_TRUNCATED_NOTE] : [],
  };
}

/**
 * Anonymize discussion entries: staff authors keep attribution, everyone else
 * (including dropped students, observers, Student View) gets a pseudonym from
 * the course's persistent map, null/absent user_id renders a fixed placeholder
 * with no allocation, and every message body (recursively through
 * recent_replies) runs through the roster-name scrub. Pass a pre-built
 * scrubber to share one roster fetch across entries and topic-level text.
 */
export async function anonymizeDiscussionEntries(
  deps: DiscussionAnonymizerDeps,
  courseId: number,
  entries: DiscussionEntryLike[],
  prebuiltScrubber?: CourseScrubber,
): Promise<{ entries: DiscussionEntryLike[]; warnings: string[] }> {
  const scrubber = prebuiltScrubber ?? (await buildCourseScrubber(deps, courseId));

  const anonymized: DiscussionEntryLike[] = [];
  for (const entry of entries) {
    anonymized.push(await anonymizeEntry(deps, courseId, entry, scrubber));
  }

  const warnings: string[] = [];
  if (entries.length > 0) warnings.push(DISCUSSION_SCRUB_NOTE);
  warnings.push(...scrubber.warnings);
  return { entries: anonymized, warnings };
}

async function anonymizeEntry(
  deps: DiscussionAnonymizerDeps,
  courseId: number,
  entry: DiscussionEntryLike,
  scrubber: CourseScrubber,
): Promise<DiscussionEntryLike> {
  const transformed: DiscussionEntryLike = { ...entry };

  if (entry.user_id === undefined || entry.user_id === null) {
    transformed.user_name = FORMER_PARTICIPANT_NAME;
  } else if (!scrubber.staffIdSet.has(String(entry.user_id))) {
    const { pseudonym } = await deps.anonymizer.getOrAllocate(courseId, {
      id: entry.user_id,
      name: typeof entry.user_name === "string" ? entry.user_name : undefined,
    });
    transformed.user_name = pseudonym;
  }

  if (typeof entry.message === "string") {
    transformed.message = scrubber.scrub(entry.message);
  }

  if (Array.isArray(entry.recent_replies)) {
    const replies: DiscussionEntryLike[] = [];
    for (const reply of entry.recent_replies) {
      replies.push(await anonymizeEntry(deps, courseId, reply, scrubber));
    }
    transformed.recent_replies = replies;
  }

  return transformed;
}
