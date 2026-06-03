import { describe, expect, it } from "vitest";

import { buildToolHarness } from "../_helpers/mockCanvas.js";
import { registerSchoolInfoTools } from "../../src/tools/school.js";
import type { SchoolConfig } from "../../src/schoolConfig.js";

interface ToolResponse {
  content?: Array<{ type: string; text: string }>;
  isError?: boolean;
  structuredContent?: Record<string, unknown>;
}

const franklinLike: SchoolConfig = {
  schoolName: "Franklin School (Jersey City, NJ)",
  competencyFramework: {
    name: "Franklin's 9 Transdisciplinary Competencies",
    competencies: [
      { key: "collaboration", name: "Collaboration", description: "Works productively..." },
      { key: "agency", name: "Agency", description: "Takes initiative..." },
    ],
  },
  academicCalendar: {
    weeksPerYear: 35,
    classPeriodMinutes: 50,
    yearStart: "2026-08-24",
  },
  pageTemplates: {
    lesson: {
      titleFormat: "Lesson: {name}",
      html: "<div>{{title}} {{body}}</div>",
    },
    assessment: {
      titleFormat: "{type}: {name} [Week {week}] {percent}% ASMT",
      html: "<div>{{title}} {{body}}</div>",
    },
  },
};

const minimalConfig: SchoolConfig = {
  schoolName: "Bare Minimum School",
};

describe("registerSchoolInfoTools", () => {
  it("registers get_school_info whether or not a config is loaded", () => {
    const withConfig = buildToolHarness();
    registerSchoolInfoTools(withConfig.server as never, franklinLike);
    expect(withConfig.tools.has("get_school_info")).toBe(true);

    const withoutConfig = buildToolHarness();
    registerSchoolInfoTools(withoutConfig.server as never, null);
    expect(withoutConfig.tools.has("get_school_info")).toBe(true);
  });

  it("returns the not-configured shape when no school config is loaded", async () => {
    const harness = buildToolHarness();
    registerSchoolInfoTools(harness.server as never, null);
    const result = (await harness.call("get_school_info")) as ToolResponse;
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toMatchObject({
      configured: false,
    });
    expect((result.structuredContent as { message: string }).message).toMatch(/SCHOOL_CONFIG/);
  });

  it("returns the full school info shape when a full config is loaded", async () => {
    const harness = buildToolHarness();
    registerSchoolInfoTools(harness.server as never, franklinLike);
    const result = (await harness.call("get_school_info")) as ToolResponse;
    expect(result.isError).toBeFalsy();

    const content = result.structuredContent as Record<string, unknown>;
    expect(content.configured).toBe(true);
    expect(content.school_name).toBe("Franklin School (Jersey City, NJ)");
    expect(content.page_template_names).toEqual(["lesson", "assessment"]);

    const calendar = content.academic_calendar as Record<string, unknown>;
    expect(calendar.weeks_per_year).toBe(35);
    expect(calendar.class_period_minutes).toBe(50);
    expect(calendar.year_start).toBe("2026-08-24");
    expect(typeof calendar.current_week === "number" || calendar.current_week === null).toBe(true);

    const framework = content.competency_framework as Record<string, unknown>;
    expect(framework).toMatchObject({
      configured: true,
      name: "Franklin's 9 Transdisciplinary Competencies",
      count: 2,
    });
  });

  it("computes current_week correctly for a yearStart in the past", async () => {
    const harness = buildToolHarness();
    const cfg: SchoolConfig = {
      schoolName: "Test",
      academicCalendar: {
        weeksPerYear: 35,
        yearStart: new Date(Date.now() - 14 * 24 * 60 * 60 * 1000)
          .toISOString()
          .slice(0, 10),
      },
    };
    registerSchoolInfoTools(harness.server as never, cfg);
    const result = (await harness.call("get_school_info")) as ToolResponse;
    const calendar = (result.structuredContent as { academic_calendar: { current_week: number } })
      .academic_calendar;
    expect(calendar.current_week).toBe(3);
  });

  it("returns current_week=null when yearStart is missing", async () => {
    const harness = buildToolHarness();
    const cfg: SchoolConfig = {
      schoolName: "Test",
      academicCalendar: { weeksPerYear: 35 },
    };
    registerSchoolInfoTools(harness.server as never, cfg);
    const result = (await harness.call("get_school_info")) as ToolResponse;
    const calendar = (result.structuredContent as {
      academic_calendar: { current_week: number | null };
    }).academic_calendar;
    expect(calendar.current_week).toBeNull();
  });

  it("handles a minimal config (just schoolName, no calendar, no templates)", async () => {
    const harness = buildToolHarness();
    registerSchoolInfoTools(harness.server as never, minimalConfig);
    const result = (await harness.call("get_school_info")) as ToolResponse;
    const content = result.structuredContent as Record<string, unknown>;
    expect(content.configured).toBe(true);
    expect(content.school_name).toBe("Bare Minimum School");
    expect(content.academic_calendar).toBeNull();
    expect(content.competency_framework).toEqual({ configured: false });
    expect(content.page_template_names).toEqual([]);
  });
});
