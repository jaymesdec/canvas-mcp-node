import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import type { CanvasClient } from "../canvasClient.js";
import type { Anonymizer } from "../anonymizer.js";
import type { CanvasUserLite } from "../types.js";
import { jsonResult, safeHandler } from "./toolHelpers.js";

const CREATE_STUDENT_ANONYMIZATION_MAP_INPUT = {
  course_identifier: z.union([z.string(), z.number()]),
  include_email: z
    .boolean()
    .optional()
    .describe("If true (default), Canvas includes student email addresses in the source fetch."),
};

export function registerAnonymizationTools(
  server: McpServer,
  canvas: CanvasClient,
  anonymizer: Anonymizer,
): void {
  server.registerTool(
    "create_student_anonymization_map",
    {
      description:
        "Fetch the current student roster for a course and persist (or update) the pseudonym map. Idempotent — only new students get fresh pseudonyms; removed students are marked historical without renumbering. Returns the full real-name ↔ pseudonym mapping so the teacher can identify any 'Student N' in downstream artifacts.",
      inputSchema: CREATE_STUDENT_ANONYMIZATION_MAP_INPUT,
    },
    async (input) => {
      const args = input as { course_identifier: string | number; include_email?: boolean };
      return safeHandler("create_student_anonymization_map", async () => {
        const courseId = await canvas.resolveCourseId(args.course_identifier);
        const includeTokens = ["enrollments"];
        if (args.include_email ?? true) includeTokens.push("email");

        const { items: students, truncated, pages } = await canvas.getPaginated<CanvasUserLite>(
          `/api/v1/courses/${courseId}/users`,
          {
            params: {
              "enrollment_type[]": ["student"],
              "include[]": includeTokens,
            },
          },
        );

        const merge = await anonymizer.mergeIntoMap(courseId, students);
        const map = merge.map;
        const mapping = students.map((student) => {
          const userIdKey = String(student.id);
          const entry = map.students[userIdKey];
          return {
            user_id: student.id,
            real_name: student.name ?? null,
            real_email: student.email ?? null,
            pseudonym: entry?.pseudonym ?? null,
            anonymized_email: entry?.anonymizedEmail ?? null,
            status: entry?.status ?? "active",
          };
        });

        return jsonResult(
          {
            course_id: courseId,
            roster_size: students.length,
            pages,
            truncated,
            newly_allocated: merge.newlyAllocated,
            total_active: merge.totalActive,
            total_historical: merge.totalHistorical,
            mapping,
          },
          {
            summary:
              `Course ${courseId}: ${students.length} student(s) in roster, ` +
              `${merge.newlyAllocated} newly allocated, ${merge.totalHistorical} historical.`,
          },
        );
      });
    },
  );

  server.registerTool(
    "get_anonymization_status",
    {
      description:
        "List every anonymization map file persisted on disk under ANON_MAP_DIR. Reports per-course entry counts and generated_at timestamps. Maps are persistent and per-course — they survive MCP restarts.",
      inputSchema: {},
    },
    async () => {
      return safeHandler("get_anonymization_status", async () => {
        const maps = await anonymizer.listMaps();
        return jsonResult(
          {
            root_dir: anonymizer.rootDir,
            map_count: maps.length,
            persistence_note:
              "Maps live on disk and persist across MCP restarts. Same student → same pseudonym for the lifetime of the file.",
            maps: maps.map((map) => ({
              course_id: map.courseId,
              entries: map.entries,
              generated_at: map.generatedAt,
              file_path: map.filePath,
            })),
          },
          {
            summary: maps.length
              ? `${maps.length} anonymization map(s) under ${anonymizer.rootDir}.`
              : `No anonymization maps yet under ${anonymizer.rootDir}.`,
          },
        );
      });
    },
  );
}
