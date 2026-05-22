import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import type { CanvasClient } from "../canvasClient.js";
import type { Anonymizer } from "../anonymizer.js";
import { CanvasApiError, type CanvasUserLite } from "../types.js";
import { jsonResult, safeHandler } from "./toolHelpers.js";
import { DEANON_DENIED_NOTE, isDeanonymizationAllowed } from "../featureFlags.js";

/**
 * Resolve the effective anonymization flag, honoring the operator env gate.
 * When the caller asks for anonymous: false but CANVAS_MCP_ALLOW_DEANONYMIZE is
 * not set, force back to true and surface a warning in the response.
 */
function resolveAnonymous(requested: boolean | undefined): {
  anonymous: boolean;
  overridden: boolean;
} {
  const wantedAnonymous = requested ?? true;
  if (wantedAnonymous === false && !isDeanonymizationAllowed()) {
    return { anonymous: true, overridden: true };
  }
  return { anonymous: wantedAnonymous, overridden: false };
}

const LIST_USERS_INPUT = {
  course_identifier: z.union([z.string(), z.number()]),
  enrollment_type: z
    .array(z.enum(["student", "teacher", "ta", "designer", "observer"]))
    .optional()
    .describe("Canvas enrollment_type[] filter. Defaults to ['student']."),
  include_email: z.boolean().optional(),
  anonymous: z
    .boolean()
    .optional()
    .describe("When true (default), student names/emails are pseudonymized. Teachers/TAs/admins are preserved verbatim."),
  search_term: z.string().optional(),
};

const LIST_USER_ENROLLMENTS_INPUT = {
  user_id: z.union([z.string(), z.number()]).describe("Real Canvas user_id (not a pseudonym)."),
  state: z
    .array(z.enum(["active", "invited", "completed", "creation_pending", "deleted", "rejected", "inactive"]))
    .optional()
    .describe("Enrollment state[] filter. Defaults to ['active']."),
};

const LIST_ACCOUNT_USERS_INPUT = {
  account_id: z.union([z.string(), z.number()]).describe("Canvas account id (account-admin scope required)."),
  search_term: z.string().optional(),
  enrollment_type: z.array(z.string()).optional(),
  anonymous: z
    .boolean()
    .optional()
    .describe("When true (default), users with student role/enrollments are pseudonymized."),
};

interface CanvasEnrollment {
  id: number;
  course_id: number;
  user_id: number;
  type: string;
  role: string;
  enrollment_state: string;
  user?: CanvasUserLite;
}

export function registerUserTools(
  server: McpServer,
  canvas: CanvasClient,
  anonymizer: Anonymizer,
): void {
  server.registerTool(
    "list_users",
    {
      description:
        "List users enrolled in a Canvas course. Defaults to students only; student names/emails are anonymized by default (FERPA gate). Teachers/TAs/admins are returned verbatim.",
      inputSchema: LIST_USERS_INPUT,
    },
    async (input) => {
      const args = input as {
        course_identifier: string | number;
        enrollment_type?: string[];
        include_email?: boolean;
        anonymous?: boolean;
        search_term?: string;
      };
      return safeHandler("list_users", async () => {
        const courseId = await canvas.resolveCourseId(args.course_identifier);
        const enrollmentTypes = args.enrollment_type ?? ["student"];
        const includeTokens = ["enrollments"]; // needed for role classification
        if (args.include_email) includeTokens.push("email");
        const params: Record<string, unknown> = {
          "enrollment_type[]": enrollmentTypes,
          "include[]": includeTokens,
        };
        if (args.search_term) params.search_term = args.search_term;

        const { items: users, truncated, pages } = await canvas.getPaginated<CanvasUserLite>(
          `/api/v1/courses/${courseId}/users`,
          { params },
        );

        const { anonymous, overridden } = resolveAnonymous(args.anonymous);
        const finalUsers = anonymous
          ? await Promise.all(users.map((user) => anonymizer.anonymizeUser(courseId, user)))
          : users;

        const warnings = overridden ? [DEANON_DENIED_NOTE] : undefined;
        return jsonResult(
          {
            course_id: courseId,
            count: finalUsers.length,
            pages,
            truncated,
            anonymized: anonymous,
            ...(warnings ? { warnings } : {}),
            users: finalUsers,
          },
          {
            summary:
              `Course ${courseId}: ${finalUsers.length} user(s)${anonymous ? " (anonymized)" : ""}.` +
              (overridden ? ` [override: ${DEANON_DENIED_NOTE}]` : ""),
          },
        );
      });
    },
  );

  server.registerTool(
    "list_user_enrollments",
    {
      description:
        "List every Canvas enrollment for a single user across all courses. Surfaces course_id, role, and enrollment_state.",
      inputSchema: LIST_USER_ENROLLMENTS_INPUT,
    },
    async (input) => {
      const args = input as { user_id: string | number; state?: string[] };
      return safeHandler("list_user_enrollments", async () => {
        const params: Record<string, unknown> = {
          "state[]": args.state ?? ["active"],
        };
        const { items: enrollments, truncated, pages } = await canvas.getPaginated<CanvasEnrollment>(
          `/api/v1/users/${args.user_id}/enrollments`,
          { params },
        );

        const summary = enrollments.map((enrollment) => ({
          course_id: enrollment.course_id,
          course_code: canvas.getCachedCourseCode(enrollment.course_id) ?? null,
          role: enrollment.role,
          type: enrollment.type,
          enrollment_state: enrollment.enrollment_state,
        }));

        return jsonResult(
          { user_id: args.user_id, count: summary.length, pages, truncated, enrollments: summary },
          { summary: `User ${args.user_id}: ${summary.length} enrollment(s).` },
        );
      });
    },
  );

  server.registerTool(
    "list_account_users",
    {
      description:
        "List users in a Canvas account. Requires account-admin scope. Student-roled results are anonymized by default; unknown-role results default to anonymized for safety.",
      inputSchema: LIST_ACCOUNT_USERS_INPUT,
    },
    async (input) => {
      const args = input as {
        account_id: string | number;
        search_term?: string;
        enrollment_type?: string[];
        anonymous?: boolean;
      };
      return safeHandler("list_account_users", async () => {
        const params: Record<string, unknown> = {};
        if (args.search_term) params.search_term = args.search_term;
        if (args.enrollment_type && args.enrollment_type.length > 0) {
          params["enrollment_type[]"] = args.enrollment_type;
        }

        let users: CanvasUserLite[];
        let truncated: boolean;
        let pages: number;
        try {
          const result = await canvas.getPaginated<CanvasUserLite>(
            `/api/v1/accounts/${args.account_id}/users`,
            { params },
          );
          users = result.items;
          truncated = result.truncated;
          pages = result.pages;
        } catch (error) {
          if (
            error instanceof CanvasApiError &&
            (error.code === "UNAUTHORIZED" || error.code === "FORBIDDEN")
          ) {
            throw new CanvasApiError({
              code: error.code,
              status: error.status,
              message: `list_account_users requires account-admin scope on the Canvas token (account_id=${args.account_id}). The current token is missing the necessary permissions.`,
              endpoint: error.endpoint,
            });
          }
          throw error;
        }

        const { anonymous, overridden } = resolveAnonymous(args.anonymous);
        // For account-wide users we don't have course context — use a synthetic
        // course id of 0 ("account scope") so pseudonyms are stable account-wide
        // but never collide with real per-course pseudonyms.
        const ACCOUNT_SCOPE_ID = 0;
        const finalUsers = anonymous
          ? await Promise.all(
              users.map((user) =>
                anonymizer.anonymizeUser(ACCOUNT_SCOPE_ID, user, { unknownRolePolicy: "student" }),
              ),
            )
          : users;

        const warnings = overridden ? [DEANON_DENIED_NOTE] : undefined;
        return jsonResult(
          {
            account_id: args.account_id,
            count: finalUsers.length,
            pages,
            truncated,
            anonymized: anonymous,
            ...(warnings ? { warnings } : {}),
            users: finalUsers,
          },
          {
            summary:
              `Account ${args.account_id}: ${finalUsers.length} user(s)${anonymous ? " (student/unknown anonymized)" : ""}.` +
              (overridden ? ` [override: ${DEANON_DENIED_NOTE}]` : ""),
          },
        );
      });
    },
  );
}
