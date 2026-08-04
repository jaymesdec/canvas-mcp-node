# Canvas MCP — Technical reference

Full tool catalog, security model, troubleshooting, and architecture notes. For the teacher-facing README, see [`../README.md`](../README.md). For the school configuration guide, see [`SCHOOL_CONFIG.md`](SCHOOL_CONFIG.md).

---

## Tool reference

All tools register under the `mcp__canvas-mcp__*` prefix in Claude Desktop. Parameter names are `snake_case` (matching the Python MCP and Canvas API conventions). Full zod schemas live in `src/tools/<domain>.ts`.

Every tool result is a single compact-JSON text block (plus a one-line summary) — there is no separate `structuredContent` representation, so payloads aren't duplicated into the model's context. List tools return trimmed rows by default; the corresponding `get_*` tool is the full-fidelity escape hatch.

Course identifiers resolve by **unique exact match** (case-insensitive, course code first, then name). An ambiguous identifier errors with a candidate list — pass the numeric id to disambiguate — instead of silently guessing a course.

### Courses

| Tool | Purpose |
|---|---|
| `list_courses(enrollment_state?, include?)` | List courses the token-owner is enrolled in. |
| `get_course_details(course_identifier, include?)` | Fetch a single course by code or numeric id. |
| `list_account_courses(account_id?, search_term?, enrollment_term_id?, state?, published?, with_enrollments?, include?)` | Search the full account catalog. **Requires account-admin scope.** Defaults `account_id` from `CANVAS_ACCOUNT_ID` env. |

### Users

| Tool | Purpose |
|---|---|
| `list_users(course_identifier, enrollment_type?, include_email?, anonymous?, search_term?)` | List users in a course. Anonymized by default. |
| `list_user_enrollments(user_id, state?)` | Every enrollment for one user, across courses. |
| `list_account_users(account_id?, search_term?, enrollment_type?, anonymous?)` | Account-wide user search. **Requires account-admin scope.** Anonymized by default. |

### Anonymization (FERPA management)

| Tool | Purpose |
|---|---|
| `create_student_anonymization_map(course_identifier, include_email?)` | Fetch a course roster and persist the pseudonym map. Idempotent — only new students get fresh pseudonyms. Real names appear in the response **only** when `CANVAS_MCP_ALLOW_DEANONYMIZE=true`. |
| `get_anonymization_status()` | List every per-course map file on disk with entry counts and timestamps. |

### Modules

| Tool | Purpose |
|---|---|
| `list_modules(course_identifier, include_items?)` | List modules; optionally inline items. |
| `create_module(course_identifier, name, position?, prerequisite_module_ids?, require_sequential_progress?, unlock_at?)` | Create a new Canvas module. Always **unpublished** at creation (Canvas's default). |
| `update_module(course_identifier, module_id, name?, position?, prerequisite_module_ids?, require_sequential_progress?, unlock_at?)` | Update module settings. Only provided fields are sent; never touches publish state. |
| `update_module_item(course_identifier, module_id, item_id, title?, position?, indent?, new_tab?)` | Update one module item. Only provided fields are sent; deliberately no `published` parameter (a module item's published flag controls student visibility). |
| `delete_module(course_identifier, module_id)` | Permanently delete a module. Removes the module structure only — pages/assignments inside remain in the course. |
| `add_module_item(course_identifier, module_id, type, title, content_id?, position?)` | Add Page/Assignment/Quiz/Discussion/ExternalUrl/SubHeader to a module. `content_id` routes to `page_url`/`external_url`/`content_id` based on type. |
| `delete_module_item(course_identifier, module_id, item_id)` | Remove one item from a module. The underlying page/assignment/quiz remains in the course. |

### Pages

| Tool | Purpose |
|---|---|
| `list_pages(course_identifier)` | Slug, title, published flag, updated_at. |
| `get_page_content(course_identifier, page_url)` | Full HTML body + metadata. |
| `create_page(course_identifier, title, body, editing_roles?, template?)` | Create a wiki page. **`published: false` forced.** Body is wrapped in the school's `default` page template if configured; pass `template: 'lesson'` / `'assessment'` / `'none'` to override. See [Page templates](SCHOOL_CONFIG.md#page-templates). |
| `edit_page_content(course_identifier, page_url, title?, body?, slots?, editing_roles?, template?, include_sections?, omit_sections?)` | Update an existing page. Two modes: pass just `title`/`body`/`editing_roles` for a simple field update, OR pass `template`/`slots`/`include_sections`/`omit_sections` to rebuild the body via the template machinery (same as `create_page`). The right tool for any change to an existing page — using `create_page` for an existing title creates a duplicate. |
| `delete_page(course_identifier, page_url)` | Permanently delete a Canvas wiki page. Bypasses the course-code cache to avoid misroutes. |
| `list_page_templates()` | List the named page templates configured in the school config (names + descriptions only, not full HTML). |

### Quizzes

| Tool | Purpose |
|---|---|
| `create_quiz(course_identifier, title, description?, quiz_type?, due_at?, points_possible?, shuffle_answers?, allowed_attempts?)` | Create a quiz. **`published: false` forced.** |
| `create_quiz_question(course_identifier, quiz_id, question)` | Add a question. `question.question_type` is zod-validated. |
| `list_quizzes(course_identifier)` | List classic quizzes (id, title, quiz_type, published, due_at, points_possible, question_count). New Quizzes live on a separate API and won't appear here. |
| `get_quiz(course_identifier, quiz_id)` | Quiz settings (list fields plus description, shuffle_answers, allowed_attempts, time_limit, one_question_at_a_time, hide_results, scoring_policy, access_code, unlock_at, lock_at) plus its questions (trimmed to id, position, name, type, points, text, answers). |
| `update_quiz(course_identifier, quiz_id, title?, description?, quiz_type?, due_at?, points_possible?, shuffle_answers?, allowed_attempts?)` | Update quiz settings. Never touches published state. |
| `update_quiz_question(course_identifier, quiz_id, question_id, question)` | Replace a question's content (same payload shape as `create_quiz_question`). Edits on quizzes with submissions create a new quiz version. |
| `delete_quiz_question(course_identifier, quiz_id, question_id)` | Delete a question from a quiz. Same versioning caveat as `update_quiz_question`. |

### Assignments

| Tool | Purpose |
|---|---|
| `list_assignments(course_identifier, student_id?, include?, include_description?, published_only?, anonymous?)` | List assignments, trimmed to scheduling/grading fields by default — pass `include_description: true` for HTML descriptions, `published_only: true` to filter to published. Anonymization-aware when `include[]` contains `submission` or `submission_history`. |
| `create_assignment(course_identifier, name, description?, due_at?, unlock_at?, lock_at?, points_possible?, submission_types?, template?, final_asmt?, fair_asmt?, slots?, include_sections?, omit_sections?)` | Create an assignment. **`published: false` forced.** Description is wrapped in the school's `default` page template automatically; `template: 'assessment'` (etc.) picks a named template, `'none'` skips wrapping — same slot/section machinery as `create_page`. No description/slots → no description sent at all. **`template: 'assessment'` requires `final_asmt` (counts toward the final grade) and `fair_asmt` (published to the parent-facing continuous reporting tool)** — the model asks the teacher, never assumes; the response carries `suggested_title_flags` plus warnings when the name's FAIR/FINAL/ASMT tags don't match. |
| `update_assignment(course_identifier, assignment_id, name?, description?, due_at?, unlock_at?, lock_at?, points_possible?, submission_types?, template?, final_asmt?, fair_asmt?, slots?, include_sections?, omit_sections?)` | Update assignment fields. Simple mode sends `description` verbatim; passing `template`/`slots`/`include_sections`/`omit_sections` rebuilds the description from the school template (pass ALL slots you want in the result). Re-applying `template: 'assessment'` requires `final_asmt`/`fair_asmt` (same ask-the-teacher rule and title-tag warnings as `create_assignment`). Never touches published state; warns when Canvas silently ignores a `submission_types` change (happens once students have submitted). |
| `get_assignment_details(course_identifier, assignment_id)` | Full assignment metadata. |
| `get_assignment_rubric_details(course_identifier, assignment_id)` | Just the rubric, with a structured `{rubric:null,message}` fallback when no rubric is attached. |

### Rubrics

| Tool | Purpose |
|---|---|
| `list_all_rubrics(course_identifier, include_criteria?)` | Per-course only (matches the Python MCP signature). |
| `get_rubric_details(course_identifier, rubric_id)` | Full criterion + rating descriptors. |
| `create_rubric(course_identifier, title, criteria, free_form_criterion_comments?, associate_with?)` | Create a new rubric with criteria + ratings. Optionally attach it to an Assignment/Quiz/Discussion in the same API call via `associate_with`. Bypasses the course-code cache. |
| `create_rubric_association(course_identifier, rubric_id, association_type, association_id, use_for_grading?, hide_score_total?)` | Attach an existing rubric to a different Assignment/Quiz/Discussion. Use for reusing a rubric across multiple assessments. Bypasses the course-code cache. |

### Discussions & announcements

Announcements are Canvas discussion topics under the hood, but they **cannot be drafts** — so instead of the `published: false` rule, `create_announcement` requires a teacher-confirmed future `delayed_post_at` (default floor: 30 minutes out; `CANVAS_MCP_MIN_ANNOUNCEMENT_DELAY_MINUTES` overrides, clamped to ≥5). Missing, past, near, or offset-less timestamps are rejected before any Canvas call.

| Tool | Purpose |
|---|---|
| `list_discussions(course_identifier)` | List discussion topics (announcements excluded), trimmed to id/title/published/posted_at/discussion_type/locked/pinned/delayed_post_at/reply_count. |
| `get_discussion(course_identifier, topic_id, include_entries?, anonymous?)` | One topic plus (by default) its entries. Student entry authors are pseudonymized and roster names scrubbed from message bodies by default (best-effort scrub — FERPA gate). |
| `create_discussion(course_identifier, title, message, discussion_type?, delayed_post_at?)` | Create a discussion topic. **`published: false` forced.** |
| `update_discussion(course_identifier, topic_id, title?, message?, discussion_type?, delayed_post_at?, published?)` | Update a topic. Refuses announcements (use `update_announcement`); `published` accepts only `false` (revert to draft). |
| `list_announcements(course_identifier)` | List announcements without the ±14-day window of the announcements API, so scheduled (`post_delayed`) items appear with their `delayed_post_at`. |
| `create_announcement(course_identifier, title, message, delayed_post_at)` | Create a **scheduled** announcement. `delayed_post_at` is required: ISO-8601 with explicit offset or `Z`, at least the delay floor in the future. If Canvas reports it went live immediately anyway, the tool deletes it best-effort and errors loudly. |
| `update_announcement(course_identifier, topic_id, title?, message?, delayed_post_at?)` | Update an announcement. A new `delayed_post_at` obeys the same offset + floor rules; null/empty is rejected (Canvas clears the delay on empty → immediate post). Edits after the post time are live edits. |
| `delete_discussion(course_identifier, topic_id)` | Permanently delete a discussion topic and its entries. Refuses announcements (use `delete_announcement`). Bypasses the course-code cache. |
| `delete_announcement(course_identifier, topic_id)` | Permanently delete an announcement — before the post time (cancels the schedule) or after (removes the live announcement). Refuses plain discussions (use `delete_discussion`). Bypasses the course-code cache. |

### Submissions (read)

| Tool | Purpose |
|---|---|
| `list_submissions(course_identifier, assignment_id, include_rubric_assessment?, include_submission_comments?, anonymous?)` | List submissions for an assignment, trimmed to grading-relevant fields (id, user_id, workflow_state, submitted_at, late, missing, grade, score, attempt, user, attachments, rubric_assessment, submission_comments with `author_id`). Anonymized by default — including comment authors, unless they're course staff. |
| `get_submission_rubric_assessment(course_identifier, assignment_id, user_id)` | Rubric assessment block with criterion descriptions joined for readability. |
| `download_submission_attachment(course_identifier, assignment_id, user_id, attachment_id?, target_dir?)` | Stream attachments to disk. Defaults `target_dir` to `./submissions/{courseCode|courseId}/{assignmentId}/`. |

### Grading (write)

All grading tools bypass the course-code cache (re-resolve every call) so a course rename can't misroute a write. Canvas endpoint is the same; the tools differ only in schema shape.

| Tool | Purpose |
|---|---|
| `grade_submission(course_identifier, assignment_id, user_id, posted_grade, comment?)` | Just a posted_grade. |
| `grade_with_rubric(course_identifier, assignment_id, user_id, rubric_assessment, comment?)` | Rubric only (no posted_grade override). |
| `grade_submission_with_rubric(course_identifier, assignment_id, user_id, posted_grade?, rubric_assessment?, comment?)` | Combined — the kitchen sink. |
| `bulk_grade_submissions(course_identifier, assignment_id, grades, dry_run?, max_concurrent?, rate_limit_delay?)` | Bulk grade keyed by `user_id`. **Always start with `dry_run: true` on a real course.** Pre-checks the submissions list and lands users without submissions in `skipped_results`. Bounded concurrency, 429-aware (aborts the next batch and reports `unprocessed_user_ids` honestly). |

### Code execution

| Tool | Purpose |
|---|---|
| `execute_typescript(code, timeout_seconds?, memory_mb?)` | Run TypeScript in an isolated worker thread. User code can import from `code_api/` — including `./anonymizer.js` for FERPA-safe transforms. Network blocked by default to non-Canvas hosts. Crashes/loops/OOM stay isolated; the MCP keeps serving. |
| `list_code_api_modules()` | What's importable from inside `execute_typescript`. |

### School-driven

| Tool | Purpose |
|---|---|
| `list_competencies()` | Returns the competency framework from `SCHOOL_CONFIG`. Structured "not configured" response when no preset is loaded — tells the caller what env var to set. |

---

## Anonymization (FERPA gate)

Every tool that could return real student names defaults to pseudonymized output (`Student 1`, `Student 2`, …). Teachers/TAs/admins are returned verbatim — the gate only fires for students and unknown-role users.

**The default is enforced server-side.** If a caller passes `anonymous: false`, the server **ignores it** and returns anonymized output anyway, with a warning string in the response. The only way to actually receive real names is to set the operator-controlled env var `CANVAS_MCP_ALLOW_DEANONYMIZE=true` in your launch config and restart Claude Desktop.

This applies to:

- `list_users`
- `list_account_users`
- `list_assignments` (when `include[]` contains `submission` or `submission_history`)
- `list_submissions` (including submission-comment authors — course staff keep real attribution, everyone else is pseudonymized)
- `get_discussion` (entry authors pseudonymized; roster names scrubbed from topic/entry bodies best-effort)
- `create_student_anonymization_map` (suppresses `real_name` / `real_email` in the response; pseudonyms are still allocated and persisted to disk)

Trimming always runs on the anonymizer's output, never the raw Canvas payload — a trimmed response can't leak a field the anonymizer would have rewritten.

Pseudonyms persist per-course on disk at `~/.canvas-mcp/anon-maps/{courseId}.json` (override the directory via `ANON_MAP_DIR`). The same student receives the same `Student N` across MCP restarts and weeks of conversations.

### Anonymization map durability

The pseudonym map is the only persistent state this MCP holds. Lose it and every `Student N` reference in past artifacts orphans permanently — there's no way to recover the binding from a Canvas user_id back to the assigned pseudonym.

**Recommendation:** point `ANON_MAP_DIR` at a synced folder (iCloud Drive, Dropbox, OneDrive, a managed Google Drive mount, an internal NAS). For Franklin teachers using the .mcpb installer, set the **Anonymization map directory** override (via `claude_desktop_config.json` env block) to e.g. `~/Library/Mobile Documents/com~apple~CloudDocs/canvas-mcp-anon-maps/`.

---

## Account-scoped tools

For admin workflows that need to look beyond the token-owner's own enrollments:

- `list_account_courses(account_id?, search_term?, state?, ...)` — search the full course catalog
- `list_account_users(account_id?, search_term?, enrollment_type?, ...)` — search every user in the account

Both default `account_id` from the `CANVAS_ACCOUNT_ID` env var. By default the .mcpb installer hardcodes this to `self`, which works for admins. A clean "requires account-admin scope" error surfaces if the token is missing the permission.

Non-admin teachers will see the structured error from these two tools and fall back to course-scoped tools (`list_courses`, `list_users` per course). The other 55 tools all work normally; the two account-scoped tools are the only ones that need admin.

---

## execute_typescript

For token-efficient bulk operations — grading 90 submissions at once, scanning every rubric across a course, generating per-student narratives — running the loop *inside* the MCP server (rather than streaming all data into Claude's context) saves enormous amounts of token throughput. `execute_typescript` is that escape hatch.

User code runs in a `node:worker_threads` Worker:

- **Terminable timeout.** Default 120s, max 600s. On timeout, `worker.terminate()` reclaims the thread and the MCP keeps serving other tools.
- **Memory cap.** `resourceLimits.maxOldGenerationSizeMb` (default 512 MB). Worker is OOM-killed by Node; the main thread is unaffected. Caveat: `Buffer`/`ArrayBuffer` use external memory and are NOT bounded by this — only the timeout protects against those.
- **Crashes stay isolated.** A `process.exit()`, infinite loop, or OOM in user code doesn't restart Claude Desktop. The next tool call works immediately.
- **Network guard ON by default.** Patches `net.connect`, `tls.connect`, `http.request`/`get`, `https.request`/`get`, and `globalThis.fetch`. Only the Canvas host (parsed from `CANVAS_API_URL`) is allowed by default.
- **Token scrubbing.** Before posting back, the literal `CANVAS_API_TOKEN` value is substring-replaced with `***REDACTED***` in stdout/stderr/error.message/stack — so a leaking trace can't surface the credential into Claude's tool-result context.

### What user code can import

Discover the catalog with `list_code_api_modules`. Today:

```ts
// FERPA-safe — same pseudonyms list_users/list_submissions produce
import { anonymizeUsers, anonymizeSubmissions, classifyRole } from "./anonymizer.js";

// Canvas read/write helpers (form-encoded grading included)
import { listCourses, getCourseDetails } from "./canvas/courses/index.js";
import { listSubmissions } from "./canvas/assignments/listSubmissions.js";
import { gradeWithRubric, bulkGrade } from "./canvas/grading/index.js";

// Lower-level HTTP if you need it
import { canvasGet, canvasPost, canvasPutForm, fetchAllPaginated } from "./client.js";
```

### Use ./anonymizer.js for any student-facing transformation

When user code processes student data, route it through `./anonymizer.js`:

```ts
import { listSubmissions } from "./canvas/assignments/listSubmissions.js";
import { anonymizeSubmissions } from "./anonymizer.js";

const submissions = await listSubmissions({ courseIdentifier: "60366", assignmentId: "123" });
const anonymized = await anonymizeSubmissions(60366, submissions);
// anonymized has the same Student N pseudonyms list_submissions would have returned
```

The on-disk map is shared between the worker and the main thread, so pseudonyms stay consistent across both paths.

---

## Security

### Canvas API token

The token is the most sensitive piece of state in the system. It carries full account-admin access (assuming you generated it as an admin); leaking it lets an attacker grade, message, modify courses, and pull every student record.

- **Stored locally only.** `.env` and the .mcpb installer's prompt both keep the token on disk where Claude Desktop is running — it's never sent anywhere except your Canvas host.
- **Rotate periodically.** Canvas → Account → Settings → expire the old token, generate a new one, update your `.env` or re-run the .mcpb install dialog. Treat it like any other admin password.
- **Token scrubbing in execute_typescript.** Worker output (stdout/stderr/error/stack) has the literal token value substring-replaced with `***REDACTED***` before being posted back. Defends against prompt-injection-induced credential exfiltration through a deliberately leaking stack trace.

### Network egress (execute_typescript)

`execute_typescript` runs LLM-authored code with an account-admin Canvas token in scope. The default-on network guard means user code can only reach the Canvas host you configured, even if it's instructed otherwise (e.g., by prompt-injected content inside a student submission).

The guard is **best-effort**, not a strong sandbox — a determined attacker controlling the user-code source can find ways around any in-process monkey-patch. It raises the cost of accidental exfiltration; it does not stop a knowledgeable attacker. Documented at the top of `src/workers/network_guard.ts`.

### FERPA / student data

Pseudonymization is the primary defense. Real names never reach Claude's context window unless the operator has explicitly set `CANVAS_MCP_ALLOW_DEANONYMIZE=true` (and restarted). Even when Claude is asked to "show real names," the server returns pseudonyms anyway and surfaces a warning. See [Anonymization](#anonymization-ferpa-gate) above.

---

## Troubleshooting

### "Missing required environment variable: CANVAS_API_URL"

The MCP exits at startup if `CANVAS_API_URL` or `CANVAS_API_TOKEN` is unset. In Claude Desktop, the entry under `mcpServers` needs an `env` block (or the .mcpb installer prompts you on install).

### "list_account_courses requires account-admin scope"

Your token doesn't have admin permission on the account. Either generate an admin token, or stop using account-scoped tools (everything else works without admin).

### Pseudonyms drift between sessions

You're running `list_users` (or similar) without first calling `create_student_anonymization_map` for that course. The lazy-allocation path assigns pseudonyms in whatever order Canvas returns users — which can shift between calls.

**Fix:** call `create_student_anonymization_map` once per course, before any longitudinal workflow. That seeds the file with stable pseudonyms in roster order, and every subsequent call returns the same `Student N` for the same Canvas user_id.

### "SANDBOX_NETWORK_BLOCKED" in execute_typescript

User code tried to reach a host outside the allowlist. Either:
- The workflow legitimately needs the host — add it to `TS_SANDBOX_ALLOWLIST_HOSTS` (comma-separated) and restart.
- The workflow shouldn't be reaching that host — investigate. Common cause: a library tries to phone home on startup.

### Worker spawn fails with "Cannot find package 'tsx'"

A bug fixed in v0.3.10 — Claude Desktop was launching the MCP from CWD=`/` and the worker couldn't resolve `tsx/esm` via Node's default lookup. Upgrade to v0.3.10 or later.

### "no Canvas course matches ..." / "exactly matches N courses"

Course-code resolution failed. The MCP's `resolveCourseId` resolves a non-numeric identifier only on a **unique exact match** (case-insensitive) against your enrolled courses — course code first, then course name. No match: usually a typo, or a course you're not enrolled in (try `list_account_courses` if admin, then pass the numeric id). Multiple exact matches (e.g., a cross-term duplicate code): the error lists the candidates with their numeric ids — pass the id to disambiguate. The MCP never fuzzy-guesses a course.

### "add_module_item: missing page_url parameter" (or similar)

A bug fixed in v0.3.10 — Canvas requires `module_item[page_url]` for Page items (not `module_item[content_id]`). The tool now routes the unified `content_id` argument to the right Canvas field based on `type`. Upgrade to v0.3.10 or later.

---

## Architecture notes

- **Single CanvasClient** (`src/canvasClient.ts`) — axios-backed, handles 429+Retry-After backoff, Canvas Link-header pagination, in-process course-code → id cache (bypassed on writes so renames can't misroute).
- **Persistent Anonymizer** (`src/anonymizer.ts`) — per-course JSON map at `${ANON_MAP_DIR}/{courseId}.json`. Atomic same-dir tmp+rename writes with `0o600`/`0o700` modes. Per-course async mutex prevents double-allocation under concurrent calls.
- **Lifted `code_api/`** (`src/code_api/`) — copied verbatim from the Python `canvas-mcp-fork` so `execute_typescript` can import the same modules the upstream MCP supports. **Do not modify locally** — fixes flow upstream first, then re-lift.
- **School config** (`src/schoolConfig.ts`) — single boundary between generic core and Franklin-specific data. Other schools point `SCHOOL_CONFIG` at their own JSON.
- **`snake_case` everywhere** — tool names AND zod schema parameter names. Matches the Python MCP signatures exactly so existing `teaching-AIssitant/` skills don't need parameter renames (only the items in [`MIGRATION.md`](MIGRATION.md)).

For the contributor checklist (adding a new tool, conventions, do-not-modify-locally rules), see [`../CLAUDE.md`](../CLAUDE.md).

---

## Developer build / test / release

### Build the .mcpb installer

```bash
npm install
npm run build:mcpb
# → build/mcpb/canvas-mcp-<version>.mcpb
```

The build:

- Compiles TypeScript to `dist/`.
- Stages `dist/` as `server/`, copies `configs/`, runs `npm ci --omit=dev` so only production dependencies ship in `node_modules/`.
- Calls `mcpb pack` to produce a signed-able ZIP at `build/mcpb/canvas-mcp-<version>.mcpb`.

`npm run validate:manifest` validates `manifest.json` against the latest MCPB schema (use this when you edit the manifest).

### Source checkout (dev workflow)

```bash
npm install
cp .env.example .env
# fill in CANVAS_API_URL and CANVAS_API_TOKEN
npm run build
npm start
```

`npm run dev` runs the server under `tsx watch` for iteration.

### Distributing via GitHub Releases

> ⚠️ **The `.mcpb` is gitignored on purpose** — build artifacts don't belong in the repo. Distribute through **GitHub Releases** (attach the file to a tagged release) so the source tree stays clean and the binary is downloadable.

Release workflow for a new version:

1. Bump `version` in `manifest.json` and `package.json` (keep them in sync) and the `SERVER_VERSION` constant in `src/index.ts`.
2. `npm test && npm run validate:manifest && npm run build:mcpb` — locally verify.
3. `git tag v<version> && git push --tags`.
4. On GitHub: Releases → "Draft a new release" → pick the tag → upload `build/mcpb/canvas-mcp-<version>.mcpb` → publish.

For a fully automated release flow, add a GitHub Actions workflow that runs `npm run build:mcpb` on tag push and uploads the artifact (`softprops/action-gh-release` is the usual choice). Skipped here intentionally — start manual, add CI when it's annoying enough.

---

## Plan & history

Original design document: [`plans/2026-05-22-001-feat-canvas-mcp-typescript-port-plan.md`](plans/2026-05-22-001-feat-canvas-mcp-typescript-port-plan.md).

Migration guide for teachers moving from the Python `canvas-mcp-fork`: [`MIGRATION.md`](MIGRATION.md).
