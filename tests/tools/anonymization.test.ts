import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { buildMockCanvas, buildToolHarness, parseJsonResult, type ToolResponse } from "../_helpers/mockCanvas.js";
import { Anonymizer } from "../../src/anonymizer.js";
import { registerAnonymizationTools } from "../../src/tools/anonymization.js";

let anonRoot: string;
let anonymizer: Anonymizer;
beforeEach(async () => {
  anonRoot = await fs.mkdtemp(path.join(os.tmpdir(), "canvas-anon-tools-"));
  anonymizer = new Anonymizer({ rootDir: anonRoot });
  await anonymizer.init();
});
afterEach(async () => {
  await fs.rm(anonRoot, { recursive: true, force: true });
});

describe("registerAnonymizationTools", () => {
  it("registers create_student_anonymization_map and get_anonymization_status", () => {
    const { client } = buildMockCanvas([]);
    const harness = buildToolHarness();
    registerAnonymizationTools(harness.server as never, client, anonymizer);
    expect([...harness.tools.keys()].sort()).toEqual([
      "create_student_anonymization_map",
      "get_anonymization_status",
    ]);
  });

  describe("create_student_anonymization_map", () => {
    afterEach(() => {
      delete process.env.CANVAS_MCP_ALLOW_DEANONYMIZE;
    });

    it("without operator opt-in: allocates pseudonyms but suppresses real_name/real_email + warns", async () => {
      delete process.env.CANVAS_MCP_ALLOW_DEANONYMIZE;
      const { client, requests } = buildMockCanvas([
        {
          status: 200,
          data: [
            { id: 1001, name: "Alice", email: "alice@school.edu", enrollments: [{ type: "StudentEnrollment" }] },
            { id: 1002, name: "Bob", email: "bob@school.edu", enrollments: [{ type: "StudentEnrollment" }] },
          ],
        },
      ]);
      const harness = buildToolHarness();
      registerAnonymizationTools(harness.server as never, client, anonymizer);
      const result = (await harness.call("create_student_anonymization_map", {
        course_identifier: 60366,
      })) as ToolResponse;
      expect(result.isError).toBeFalsy();
      expect(requests[0]?.params).toMatchObject({
        "enrollment_type[]": ["student"],
        "include[]": ["enrollments", "email"],
      });
      expect(parseJsonResult(result).real_names_visible).toBe(false);
      const mapping = parseJsonResult(result).mapping as Array<{
        user_id: number;
        real_name: string | null;
        real_email: string | null;
        pseudonym: string;
      }>;
      expect(mapping).toHaveLength(2);
      expect(mapping[0]?.pseudonym).toBe("Student 1");
      // Real names suppressed:
      expect(mapping[0]?.real_name).toBeNull();
      expect(mapping[0]?.real_email).toBeNull();
      const warnings = parseJsonResult(result).warnings as string[];
      expect(warnings?.[0]).toMatch(/CANVAS_MCP_ALLOW_DEANONYMIZE/);
      // The map file on disk still binds real ↔ pseudonym:
      const onDisk = await anonymizer.loadMap(60366);
      expect(onDisk?.students["1001"]?.pseudonym).toBe("Student 1");
    });

    it("WITH operator opt-in: returns the full real-name mapping", async () => {
      process.env.CANVAS_MCP_ALLOW_DEANONYMIZE = "true";
      const { client } = buildMockCanvas([
        {
          status: 200,
          data: [
            { id: 1001, name: "Alice", email: "alice@school.edu", enrollments: [{ type: "StudentEnrollment" }] },
            { id: 1002, name: "Bob", email: "bob@school.edu", enrollments: [{ type: "StudentEnrollment" }] },
            { id: 1003, name: "Carol", email: "carol@school.edu", enrollments: [{ type: "StudentEnrollment" }] },
          ],
        },
      ]);
      const harness = buildToolHarness();
      registerAnonymizationTools(harness.server as never, client, anonymizer);
      const result = (await harness.call("create_student_anonymization_map", {
        course_identifier: 60366,
      })) as ToolResponse;
      expect(parseJsonResult(result).real_names_visible).toBe(true);
      expect(parseJsonResult(result).newly_allocated).toBe(3);
      const mapping = parseJsonResult(result).mapping as Array<{
        real_name: string;
        pseudonym: string;
      }>;
      expect(mapping.map((entry) => entry.pseudonym)).toEqual(["Student 1", "Student 2", "Student 3"]);
      expect(mapping[0]?.real_name).toBe("Alice");
      expect(parseJsonResult(result).warnings).toBeUndefined();
    });

    it("is idempotent — second call with the same roster reports newly_allocated=0", async () => {
      const { client } = buildMockCanvas([
        {
          status: 200,
          data: [
            { id: 1001, name: "Alice", enrollments: [{ type: "StudentEnrollment" }] },
            { id: 1002, name: "Bob", enrollments: [{ type: "StudentEnrollment" }] },
          ],
        },
        {
          status: 200,
          data: [
            { id: 1001, name: "Alice", enrollments: [{ type: "StudentEnrollment" }] },
            { id: 1002, name: "Bob", enrollments: [{ type: "StudentEnrollment" }] },
          ],
        },
      ]);
      const harness = buildToolHarness();
      registerAnonymizationTools(harness.server as never, client, anonymizer);
      await harness.call("create_student_anonymization_map", { course_identifier: 60366 });
      const second = (await harness.call("create_student_anonymization_map", {
        course_identifier: 60366,
      })) as ToolResponse;
      expect(parseJsonResult(second).newly_allocated).toBe(0);
      expect(parseJsonResult(second).total_active).toBe(2);
    });

    it("marks removed students historical without renumbering", async () => {
      const { client } = buildMockCanvas([
        {
          status: 200,
          data: [
            { id: 1001, name: "Alice", enrollments: [{ type: "StudentEnrollment" }] },
            { id: 1002, name: "Bob", enrollments: [{ type: "StudentEnrollment" }] },
            { id: 1003, name: "Carol", enrollments: [{ type: "StudentEnrollment" }] },
          ],
        },
        {
          status: 200,
          data: [
            { id: 1001, name: "Alice", enrollments: [{ type: "StudentEnrollment" }] },
            { id: 1003, name: "Carol", enrollments: [{ type: "StudentEnrollment" }] }, // Bob gone
          ],
        },
      ]);
      const harness = buildToolHarness();
      registerAnonymizationTools(harness.server as never, client, anonymizer);
      await harness.call("create_student_anonymization_map", { course_identifier: 60366 });
      const after = (await harness.call("create_student_anonymization_map", {
        course_identifier: 60366,
      })) as ToolResponse;
      expect(parseJsonResult(after).total_active).toBe(2);
      expect(parseJsonResult(after).total_historical).toBe(1);
      // Carol keeps Student 3, no renumbering.
      const fileRaw = await fs.readFile(path.join(anonRoot, "60366.json"), "utf8");
      const parsed = JSON.parse(fileRaw) as {
        students: Record<string, { pseudonym: string; status: string }>;
      };
      expect(parsed.students["1003"]?.pseudonym).toBe("Student 3");
      expect(parsed.students["1002"]?.status).toBe("historical");
    });
  });

  describe("get_anonymization_status", () => {
    it("returns empty list when no maps exist", async () => {
      const { client } = buildMockCanvas([]);
      const harness = buildToolHarness();
      registerAnonymizationTools(harness.server as never, client, anonymizer);
      const result = (await harness.call("get_anonymization_status")) as ToolResponse;
      expect(parseJsonResult(result).map_count).toBe(0);
      expect(parseJsonResult(result).maps).toEqual([]);
    });

    it("lists every map with course_id, entries, and timestamp", async () => {
      const { client } = buildMockCanvas([
        // For create_student_anonymization_map calls below:
        {
          status: 200,
          data: [{ id: 1001, name: "Alice", enrollments: [{ type: "StudentEnrollment" }] }],
        },
        {
          status: 200,
          data: [
            { id: 1, name: "S1", enrollments: [{ type: "StudentEnrollment" }] },
            { id: 2, name: "S2", enrollments: [{ type: "StudentEnrollment" }] },
          ],
        },
      ]);
      const harness = buildToolHarness();
      registerAnonymizationTools(harness.server as never, client, anonymizer);
      await harness.call("create_student_anonymization_map", { course_identifier: 100 });
      await harness.call("create_student_anonymization_map", { course_identifier: 200 });

      const result = (await harness.call("get_anonymization_status")) as ToolResponse;
      const maps = parseJsonResult(result).maps as Array<{ course_id: number; entries: number }>;
      expect(maps).toHaveLength(2);
      expect(maps.find((map) => map.course_id === 100)?.entries).toBe(1);
      expect(maps.find((map) => map.course_id === 200)?.entries).toBe(2);
    });
  });
});
