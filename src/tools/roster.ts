import type { CanvasClient } from "../canvasClient.js";

interface CanvasRosterUser {
  id: number | string;
  name?: string;
}

export interface RosterStudent {
  id: string;
  name: string;
}

/**
 * Fetch the ids of every staff-roled user (teacher/ta/designer) in a course.
 * Used to classify authors that Canvas returns without role data (submission
 * comment authors, discussion entry authors): in the set → real attribution,
 * not in the set → pseudonymize (fail closed). Errors propagate — callers let
 * safeHandler surface them rather than proceeding unclassified.
 */
export async function buildStaffIdSet(canvas: CanvasClient, courseId: number): Promise<Set<string>> {
  const { items } = await canvas.getPaginated<CanvasRosterUser>(
    `/api/v1/courses/${courseId}/users`,
    { params: { "enrollment_type[]": ["teacher", "ta", "designer"] } },
  );
  return new Set(items.map((user) => String(user.id)));
}

/**
 * Fetch every student-enrolled user's id + real name for a course. Feeds the
 * discussion body scrub. Truncation is fail-open there (names on unfetched
 * pages survive in bodies), so the flag is propagated for a caller warning.
 */
export async function fetchStudentRoster(
  canvas: CanvasClient,
  courseId: number,
): Promise<{ students: RosterStudent[]; truncated: boolean }> {
  const { items, truncated } = await canvas.getPaginated<CanvasRosterUser>(
    `/api/v1/courses/${courseId}/users`,
    { params: { "enrollment_type[]": ["student"] } },
  );
  return {
    students: items.map((user) => ({
      id: String(user.id),
      name: typeof user.name === "string" ? user.name : "",
    })),
    truncated,
  };
}
