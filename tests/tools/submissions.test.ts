import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { buildMockCanvas, buildToolHarness, parseJsonResult, type ToolResponse } from "../_helpers/mockCanvas.js";
import { Anonymizer } from "../../src/anonymizer.js";
import { registerSubmissionTools } from "../../src/tools/submissions.js";

let anonRoot: string;
let workDir: string;
let anonymizer: Anonymizer;
let previousCwd: string;
beforeEach(async () => {
  anonRoot = await fs.mkdtemp(path.join(os.tmpdir(), "canvas-anon-subs-"));
  workDir = await fs.mkdtemp(path.join(os.tmpdir(), "canvas-subs-cwd-"));
  anonymizer = new Anonymizer({ rootDir: anonRoot });
  await anonymizer.init();
  previousCwd = process.cwd();
  process.chdir(workDir);
});
afterEach(async () => {
  process.chdir(previousCwd);
  await fs.rm(anonRoot, { recursive: true, force: true });
  await fs.rm(workDir, { recursive: true, force: true });
  delete process.env.CANVAS_MCP_ALLOW_DEANONYMIZE;
});

describe("registerSubmissionTools", () => {
  it("registers all three submission tools", () => {
    const { client } = buildMockCanvas([]);
    const harness = buildToolHarness();
    registerSubmissionTools(harness.server as never, client, anonymizer);
    expect([...harness.tools.keys()].sort()).toEqual([
      "download_submission_attachment",
      "get_submission_rubric_assessment",
      "list_submissions",
    ]);
  });

  describe("list_submissions", () => {
    it("anonymizes submitter and student comment authors by default; preserves teachers", async () => {
      const { client, requests } = buildMockCanvas([
        {
          status: 200,
          data: [
            {
              id: 1,
              user_id: 1001,
              user: { id: 1001, name: "Alice Real", role: "student" },
              submission_comments: [
                { id: 10, author: { id: 5000, name: "Mr. Smith", role: "teacher" }, comment: "Nice." },
                { id: 11, author: { id: 1001, name: "Alice Real", role: "student" }, comment: "Thanks!" },
              ],
              rubric_assessment: { _8027: { points: 4, comments: "Strong" } },
            },
          ],
        },
      ]);
      const harness = buildToolHarness();
      registerSubmissionTools(harness.server as never, client, anonymizer);

      const result = (await harness.call("list_submissions", {
        course_identifier: 60366,
        assignment_id: 999,
      })) as ToolResponse;
      expect(result.isError).toBeFalsy();
      expect(requests[0]?.url).toBe("/api/v1/courses/60366/assignments/999/submissions");
      expect(requests[0]?.params).toMatchObject({
        "include[]": ["user", "rubric_assessment", "submission_comments"],
      });
      expect(parseJsonResult(result).anonymized).toBe(true);
      const subs = parseJsonResult(result).submissions as Array<{
        user: { name: string };
        submission_comments: Array<{ author: { name: string } }>;
      }>;
      expect(subs[0]?.user.name).toBe("Student 1");
      expect(subs[0]?.submission_comments[0]?.author.name).toBe("Mr. Smith");
      expect(subs[0]?.submission_comments[1]?.author.name).toBe("Student 1");
    });

    it("anonymous=false without operator opt-in: silently anonymizes + warns", async () => {
      delete process.env.CANVAS_MCP_ALLOW_DEANONYMIZE;
      const { client } = buildMockCanvas([
        {
          status: 200,
          data: [
            {
              id: 1,
              user_id: 1001,
              user: { id: 1001, name: "Alice Real", role: "student" },
            },
          ],
        },
      ]);
      const harness = buildToolHarness();
      registerSubmissionTools(harness.server as never, client, anonymizer);
      const result = (await harness.call("list_submissions", {
        course_identifier: 60366,
        assignment_id: 999,
        anonymous: false,
      })) as ToolResponse;
      expect(parseJsonResult(result).anonymized).toBe(true);
      const warnings = parseJsonResult(result).warnings as string[];
      expect(warnings?.[0]).toMatch(/CANVAS_MCP_ALLOW_DEANONYMIZE/);
      const subs = parseJsonResult(result).submissions as Array<{ user: { name: string } }>;
      expect(subs[0]?.user.name).toBe("Student 1");
    });

    it("anonymous=false WITH operator opt-in: real names come through", async () => {
      process.env.CANVAS_MCP_ALLOW_DEANONYMIZE = "true";
      const { client } = buildMockCanvas([
        {
          status: 200,
          data: [
            {
              id: 1,
              user_id: 1001,
              user: { id: 1001, name: "Alice Real", role: "student" },
            },
          ],
        },
      ]);
      const harness = buildToolHarness();
      registerSubmissionTools(harness.server as never, client, anonymizer);
      const result = (await harness.call("list_submissions", {
        course_identifier: 60366,
        assignment_id: 999,
        anonymous: false,
      })) as ToolResponse;
      const subs = parseJsonResult(result).submissions as Array<{ user: { name: string } }>;
      expect(subs[0]?.user.name).toBe("Alice Real");
    });
  });

  describe("get_submission_rubric_assessment", () => {
    it("joins criterion descriptions from the assignment's rubric onto the assessment", async () => {
      const { client, requests } = buildMockCanvas([
        // assignment fetch (with rubric)
        {
          status: 200,
          data: {
            id: 999,
            rubric: [
              { id: "_8027", description: "Clarity", points: 4 },
              { id: "_8028", description: "Depth", points: 4 },
            ],
          },
        },
        // submission fetch
        {
          status: 200,
          data: {
            id: 1,
            user_id: 1001,
            rubric_assessment: {
              _8027: { points: 3, comments: "Good" },
              _8028: { points: 4, comments: "Excellent" },
            },
          },
        },
      ]);
      const harness = buildToolHarness();
      registerSubmissionTools(harness.server as never, client, anonymizer);
      const result = (await harness.call("get_submission_rubric_assessment", {
        course_identifier: 60366,
        assignment_id: 999,
        user_id: 1001,
      })) as ToolResponse;
      expect(result.isError).toBeFalsy();
      expect(requests).toHaveLength(2);
      const joined = parseJsonResult(result).rubric_assessment as Array<{
        criterion_id: string;
        description: string;
        points: number;
      }>;
      expect(joined).toHaveLength(2);
      expect(joined[0]?.criterion_id).toBe("_8027");
      expect(joined[0]?.description).toBe("Clarity");
      expect(joined[0]?.points).toBe(3);
      expect(joined[1]?.description).toBe("Depth");
    });

    it("returns a friendly message when the submission has no rubric assessment yet", async () => {
      const { client } = buildMockCanvas([
        { status: 200, data: { id: 999, rubric: [{ id: "_8027", description: "Clarity", points: 4 }] } },
        { status: 200, data: { id: 1, user_id: 1001, rubric_assessment: null } },
      ]);
      const harness = buildToolHarness();
      registerSubmissionTools(harness.server as never, client, anonymizer);
      const result = (await harness.call("get_submission_rubric_assessment", {
        course_identifier: 60366,
        assignment_id: 999,
        user_id: 1001,
      })) as ToolResponse;
      expect(parseJsonResult(result).rubric_assessment).toBeNull();
      expect(parseJsonResult(result).message).toMatch(/No rubric assessment/);
    });
  });

  describe("download_submission_attachment", () => {
    it("writes every attachment to disk and returns paths", async () => {
      const fileBuffer = Buffer.from("hello world");
      const { client } = buildMockCanvas([
        // submission fetch
        {
          status: 200,
          data: {
            id: 1,
            user_id: 1001,
            attachments: [
              {
                id: 555,
                filename: "report.pdf",
                display_name: "report.pdf",
                url: "https://canvas.example.com/files/555/download",
                content_type: "application/pdf",
                size: fileBuffer.byteLength,
              },
            ],
          },
        },
        // attachment fetch
        { status: 200, data: fileBuffer },
      ]);
      const harness = buildToolHarness();
      registerSubmissionTools(harness.server as never, client, anonymizer);
      const result = (await harness.call("download_submission_attachment", {
        course_identifier: 60366,
        assignment_id: 999,
        user_id: 1001,
      })) as ToolResponse;
      expect(result.isError).toBeFalsy();
      const files = parseJsonResult(result).files as Array<{ filename: string; path: string; size: number }>;
      expect(files).toHaveLength(1);
      expect(files[0]?.filename).toBe("1001-report.pdf");
      // File should actually exist on disk
      const onDisk = await fs.readFile(files[0]!.path);
      expect(onDisk.toString()).toBe("hello world");
      // Default target dir lives under cwd (which may be the symlink-resolved form of workDir on macOS)
      expect(files[0]?.path.startsWith(process.cwd())).toBe(true);
      expect(files[0]?.path).toContain(path.join("submissions", "60366", "999"));
    });

    it("returns {files:[], message} when the submission has no attachments", async () => {
      const { client } = buildMockCanvas([
        { status: 200, data: { id: 1, user_id: 1001, attachments: [] } },
      ]);
      const harness = buildToolHarness();
      registerSubmissionTools(harness.server as never, client, anonymizer);
      const result = (await harness.call("download_submission_attachment", {
        course_identifier: 60366,
        assignment_id: 999,
        user_id: 1001,
      })) as ToolResponse;
      expect(parseJsonResult(result).files).toEqual([]);
      expect(parseJsonResult(result).message).toMatch(/No attachments/);
    });

    it("respects an explicit attachment_id filter", async () => {
      const fileBuffer = Buffer.from("payload");
      const { client } = buildMockCanvas([
        {
          status: 200,
          data: {
            id: 1,
            user_id: 1001,
            attachments: [
              { id: 100, filename: "a.txt", url: "https://x/a", size: 1 },
              { id: 200, filename: "b.txt", url: "https://x/b", size: 2 },
            ],
          },
        },
        { status: 200, data: fileBuffer },
      ]);
      const harness = buildToolHarness();
      registerSubmissionTools(harness.server as never, client, anonymizer);
      const result = (await harness.call("download_submission_attachment", {
        course_identifier: 60366,
        assignment_id: 999,
        user_id: 1001,
        attachment_id: 200,
      })) as ToolResponse;
      const files = parseJsonResult(result).files as Array<{ filename: string }>;
      expect(files).toHaveLength(1);
      expect(files[0]?.filename).toBe("1001-b.txt");
    });

    it("respects an explicit target_dir override", async () => {
      const customDir = path.join(workDir, "custom-target");
      const fileBuffer = Buffer.from("xyz");
      const { client } = buildMockCanvas([
        {
          status: 200,
          data: {
            id: 1,
            user_id: 1001,
            attachments: [{ id: 100, filename: "a.txt", url: "https://x/a", size: 3 }],
          },
        },
        { status: 200, data: fileBuffer },
      ]);
      const harness = buildToolHarness();
      registerSubmissionTools(harness.server as never, client, anonymizer);
      const result = (await harness.call("download_submission_attachment", {
        course_identifier: 60366,
        assignment_id: 999,
        user_id: 1001,
        target_dir: customDir,
      })) as ToolResponse;
      const files = parseJsonResult(result).files as Array<{ path: string }>;
      expect(files[0]?.path.startsWith(customDir)).toBe(true);
    });

    it("surfaces a clean NOT_FOUND error when attachment_id doesn't match", async () => {
      const { client } = buildMockCanvas([
        {
          status: 200,
          data: {
            id: 1,
            user_id: 1001,
            attachments: [{ id: 100, filename: "a.txt", url: "https://x/a", size: 1 }],
          },
        },
      ]);
      const harness = buildToolHarness();
      registerSubmissionTools(harness.server as never, client, anonymizer);
      const result = (await harness.call("download_submission_attachment", {
        course_identifier: 60366,
        assignment_id: 999,
        user_id: 1001,
        attachment_id: 999_999,
      })) as ToolResponse;
      expect(result.isError).toBe(true);
      expect(result.content?.[0]?.text).toMatch(/attachment_id 999999 not found/);
    });
  });
});
