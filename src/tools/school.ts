import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import type { SchoolConfig } from "../schoolConfig.js";
import { computeAcademicWeek } from "../schoolConfig.js";
import { jsonResult, safeHandler } from "./toolHelpers.js";

export function registerSchoolInfoTools(
  server: McpServer,
  schoolConfig: SchoolConfig | null,
): void {
  server.registerTool(
    "get_school_info",
    {
      description:
        "Return the loaded school configuration's metadata — school name, academic calendar (weeks per year, class period minutes, year start date, current academic week), competency framework summary, and configured page templates. Use this to discover school-specific defaults (class period length, current week number) so skills don't have to ask the teacher. Returns a structured 'not configured' response when no SCHOOL_CONFIG is loaded.",
      inputSchema: {},
    },
    async () => {
      return safeHandler("get_school_info", async () => {
        if (!schoolConfig) {
          return jsonResult(
            {
              configured: false,
              message:
                "No school config is loaded. Set SCHOOL_CONFIG in the MCP server env to a JSON file (see configs/example.json) to enable school-specific defaults like class period length and the current academic week.",
            },
            { summary: "No school config loaded." },
          );
        }

        const calendar = schoolConfig.academicCalendar;
        const today = new Date();
        const currentWeek = calendar ? computeAcademicWeek(today, calendar) : null;
        const hasWeekTable = (calendar?.weeks?.length ?? 0) > 0;

        let onBreak = false;
        if (hasWeekTable && currentWeek === null) {
          const weekStartTimes = calendar!.weeks!.map((entry) =>
            Date.parse(`${entry.start}T00:00:00Z`),
          );
          const yearBeginsMs = Math.min(...weekStartTimes);
          const yearEndsMs = Math.max(...weekStartTimes) + 7 * 24 * 60 * 60 * 1000;
          onBreak = today.getTime() >= yearBeginsMs && today.getTime() < yearEndsMs;
        }

        const academicCalendar = calendar
          ? {
              weeks_per_year: calendar.weeksPerYear ?? null,
              class_period_minutes: calendar.classPeriodMinutes ?? null,
              year_start: calendar.yearStart ?? null,
              term_names: calendar.termNames ?? null,
              current_week: currentWeek,
              week_source: hasWeekTable ? "calendar_table" : "computed",
              ...(onBreak ? { on_break: true } : {}),
            }
          : null;

        const framework = schoolConfig.competencyFramework;
        const competencyFramework = framework
          ? {
              configured: true,
              name: framework.name,
              description: framework.description ?? null,
              count: framework.competencies.length,
            }
          : { configured: false };

        const templates = schoolConfig.pageTemplates ?? {};
        const pageTemplateNames = Object.keys(templates);

        return jsonResult(
          {
            configured: true,
            school_name: schoolConfig.schoolName ?? null,
            academic_calendar: academicCalendar,
            competency_framework: competencyFramework,
            page_template_names: pageTemplateNames,
            usage_hint:
              "Use academic_calendar.class_period_minutes as the default Stage-3 lesson duration. " +
              "Use academic_calendar.current_week for today's official week number (week_source " +
              "'calendar_table' means it comes from the school's published calendar with breaks " +
              "skipped; 'computed' means weeks-since-yearStart approximation). " +
              "Call list_page_templates for per-template metadata including titleFormat.",
          },
          {
            summary:
              `${schoolConfig.schoolName ?? "School"} — ${pageTemplateNames.length} template(s), ` +
              `period ${calendar?.classPeriodMinutes ?? "?"} min, ` +
              `${
                currentWeek != null
                  ? `week ${currentWeek}`
                  : onBreak
                    ? "school is on break this week"
                    : calendar
                      ? "outside the configured school year (no current week)"
                      : "no calendar configured"
              }.`,
          },
        );
      });
    },
  );
}
