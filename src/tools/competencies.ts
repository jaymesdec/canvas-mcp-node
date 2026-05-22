import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import type { SchoolConfig } from "../schoolConfig.js";
import { jsonResult, safeHandler } from "./toolHelpers.js";

function formatFrameworkText(framework: NonNullable<SchoolConfig["competencyFramework"]>): string {
  const lines = [`${framework.name}:`, ""];
  if (framework.description) {
    lines.push(framework.description, "");
  }
  framework.competencies.forEach((entry, index) => {
    lines.push(`${index + 1}. **${entry.name}**: ${entry.description}`);
  });
  return lines.join("\n");
}

export function registerCompetencyTools(
  server: McpServer,
  schoolConfig: SchoolConfig | null,
): void {
  server.registerTool(
    "list_competencies",
    {
      description:
        "Return the configured school's competency framework (e.g., Franklin's 9 TD Competencies). Reads from the SCHOOL_CONFIG JSON file. Returns a structured 'not configured' response when no framework is loaded — set SCHOOL_CONFIG in the MCP server env to enable.",
      inputSchema: {},
    },
    async () => {
      return safeHandler("list_competencies", async () => {
        const framework = schoolConfig?.competencyFramework;
        if (!framework) {
          return jsonResult(
            {
              configured: false,
              message:
                "No competency framework is configured. Set SCHOOL_CONFIG in the MCP server env to a JSON file with a competencyFramework field. See configs/example.json in the canvas-mcp repo for the expected shape.",
            },
            {
              summary:
                "No competency framework configured — set SCHOOL_CONFIG to a JSON file with a competencyFramework field.",
            },
          );
        }
        return jsonResult(
          {
            configured: true,
            school_name: schoolConfig?.schoolName ?? null,
            framework_name: framework.name,
            framework_description: framework.description ?? null,
            count: framework.competencies.length,
            competencies: framework.competencies,
            display_text: formatFrameworkText(framework),
          },
          {
            summary: `${framework.name}: ${framework.competencies.length} competencies.`,
          },
        );
      });
    },
  );
}
