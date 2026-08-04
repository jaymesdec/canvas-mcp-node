import type { CanvasClient } from "../canvasClient.js";

interface CanvasRosterUser {
  id: number | string;
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
