import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { computeAcademicWeek, explainAcademicWeek, loadSchoolConfig, type SchoolConfig } from "../src/schoolConfig.js";

let tmpRoot: string;
let warnings: string[];

beforeEach(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "school-config-"));
  warnings = [];
});
afterEach(async () => {
  delete process.env.SCHOOL_CONFIG;
  await fs.rm(tmpRoot, { recursive: true, force: true });
});

describe("loadSchoolConfig", () => {
  it("returns null when no SCHOOL_CONFIG is set", async () => {
    delete process.env.SCHOOL_CONFIG;
    await expect(loadSchoolConfig()).resolves.toBeNull();
  });

  it("loads + validates a well-formed config", async () => {
    const configPath = path.join(tmpRoot, "school.json");
    await fs.writeFile(
      configPath,
      JSON.stringify({
        schoolName: "Test School",
        competencyFramework: {
          name: "Test Framework",
          competencies: [{ key: "k1", name: "Name 1", description: "Desc 1" }],
        },
      }),
    );

    const result = await loadSchoolConfig({ configPath });
    expect(result).not.toBeNull();
    expect(result?.schoolName).toBe("Test School");
    expect(result?.competencyFramework?.competencies).toHaveLength(1);
  });

  it("warns + returns null when the file is missing", async () => {
    const missing = path.join(tmpRoot, "nope.json");
    const result = await loadSchoolConfig({
      configPath: missing,
      warn: (message) => warnings.push(message),
    });
    expect(result).toBeNull();
    expect(warnings[0]).toMatch(/could not be read/);
    expect(warnings[0]).toMatch(/Continuing without a school preset/);
  });

  it("warns + returns null on invalid JSON", async () => {
    const broken = path.join(tmpRoot, "broken.json");
    await fs.writeFile(broken, "{ not valid");
    const result = await loadSchoolConfig({
      configPath: broken,
      warn: (message) => warnings.push(message),
    });
    expect(result).toBeNull();
    expect(warnings[0]).toMatch(/not valid JSON/);
  });

  it("warns + returns null when the schema doesn't match", async () => {
    const invalid = path.join(tmpRoot, "invalid.json");
    await fs.writeFile(
      invalid,
      JSON.stringify({
        // competencyFramework is present but competencies is empty — should fail .min(1)
        competencyFramework: { name: "x", competencies: [] },
      }),
    );
    const result = await loadSchoolConfig({
      configPath: invalid,
      warn: (message) => warnings.push(message),
    });
    expect(result).toBeNull();
    expect(warnings[0]).toMatch(/failed validation/);
  });

  it("reads the path from SCHOOL_CONFIG env var when no explicit path is given", async () => {
    const configPath = path.join(tmpRoot, "via-env.json");
    await fs.writeFile(
      configPath,
      JSON.stringify({
        schoolName: "Via Env",
        competencyFramework: {
          name: "Env Framework",
          competencies: [{ key: "a", name: "A", description: "A desc" }],
        },
      }),
    );
    process.env.SCHOOL_CONFIG = configPath;
    const result = await loadSchoolConfig();
    expect(result?.schoolName).toBe("Via Env");
  });

  it("validates the shipped configs/franklin.json", async () => {
    const franklinPath = path.resolve("configs/franklin.json");
    const result = await loadSchoolConfig({
      configPath: franklinPath,
      warn: (message) => warnings.push(message),
    });
    expect(warnings).toEqual([]);
    expect(result).not.toBeNull();
    expect(result?.competencyFramework?.competencies).toHaveLength(9);
    expect(result?.competencyFramework?.competencies.map((entry) => entry.name)).toEqual([
      "Collaboration",
      "Storytelling / Communication",
      "Reflexivity",
      "Empathy / Perspective Taking",
      "Knowledge-Based Reasoning",
      "Futures Thinking",
      "Systems Thinking",
      "Adaptability",
      "Agency",
    ]);

    // Module outcomes template
    const moduleOutcomes = result?.pageTemplates?.module_outcomes;
    expect(moduleOutcomes).toBeDefined();
    expect(Object.keys(moduleOutcomes?.slots ?? {})).toEqual(["outcomes"]);
    expect(moduleOutcomes?.html).toContain('<h3><i class="fa fa-check"');
    expect(moduleOutcomes?.html).toContain("By the end of the MODULE");
    expect(moduleOutcomes?.html).toContain('<ol id="kl_objective_list">');
    expect(moduleOutcomes?.html).toContain("{{slot:outcomes}}");

    // Lesson template
    const lesson = result?.pageTemplates?.lesson;
    expect(lesson).toBeDefined();
    expect(Object.keys(lesson?.slots ?? {}).sort()).toEqual([
      "about",
      "assessment",
      "concepts",
      "discussion",
      "resources",
      "tasks",
      "to",
    ]);
    expect(lesson?.sections?.discussion?.default).toBe("omit");
    expect(lesson?.sections?.assessment?.default).toBe("include");

    // Assessment template
    const assessment = result?.pageTemplates?.assessment;
    expect(assessment).toBeDefined();
    expect(Object.keys(assessment?.slots ?? {}).sort()).toEqual([
      "ai_use",
      "description",
      "pre_work",
      "structure_and_grading",
      "submission",
      "time",
    ]);
    // No optional sections on assessment — every block is required
    expect(assessment?.sections).toBeUndefined();
    // The grade boundaries table is part of the structure_and_grading slot content (skill-generated)
    // — the template itself doesn't bake the table HTML in, so the structure_and_grading <h3> heading
    // is what should appear in the HTML, with the slot token directly under it.
    expect(assessment?.html).toContain('<h3>Structure and Grading</h3>');
    expect(assessment?.html).toContain('{{slot:structure_and_grading}}');
  });

  it("ships the 2026-27 week table in configs/franklin.json", async () => {
    const result = await loadSchoolConfig({
      configPath: path.resolve("configs/franklin.json"),
      warn: (message) => warnings.push(message),
    });
    expect(warnings).toEqual([]);
    const calendar = result?.academicCalendar;
    expect(calendar?.weeksPerYear).toBe(36);
    expect(calendar?.weeks).toHaveLength(37);
    expect(calendar?.weeks?.[0]).toEqual({ week: 0, start: "2026-08-24" });
    expect(calendar?.weeks?.[36]).toEqual({ week: 36, start: "2027-06-07" });
  });

  it("validates the shipped configs/example.json", async () => {
    const examplePath = path.resolve("configs/example.json");
    const result = await loadSchoolConfig({
      configPath: examplePath,
      warn: (message) => warnings.push(message),
    });
    expect(warnings).toEqual([]);
    expect(result).not.toBeNull();
  });
});

describe("computeAcademicWeek", () => {
  it("returns 1 for the yearStart date itself", () => {
    expect(
      computeAcademicWeek(new Date("2026-08-24T12:00:00Z"), {
        weeksPerYear: 35,
        yearStart: "2026-08-24",
      }),
    ).toBe(1);
  });

  it("returns 1 for the first 6 days after yearStart", () => {
    expect(
      computeAcademicWeek(new Date("2026-08-30T23:00:00Z"), {
        weeksPerYear: 35,
        yearStart: "2026-08-24",
      }),
    ).toBe(1);
  });

  it("returns 2 starting from day 7 after yearStart", () => {
    expect(
      computeAcademicWeek(new Date("2026-08-31T00:00:00Z"), {
        weeksPerYear: 35,
        yearStart: "2026-08-24",
      }),
    ).toBe(2);
  });

  it("returns the correct week for a date several weeks in", () => {
    expect(
      computeAcademicWeek(new Date("2026-11-02T00:00:00Z"), {
        weeksPerYear: 35,
        yearStart: "2026-08-24",
      }),
    ).toBe(11);
  });

  it("clamps to weeksPerYear when the date is past year-end", () => {
    expect(
      computeAcademicWeek(new Date("2030-01-01T00:00:00Z"), {
        weeksPerYear: 35,
        yearStart: "2026-08-24",
      }),
    ).toBe(35);
  });

  it("clamps to 1 when the date is before yearStart", () => {
    expect(
      computeAcademicWeek(new Date("2026-01-01T00:00:00Z"), {
        weeksPerYear: 35,
        yearStart: "2026-08-24",
      }),
    ).toBe(1);
  });

  it("returns null when yearStart is missing", () => {
    expect(
      computeAcademicWeek(new Date("2026-10-01T00:00:00Z"), { weeksPerYear: 35 }),
    ).toBeNull();
  });

  it("returns null when calendar is undefined", () => {
    expect(computeAcademicWeek(new Date(), undefined)).toBeNull();
  });

  it("falls back to yearStart math when the weeks table is empty", () => {
    expect(
      computeAcademicWeek(new Date("2026-11-02T00:00:00Z"), {
        weeksPerYear: 35,
        yearStart: "2026-08-24",
        weeks: [],
      }),
    ).toBe(11);
  });
});

describe("computeAcademicWeek with the franklin week table", () => {
  let franklinCalendar: NonNullable<SchoolConfig["academicCalendar"]>;

  beforeAll(async () => {
    const franklin = await loadSchoolConfig({
      configPath: path.resolve("configs/franklin.json"),
    });
    franklinCalendar = franklin!.academicCalendar!;
  });

  it("returns the table week for a mid-week date", () => {
    expect(computeAcademicWeek(new Date("2027-04-15T12:00:00Z"), franklinCalendar)).toBe(28);
  });

  it("returns the table week on the Monday the week starts", () => {
    expect(computeAcademicWeek(new Date("2027-04-12T00:00:00Z"), franklinCalendar)).toBe(28);
  });

  it("returns the table week on the Saturday within the week", () => {
    expect(computeAcademicWeek(new Date("2027-04-17T23:00:00Z"), franklinCalendar)).toBe(28);
  });

  it("returns 0 for a date in Week 0", () => {
    expect(computeAcademicWeek(new Date("2026-08-26T12:00:00Z"), franklinCalendar)).toBe(0);
  });

  it("returns null during the Thanksgiving break gap", () => {
    expect(computeAcademicWeek(new Date("2026-11-25T12:00:00Z"), franklinCalendar)).toBeNull();
  });

  it("returns null during the spring break gap", () => {
    expect(computeAcademicWeek(new Date("2027-03-20T12:00:00Z"), franklinCalendar)).toBeNull();
  });

  it("returns null before Week 0 starts", () => {
    expect(computeAcademicWeek(new Date("2026-08-20T12:00:00Z"), franklinCalendar)).toBeNull();
  });

  it("returns null after Week 36 ends", () => {
    expect(computeAcademicWeek(new Date("2027-06-20T12:00:00Z"), franklinCalendar)).toBeNull();
  });

  it("does not clamp to the yearStart math when the table misses", () => {
    // The naive math would return a week number for 2027-06-20; the table must win.
    expect(franklinCalendar.yearStart).toBe("2026-08-24");
    expect(computeAcademicWeek(new Date("2027-06-20T12:00:00Z"), franklinCalendar)).toBeNull();
  });
});

describe("explainAcademicWeek", () => {
  let franklinCalendar: NonNullable<SchoolConfig["academicCalendar"]>;

  beforeAll(async () => {
    const franklin = await loadSchoolConfig({
      configPath: path.resolve("configs/franklin.json"),
    });
    franklinCalendar = franklin!.academicCalendar!;
  });

  it("returns ok with the week for an in-week date", () => {
    const explanation = explainAcademicWeek(new Date("2027-04-15T12:00:00Z"), franklinCalendar);
    expect(explanation).toEqual({ week: 28, reason: "ok" });
  });

  it("identifies the spring-break gap with both surrounding weeks", () => {
    const explanation = explainAcademicWeek(new Date("2027-03-15T12:00:00Z"), franklinCalendar);
    expect(explanation.reason).toBe("break");
    expect(explanation.week).toBeNull();
    expect(explanation.previous).toEqual({ week: 25, end: "2027-03-14" });
    expect(explanation.next).toEqual({ week: 26, start: "2027-03-29" });
  });

  it("identifies dates before the year with the first week", () => {
    const explanation = explainAcademicWeek(new Date("2026-08-01T12:00:00Z"), franklinCalendar);
    expect(explanation.reason).toBe("before_year");
    expect(explanation.next).toEqual({ week: 0, start: "2026-08-24" });
  });

  it("identifies dates after the year with the last week", () => {
    const explanation = explainAcademicWeek(new Date("2027-07-01T12:00:00Z"), franklinCalendar);
    expect(explanation.reason).toBe("after_year");
    expect(explanation.previous).toEqual({ week: 36, end: "2027-06-13" });
  });

  it("reports no_calendar when neither table nor yearStart exists", () => {
    expect(explainAcademicWeek(new Date("2027-04-15T12:00:00Z"), undefined)).toEqual({
      week: null,
      reason: "no_calendar",
    });
  });
});
