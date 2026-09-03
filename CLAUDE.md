# CLAUDE.md — canvas-mcp-node

Project-specific guidance for Claude Code (claude.ai/code) working in this repository. See the parent `Documents/CLAUDE.md` for cross-project conventions (Franklin School context, FERPA, no-auto-publish rule, course-code preference).

## What this project is

Node + TypeScript MCP server for Canvas LMS. Replaces the Python `canvas-mcp-fork` for the 30 Canvas tools the `teaching-AIssitant/` skills use. **Generic by default, Franklin via config** — anything school-specific lives in `configs/*.json` and is loaded via `SCHOOL_CONFIG`.

## Core invariants (do not violate)

1. **FERPA gate.** Every tool that could return real student names anonymizes by default. `anonymous: false` from a caller is **silently overridden** to `true` unless `CANVAS_MCP_ALLOW_DEANONYMIZE=true` is set in the server env. See `src/featureFlags.ts` and `src/tools/users.ts`, `src/tools/assignments.ts`, `src/tools/submissions.ts`, `src/tools/anonymization.ts` for the canonical pattern. Response trimming always consumes the anonymizer's output, never the raw payload (anonymize first, trim second).
2. **No auto-publish.** `create_page`, `create_quiz`, `create_assignment`, and `create_discussion` force `published: false`. Teachers publish after review. Announcements cannot be drafts — `create_announcement` requires a teacher-confirmed future `delayed_post_at` (≥30 min) instead. This is a cross-project rule (parent `CLAUDE.md`) and applies regardless of school config.
3. **Course-code preferred over numeric id** in user-facing output where both are available.
4. **Grading writes resolve with `bypassCache` at least once per invocation.** `resolveCourseId(..., { bypassCache: true })` — a course rename mid-session must never silently misroute a write. Single-submission tools re-resolve every call; `bulk_grade_submissions` resolves once and reuses the numeric id for the whole batch.
5. **`snake_case` for every tool name and zod schema parameter key.** Matches the Python MCP signatures so the user's existing skills don't need parameter renames. Internal TypeScript variables stay camelCase per TS convention.
6. **The lifted `src/code_api/` is verbatim from `canvas-mcp-fork`.** Don't modify locally except for narrow, documented TS-strict fixes. Bug fixes flow upstream first, then re-lift.

## Generic core vs. school-specific data

The MCP core is generic. The only acceptable boundary for school-specific data is `src/schoolConfig.ts` and the `configs/*.json` files it loads. When tempted to add a Franklin-specific default in `src/`:

- If it's federal law (FERPA), Canvas API convention, or a sensible default for any school — it's generic. Keep it in core.
- If only Franklin (or a specific school) would set it — extend `SchoolConfigSchema`, update `configs/franklin.json` AND `configs/example.json`, add tests for both the configured and unconfigured paths.

What's currently in the school config: `competencyFramework`, `pageTemplates`, `academicCalendar` (reserved).

What's NOT (and must stay generic): FERPA defaults, `CANVAS_MCP_ALLOW_DEANONYMIZE`, course-code preference, `published: false`, course-code cache, pagination/retry/error handling.

## Code structure

```
src/
├── index.ts                # entry: loads env + schoolConfig, wires register*Tools
├── canvasClient.ts         # axios-backed; retries, pagination, course-code cache
├── anonymizer.ts           # persistent per-course JSON map (the FERPA gate's store)
├── featureFlags.ts         # isDeanonymizationAllowed() — operator env gate
├── schoolConfig.ts         # zod-validated SCHOOL_CONFIG loader
├── types.ts                # CanvasApiError, CanvasUserLite, AnonMapFile
├── tools/                  # one file per domain; each exports register*Tools(server, ...)
│   ├── toolHelpers.ts      # jsonResult/textResult/errorResult/safeHandler/pickFields
│   ├── roster.ts           # course roster fetch + staff-id classification (shared FERPA helper)
│   ├── courses.ts          # list_courses, get_course_details, list_account_courses
│   ├── modules.ts          # list_modules, create_module, update_module, update_module_item, delete_module, add_module_item, delete_module_item
│   ├── assignments.ts      # list_assignments, create_assignment, update_assignment, get_assignment_details, get_assignment_rubric_details
│   ├── rubrics.ts          # list_all_rubrics, get_rubric_details, create_rubric, create_rubric_association
│   ├── users.ts            # list_users, list_user_enrollments, list_account_users
│   ├── pages.ts            # list_pages, get_page_content, create_page, edit_page_content, delete_page, list_page_templates
│   ├── quizzes.ts          # New Quizzes (/api/quiz/v1): create_quiz, create_quiz_question, list_quizzes, get_quiz, update_quiz, update_quiz_question, delete_quiz_question (friendly payload → NQ item schema translated in buildItemEntry)
│   ├── submissions.ts      # list_submissions, get_submission_rubric_assessment, download_submission_attachment
│   ├── discussionAnonymizer.ts # entry-author pseudonymization + roster-name body scrub (best-effort)
│   ├── discussions.ts      # list_discussions, get_discussion, create_discussion, update_discussion, delete_discussion, list_announcements, create_announcement, update_announcement, delete_announcement
│   ├── grading.ts          # grade_submission, grade_with_rubric, grade_submission_with_rubric, bulk_grade_submissions
│   ├── anonymization.ts    # create_student_anonymization_map, get_anonymization_status
│   ├── competencies.ts     # list_competencies (school-config-driven)
│   ├── school.ts           # get_school_info (school-config-driven)
│   └── code_exec.ts        # execute_typescript, list_code_api_modules
├── workers/
│   ├── ts_exec_worker.ts   # worker thread entry for execute_typescript
│   └── network_guard.ts    # default-on outbound network sandbox
└── code_api/               # LIFTED from canvas-mcp-fork — do not modify
    ├── client.ts           # canvas REST helpers (fetch-based) for user code
    ├── anonymizer.ts       # FERPA-safe adapter; binds to the same on-disk map
    └── canvas/
        ├── assignments/    # listSubmissions
        ├── courses/        # listCourses, getCourseDetails
        └── grading/        # gradeWithRubric, bulkGrade
```

## Documented solutions

`docs/solutions/` — documented solutions to past problems (bugs, best practices, workflow patterns), organized by category with YAML frontmatter (`module`, `tags`, `problem_type`). Relevant when implementing or debugging in documented areas.

## Conventions

- **Tool registration.** Each domain exports `register*Tools(server, canvas?, anonymizer?)`. `src/index.ts` instantiates dependencies once at startup and passes them in. Don't reach into module globals for state.
- **Tool handlers.** Wrap the body in `safeHandler("<tool_name>", async () => ...)` so any thrown error becomes a structured tool error result instead of an MCP protocol exception. Use `jsonResult(...)` for structured payloads and `textResult(...)` for plain text.
- **Tests.** Vitest. Tool tests use `buildMockCanvas` + `buildToolHarness` from `tests/_helpers/mockCanvas.ts`. Real-worker tests for `execute_typescript` live in `tests/tools/code_exec.test.ts` — they're slow (worker spawn ~1s each) but real.
- **De-anonymization gate.** Whenever you add a tool that could return real student names, plumb `args.anonymous` through `resolveAnonymous(...)` (or the inline equivalent) so the env gate fires before any data leaves the server. Add a `warnings[]` entry to the structured content when overridden.
- **Write paths bypass the course-code cache.** Pass `{ bypassCache: true }` to `canvas.resolveCourseId(...)` on any write (grading, page creation, module item add, etc.).
- **No comments narrating what the code does.** Identifiers do that. Comments are for `WHY` — hidden constraints, surprising defaults, or specific bugs being worked around.

## Build / test / package

```bash
npm run build              # tsc → dist/
npm test                   # vitest
npm run validate:manifest  # check manifest.json against the latest MCPB schema
npm run build:mcpb         # build the .mcpb installer (gitignored; distribute via GitHub Releases)
```

The `.mcpb` is **gitignored**. Distribution path is **GitHub Releases** — see README's "Distributing via GitHub Releases".

## When you add a new tool

1. Pick the domain (or create a new file in `src/tools/` if no existing fit).
2. Snake-case the tool name AND every zod schema parameter key. Match the Python MCP signature exactly if one exists.
3. Wrap the handler in `safeHandler(...)`. Return structured JSON via `jsonResult(...)` and include a `summary` for the text content.
4. If the tool could return student data: route through the `Anonymizer`, plumb `anonymous` through the env gate, add a `warnings[]` entry on override.
5. If the tool is a write: bypass the course-code cache.
6. If the tool is account-scoped: default `account_id` from `CANVAS_ACCOUNT_ID` via `resolveAccountId(...)` and surface a "requires account-admin scope" error on 401/403.
7. Write tests using `buildMockCanvas` + `buildToolHarness`. Cover at least: happy path, error path, and (if applicable) the FERPA-gate-override path.
8. Register in `src/index.ts`.
9. Update `README.md` → "Tool reference" with one row.
10. If a teacher-facing skill in `teaching-AIssitant/` needs to learn about the tool, add a note to `docs/MIGRATION.md`.
