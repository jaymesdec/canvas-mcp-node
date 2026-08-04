#!/usr/bin/env node
/**
 * Import the official academic week table from a school iCal feed into a
 * school config's academicCalendar.weeks.
 *
 * Steps:
 *   1. Read the .ics from a local file path or fetch it from a URL
 *   2. Extract VEVENTs whose SUMMARY is exactly "Week N"
 *   3. Map each DTSTART (YYYYMMDD) to { week, start: "YYYY-MM-DD" }, sorted by start
 *   4. Rewrite the config file's academicCalendar.weeks in place (other fields kept)
 *
 * Run yearly when the school publishes the new calendar:
 *   node scripts/import-week-calendar.mjs <ics-file-or-url> [config-path]
 */
import { promises as fs } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const DEFAULT_CONFIG_PATH = "configs/franklin.json";
const WEEK_SUMMARY_PATTERN = /^Week (\d+)$/;

function log(message) {
  process.stdout.write(`[import-week-calendar] ${message}\n`);
}

// RFC 5545 line folding: a line starting with a space or tab continues the previous line.
function unfoldIcsLines(icsText) {
  return icsText
    .replace(/\r\n/g, "\n")
    .replace(/\n[ \t]/g, "")
    .split("\n");
}

export function parseWeekEventsFromIcs(icsText) {
  const weekEntries = [];
  let inEvent = false;
  let summary = null;
  let dtstart = null;

  for (const line of unfoldIcsLines(icsText)) {
    if (line === "BEGIN:VEVENT") {
      inEvent = true;
      summary = null;
      dtstart = null;
      continue;
    }
    if (line === "END:VEVENT") {
      inEvent = false;
      const summaryMatch = summary?.match(WEEK_SUMMARY_PATTERN);
      const dateMatch = dtstart?.match(/^(\d{4})(\d{2})(\d{2})/);
      if (summaryMatch && dateMatch) {
        weekEntries.push({
          week: Number(summaryMatch[1]),
          start: `${dateMatch[1]}-${dateMatch[2]}-${dateMatch[3]}`,
        });
      }
      continue;
    }
    if (!inEvent) continue;
    if (line.startsWith("SUMMARY:")) summary = line.slice("SUMMARY:".length).trim();
    // DTSTART may carry params, e.g. DTSTART;VALUE=DATE:20260824
    if (line.startsWith("DTSTART")) dtstart = line.slice(line.indexOf(":") + 1).trim();
  }

  weekEntries.sort((a, b) => a.start.localeCompare(b.start));
  return weekEntries;
}

async function readIcsSource(source) {
  if (/^https?:\/\//.test(source)) {
    log(`fetching ${source}`);
    const response = await fetch(source);
    if (!response.ok) {
      throw new Error(`fetch failed: ${response.status} ${response.statusText}`);
    }
    return response.text();
  }
  log(`reading ${source}`);
  return fs.readFile(path.resolve(source), "utf8");
}

async function updateConfigWeeks(configPath, weekEntries) {
  const resolved = path.resolve(configPath);
  const config = JSON.parse(await fs.readFile(resolved, "utf8"));
  config.academicCalendar = { ...(config.academicCalendar ?? {}), weeks: weekEntries };
  await fs.writeFile(resolved, `${JSON.stringify(config, null, 2)}\n`);
  return resolved;
}

async function main() {
  const [source, configPath = DEFAULT_CONFIG_PATH] = process.argv.slice(2);
  if (!source) {
    process.stderr.write(
      "Usage: node scripts/import-week-calendar.mjs <ics-file-or-url> [config-path]\n",
    );
    process.exit(1);
  }

  const icsText = await readIcsSource(source);
  const weekEntries = parseWeekEventsFromIcs(icsText);
  if (weekEntries.length === 0) {
    throw new Error('no VEVENTs with SUMMARY matching "Week N" found in the feed');
  }

  const written = await updateConfigWeeks(configPath, weekEntries);

  log(`imported ${weekEntries.length} weeks into ${written}`);
  log("");
  log("  week  starts");
  log("  ----  ----------");
  for (const entry of weekEntries) {
    log(`  ${String(entry.week).padStart(4)}  ${entry.start}`);
  }
  log("");
  log("Review the diff, then rebuild/reinstall the .mcpb so the bundle picks it up.");
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(
      `[import-week-calendar] ERROR: ${error?.stack ?? error?.message ?? error}\n`,
    );
    process.exit(1);
  });
}
