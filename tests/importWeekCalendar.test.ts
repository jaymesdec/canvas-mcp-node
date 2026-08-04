import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const scriptPath = path.resolve("scripts/import-week-calendar.mjs");

const fixtureIcs = [
  "BEGIN:VCALENDAR",
  "VERSION:2.0",
  "BEGIN:VEVENT",
  "SUMMARY:Week 1",
  "DTSTART;VALUE=DATE:20260831",
  "END:VEVENT",
  "BEGIN:VEVENT",
  // RFC 5545 folded line — continuation starts with a space
  "SUMMARY:Week",
  "  0",
  "DTSTART;VALUE=DATE:20260824",
  "END:VEVENT",
  "BEGIN:VEVENT",
  "SUMMARY:Week 2 Reminder",
  "DTSTART;VALUE=DATE:20260907",
  "END:VEVENT",
  "BEGIN:VEVENT",
  "SUMMARY:Spring Break",
  "DTSTART;VALUE=DATE:20270315",
  "END:VEVENT",
  "BEGIN:VEVENT",
  "SUMMARY:Week 2",
  "DTSTART:20260914T000000Z",
  "END:VEVENT",
  "END:VCALENDAR",
].join("\r\n");

let tmpRoot: string;

beforeEach(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "week-calendar-import-"));
});
afterEach(async () => {
  await fs.rm(tmpRoot, { recursive: true, force: true });
});

describe("scripts/import-week-calendar.mjs", () => {
  it("extracts 'Week N' events into academicCalendar.weeks, preserving other config fields", async () => {
    const icsPath = path.join(tmpRoot, "calendar.ics");
    const configPath = path.join(tmpRoot, "school.json");
    await fs.writeFile(icsPath, fixtureIcs);
    await fs.writeFile(
      configPath,
      JSON.stringify({
        schoolName: "Import Test School",
        academicCalendar: { weeksPerYear: 36, yearStart: "2026-08-24" },
      }),
    );

    const { stdout } = await execFileAsync("node", [scriptPath, icsPath, configPath]);
    expect(stdout).toMatch(/imported 3 weeks/);

    const updated = JSON.parse(await fs.readFile(configPath, "utf8"));
    expect(updated.schoolName).toBe("Import Test School");
    expect(updated.academicCalendar.weeksPerYear).toBe(36);
    expect(updated.academicCalendar.yearStart).toBe("2026-08-24");
    expect(updated.academicCalendar.weeks).toEqual([
      { week: 0, start: "2026-08-24" },
      { week: 1, start: "2026-08-31" },
      { week: 2, start: "2026-09-14" },
    ]);
  });

  it("fails with a clear error when no Week events are present", async () => {
    const icsPath = path.join(tmpRoot, "empty.ics");
    const configPath = path.join(tmpRoot, "school.json");
    await fs.writeFile(icsPath, "BEGIN:VCALENDAR\r\nEND:VCALENDAR\r\n");
    await fs.writeFile(configPath, JSON.stringify({ schoolName: "X" }));

    await expect(execFileAsync("node", [scriptPath, icsPath, configPath])).rejects.toMatchObject({
      stderr: expect.stringMatching(/no VEVENTs with SUMMARY matching "Week N"/),
    });
    expect(JSON.parse(await fs.readFile(configPath, "utf8"))).toEqual({ schoolName: "X" });
  });
});
