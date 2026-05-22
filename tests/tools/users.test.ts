import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { buildMockCanvas, buildToolHarness } from "../_helpers/mockCanvas.js";
import { registerUserTools } from "../../src/tools/users.js";
import { Anonymizer } from "../../src/anonymizer.js";

interface ToolResponse {
  content?: Array<{ type: string; text: string }>;
  isError?: boolean;
  structuredContent?: Record<string, unknown>;
}

let anonRoot: string;
let anonymizer: Anonymizer;
beforeEach(async () => {
  anonRoot = await fs.mkdtemp(path.join(os.tmpdir(), "canvas-anon-users-"));
  anonymizer = new Anonymizer({ rootDir: anonRoot });
  await anonymizer.init();
});
afterEach(async () => {
  await fs.rm(anonRoot, { recursive: true, force: true });
});

describe("registerUserTools", () => {
  it("registers all three user tools", () => {
    const { client } = buildMockCanvas([]);
    const harness = buildToolHarness();
    registerUserTools(harness.server as never, client, anonymizer);
    expect([...harness.tools.keys()].sort()).toEqual([
      "list_account_users",
      "list_user_enrollments",
      "list_users",
    ]);
  });

  describe("list_users", () => {
    it("anonymizes students by default and includes enrollments+email", async () => {
      const { client, requests } = buildMockCanvas([
        {
          status: 200,
          data: [
            { id: 1001, name: "Alice Real", email: "alice@school.edu", enrollments: [{ type: "StudentEnrollment" }] },
            { id: 1002, name: "Bob Real", email: "bob@school.edu", enrollments: [{ type: "StudentEnrollment" }] },
          ],
        },
      ]);
      const harness = buildToolHarness();
      registerUserTools(harness.server as never, client, anonymizer);

      const result = (await harness.call("list_users", {
        course_identifier: 60366,
        include_email: true,
      })) as ToolResponse;
      expect(result.isError).toBeFalsy();
      expect(requests[0]?.params).toMatchObject({
        "enrollment_type[]": ["student"],
        "include[]": ["enrollments", "email"],
      });
      const users = result.structuredContent?.users as Array<{ name: string; email: string }>;
      expect(users.map((user) => user.name)).toEqual(["Student 1", "Student 2"]);
      expect(users[0]?.email).toBe("student1@anonymized.local");
      expect(result.structuredContent?.anonymized).toBe(true);
    });

    it("with anonymous=false returns raw names/emails", async () => {
      const { client } = buildMockCanvas([
        {
          status: 200,
          data: [
            { id: 1001, name: "Alice Real", email: "alice@school.edu", enrollments: [{ type: "StudentEnrollment" }] },
          ],
        },
      ]);
      const harness = buildToolHarness();
      registerUserTools(harness.server as never, client, anonymizer);
      const result = (await harness.call("list_users", {
        course_identifier: 60366,
        anonymous: false,
      })) as ToolResponse;
      const users = result.structuredContent?.users as Array<{ name: string }>;
      expect(users[0]?.name).toBe("Alice Real");
    });

    it("preserves teachers verbatim even when listed with anonymous=true", async () => {
      const { client } = buildMockCanvas([
        {
          status: 200,
          data: [
            { id: 5000, name: "Mr. Smith", enrollments: [{ type: "TeacherEnrollment" }] },
            { id: 1001, name: "Alice Real", enrollments: [{ type: "StudentEnrollment" }] },
          ],
        },
      ]);
      const harness = buildToolHarness();
      registerUserTools(harness.server as never, client, anonymizer);
      const result = (await harness.call("list_users", {
        course_identifier: 60366,
        enrollment_type: ["teacher", "student"],
      })) as ToolResponse;
      const users = result.structuredContent?.users as Array<{ id: number; name: string }>;
      expect(users.find((user) => user.id === 5000)?.name).toBe("Mr. Smith");
      expect(users.find((user) => user.id === 1001)?.name).toBe("Student 1");
    });
  });

  describe("list_user_enrollments", () => {
    it("returns course_id+role+state per enrollment", async () => {
      const { client, requests } = buildMockCanvas([
        {
          status: 200,
          data: [
            { id: 1, course_id: 60366, user_id: 1001, type: "StudentEnrollment", role: "StudentEnrollment", enrollment_state: "active" },
            { id: 2, course_id: 60367, user_id: 1001, type: "StudentEnrollment", role: "StudentEnrollment", enrollment_state: "active" },
          ],
        },
      ]);
      const harness = buildToolHarness();
      registerUserTools(harness.server as never, client, anonymizer);
      const result = (await harness.call("list_user_enrollments", { user_id: 1001 })) as ToolResponse;
      expect(result.isError).toBeFalsy();
      expect(requests[0]?.url).toBe("/api/v1/users/1001/enrollments");
      expect(requests[0]?.params).toMatchObject({ "state[]": ["active"] });
      const enrollments = result.structuredContent?.enrollments as Array<{ course_id: number }>;
      expect(enrollments).toHaveLength(2);
    });
  });

  describe("list_account_users", () => {
    it("returns a clean scope-required error on 403", async () => {
      const { client } = buildMockCanvas([
        { status: 403, data: { errors: [{ message: "Insufficient permissions" }] } },
      ]);
      const harness = buildToolHarness();
      registerUserTools(harness.server as never, client, anonymizer);
      const result = (await harness.call("list_account_users", { account_id: 1 })) as ToolResponse;
      expect(result.isError).toBe(true);
      expect(result.content?.[0]?.text).toMatch(/account-admin scope/);
    });

    it("anonymizes student/unknown roles by default", async () => {
      const { client, requests } = buildMockCanvas([
        {
          status: 200,
          data: [
            { id: 1001, name: "Student Person", role: "student" },
            { id: 5000, name: "Teacher Person", role: "teacher" },
            { id: 9999, name: "Mystery Person" }, // no role
          ],
        },
      ]);
      const harness = buildToolHarness();
      registerUserTools(harness.server as never, client, anonymizer);
      const result = (await harness.call("list_account_users", { account_id: 1 })) as ToolResponse;
      const users = result.structuredContent?.users as Array<{ id: number; name: string }>;
      expect(users.find((user) => user.id === 5000)?.name).toBe("Teacher Person");
      // Student and unknown both get anonymized (account-scope id 0).
      expect(users.find((user) => user.id === 1001)?.name).toMatch(/^Student \d+$/);
      expect(users.find((user) => user.id === 9999)?.name).toMatch(/^Student \d+$/);
      expect(requests[0]?.url).toBe("/api/v1/accounts/1/users");
    });

    it("threads search_term into Canvas", async () => {
      const { client, requests } = buildMockCanvas([{ status: 200, data: [] }]);
      const harness = buildToolHarness();
      registerUserTools(harness.server as never, client, anonymizer);
      await harness.call("list_account_users", { account_id: 1, search_term: "Smith" });
      expect(requests[0]?.params).toMatchObject({ search_term: "Smith" });
    });
  });
});
