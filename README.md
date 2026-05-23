# canvas-mcp (Node)

Node + TypeScript MCP server for Canvas LMS. Designed for the Franklin School teaching ecosystem and ships with a Franklin preset, but **generic by default** — other schools point `SCHOOL_CONFIG` at their own JSON file and the same binary runs unchanged. 30 tools cover course/module/page/quiz/assignment/rubric reads, single-and-bulk grading, account-scoped admin search, FERPA-aware anonymization, and an `execute_typescript` escape hatch for token-efficient bulk operations.

**Quick facts:**

- **FERPA-first.** Every student-data tool returns pseudonyms by default (`Student 1`, `Student 2`, …); teachers/TAs/admins always returned verbatim. De-anonymization requires an explicit operator env opt-in — Claude cannot bypass it from inside a tool call.
- **Persistent per-course pseudonym map.** Same student → same `Student N` across MCP restarts and weeks of conversations. Stored at `~/.canvas-mcp/anon-maps/{courseId}.json` (configurable).
- **Anonymization-aware `execute_typescript`.** User code imports `./anonymizer.js` from `code_api/` and gets the same pseudonyms the typed tools produce.
- **Generic vs. school-specific split.** Anything that varies by school (competency framework, future page templates) lives in `configs/*.json`. The Franklin preset ships at `configs/franklin.json`; other schools copy `configs/example.json`.

---

## Install — one-click (.mcpb)

The fastest path is the bundled `.mcpb` installer. Claude Desktop opens it and walks the user through every required env var.

### For end-users (you have a .mcpb file)

1. Double-click `canvas-mcp-<version>.mcpb` (or drag it onto Claude Desktop).
2. In the install dialog, fill in:
   - **Canvas API URL** — your Canvas base URL, e.g. `https://franklin.instructure.com` (no `/api/v1`).
   - **Canvas API token** — generated from Canvas → Account → Settings → New Access Token. Stored locally; only ever sent to the Canvas host above.
   - **Canvas account id** — `self` if you have account-admin (most Franklin teachers do); leave blank if you don't. Lets account-scoped tools work without passing the id on every call.
   - **School config JSON** — for Franklin defaults, set to `${__dirname}/configs/franklin.json` (Claude Desktop substitutes the bundle's install path for `${__dirname}`). For another school, copy `configs/example.json` out of the unpacked bundle, edit it, and point this at your edited copy. Leave blank to run with no competency framework.
   - **Anonymization map directory** — leave blank for the default `~/.canvas-mcp/anon-maps/`, or point at a synced folder (iCloud Drive, Dropbox, NAS) if you want pseudonyms to survive machine loss. **This matters** — losing this directory orphans every `Student N` reference in your past narratives, council reviews, and transition reports.
   - **Allow de-anonymized output** — leave `false`. Flip to `true` only for explicit real-name workflows; flip back immediately after. Restart Claude Desktop after changing.
   - **execute_typescript network controls** — leave the defaults. The Canvas host is auto-allowlisted; add others only if a workflow legitimately needs them.
3. Restart Claude Desktop. The tools appear under the `canvas-mcp` prefix.

### Building your own .mcpb

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

### Distributing via GitHub Releases

> ⚠️ **The `.mcpb` is gitignored on purpose** — build artifacts don't belong in the repo. Distribute through **GitHub Releases** (attach the file to a tagged release) so the source tree stays clean and the binary is downloadable.

Release workflow for a new version:

1. Bump `version` in `manifest.json` and `package.json` (keep them in sync) and the `SERVER_VERSION` constant in `src/index.ts`.
2. `npm test && npm run validate:manifest && npm run build:mcpb` — locally verify.
3. `git tag v<version> && git push --tags`.
4. On GitHub: Releases → "Draft a new release" → pick the tag → upload `build/mcpb/canvas-mcp-<version>.mcpb` → publish.
5. Link the release from the README's "Install" section so end-users land on a download URL, not a clone command.

For a fully automated release flow, add a GitHub Actions workflow that runs `npm run build:mcpb` on tag push and uploads the artifact (`softprops/action-gh-release` is the usual choice). Skipped here intentionally — start manual, add CI when it's annoying enough.

## Install — developer (source checkout)

```bash
npm install
cp .env.example .env
# fill in CANVAS_API_URL and CANVAS_API_TOKEN
npm run build
npm start
```

`npm run dev` runs the server under `tsx watch` for iteration.

---

## Tool reference

All tools register under the `mcp__canvas-mcp__*` prefix in Claude Desktop. Parameter names are `snake_case` (matching the Python MCP and Canvas API conventions). Full zod schemas live in each `src/tools/<domain>.ts` file.

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
| `add_module_item(course_identifier, module_id, type, title, content_id?, position?)` | Add Page/Assignment/Quiz/SubHeader to a module. |

### Pages

| Tool | Purpose |
|---|---|
| `list_pages(course_identifier)` | Slug, title, published flag, updated_at. |
| `get_page_content(course_identifier, page_url)` | Full HTML body + metadata. |
| `create_page(course_identifier, title, body, editing_roles?, template?)` | Create a wiki page. **`published: false` forced.** Body is wrapped in the school's `default` page template if configured; pass `template: 'lesson'` / `'assessment'` / `'none'` to override. See "Page templates" below. |
| `edit_page_content(course_identifier, page_url, title?, body?, editing_roles?)` | Update an existing page. Only sends fields you pass. Does NOT re-apply the template. |
| `list_page_templates()` | List the named page templates configured in the school config (names + descriptions only, not full HTML). |

### Quizzes

| Tool | Purpose |
|---|---|
| `create_quiz(course_identifier, title, description?, quiz_type?, due_at?, points_possible?, shuffle_answers?, allowed_attempts?)` | Create a quiz. **`published: false` forced.** |
| `create_quiz_question(course_identifier, quiz_id, question)` | Add a question. `question.question_type` is zod-validated. |

### Assignments

| Tool | Purpose |
|---|---|
| `list_assignments(course_identifier, student_id?, include?, anonymous?)` | List assignments. Anonymization-aware when `include[]` contains `submission` or `submission_history`. |
| `get_assignment_details(course_identifier, assignment_id)` | Full assignment metadata. |
| `get_assignment_rubric_details(course_identifier, assignment_id)` | Just the rubric, with a structured `{rubric:null,message}` fallback when no rubric is attached. |

### Rubrics

| Tool | Purpose |
|---|---|
| `list_all_rubrics(course_identifier, include_criteria?)` | Per-course only (matches the Python MCP signature). |
| `get_rubric_details(course_identifier, rubric_id)` | Full criterion + rating descriptors. |

### Submissions (read)

| Tool | Purpose |
|---|---|
| `list_submissions(course_identifier, assignment_id, include_rubric_assessment?, include_submission_comments?, anonymous?)` | List submissions for an assignment. Anonymized by default. |
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
| `execute_typescript(code, timeout_seconds?, memory_mb?)` | Run TS in an isolated worker_thread. User code can import from `code_api/` — including `./anonymizer.js` for FERPA-safe transforms. Network blocked by default to non-Canvas hosts. Crashes/loops/OOM stay isolated; the MCP keeps serving. |
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
- `list_submissions`
- `create_student_anonymization_map` (suppresses `real_name` / `real_email` in the response; pseudonyms are still allocated and persisted to disk)

Pseudonyms persist per-course on disk at `~/.canvas-mcp/anon-maps/{courseId}.json` (override the directory via `ANON_MAP_DIR`). The same student receives the same `Student N` across MCP restarts and weeks of conversations, which is what makes longitudinal artifacts (narratives, council reviews, transition reports) coherent.

### Anonymization map durability

The pseudonym map is the only persistent state this MCP holds. Lose it and every `Student N` reference in past artifacts orphans permanently — there's no way to recover the binding from a Canvas user_id back to the assigned pseudonym.

**Recommendation:** point `ANON_MAP_DIR` at a synced folder (iCloud Drive, Dropbox, OneDrive, a managed Google Drive mount, an internal NAS). For Franklin teachers using the .mcpb installer, set the **Anonymization map directory** prompt at install time to e.g. `~/Library/Mobile Documents/com~apple~CloudDocs/canvas-mcp-anon-maps/`.

A teacher who ignores both this guidance and the README will lose pseudonym stability on machine loss. The MCP cannot reconstruct the mapping after the fact.

## Account-scoped tools

For admin workflows that need to look beyond the token-owner's own enrollments:

- `list_account_courses(account_id?, search_term?, state?, ...)` — search the full course catalog
- `list_account_users(account_id?, search_term?, enrollment_type?, ...)` — search every user in the account

Both default `account_id` from the `CANVAS_ACCOUNT_ID` env var. Set that to `self` (most common) or a numeric account id in your Claude Desktop config so you don't have to remember it on every call. A clean "requires account-admin scope" error surfaces if the token is missing the permission.

Non-admin teachers can leave `CANVAS_ACCOUNT_ID` unset — Claude will see the structured "account_id is required" error and fall back to course-scoped tools (`list_courses`, `list_users` per course). The 26 course-scoped tools all work normally; the two account-scoped tools are the only ones that need admin.

## School configuration (Franklin and other schools)

The MCP core is **generic** — anything that varies by school lives in a JSON config file that the operator points at via the `SCHOOL_CONFIG` env var. This means the same compiled binary serves Franklin School, another school's deployment, or a no-config "generic" install. There is no Franklin-specific code path; Franklin is just a config preset that happens to ship in-repo.

### What's in the config

Today, the school config drives one tool (`list_competencies`) and reserves space for future Franklin-style extensions (page templates, academic calendar). The shape is validated with zod at startup; a malformed or missing config logs a warning to stderr and the MCP keeps running with generic defaults (the affected tools return a structured "not configured" response that explains how to fix it).

```jsonc
{
  "schoolName": "Franklin School (Jersey City, NJ)",
  "competencyFramework": {
    "name": "Franklin's 9 Transdisciplinary Competencies",
    "description": "Used across narratives, council reviews, transition reports.",
    "competencies": [
      { "key": "collaboration", "name": "Collaboration", "description": "Works productively..." }
      // … one entry per competency
    ]
  },
  "academicCalendar": {
    "weeksPerYear": 35
  }
}
```

### Using the Franklin preset (for Franklin teachers)

The repo ships `configs/franklin.json` with the canonical 9 TD Competencies. To enable it:

1. In your `claude_desktop_config.json` under the `canvas-mcp-node-test` (or whatever you named it) entry, add to the `env` block:
   ```jsonc
   "SCHOOL_CONFIG": "/Users/jdec/Documents/node-mcp-server/configs/franklin.json"
   ```
   Or via the `.mcpb` installer, point the "School config JSON" prompt at `${__dirname}/configs/franklin.json`.
2. Restart Claude Desktop.
3. Verify by asking Claude `list_competencies` — the response should include all 9 with descriptions.

The server logs `[canvas-mcp] loaded school config: Franklin School (Jersey City, NJ)` to stderr on startup when the config loads successfully.

### Spinning up a generic / other-school deployment

Two ways:

**Option A — write your own config:**
1. Copy `configs/example.json` to a path of your choice (e.g., `~/lincoln-high.json`).
2. Edit the `schoolName`, `competencyFramework.name`, and the `competencies` array. Keep the `key` slugs short and stable (other tools may eventually key off them).
3. Point `SCHOOL_CONFIG` at the file in your Claude Desktop config.
4. Restart Claude Desktop.

**Option B — run with no school config at all:**
Don't set `SCHOOL_CONFIG`. `list_competencies` will return a structured `{ configured: false, message: … }` response telling Claude what env var to set, but every other tool works normally. This is the right setup for schools that aren't using a competency framework.

### Adding a school-specific field later

When a new piece of school-specific data emerges (e.g., a Franklin HTML page template that `create_page` should default to), the workflow is:

1. Extend `SchoolConfigSchema` in `src/schoolConfig.ts` with the new field (optional, zod-validated).
2. Update `configs/franklin.json` and `configs/example.json` with the new shape (Franklin gets real values, the example gets a documented placeholder).
3. Read it from `schoolConfig` in the tool that consumes it; fall back to a generic default when the field is absent.
4. Add tests covering both the configured and unconfigured paths.

This keeps the generic-vs-Franklin split clean as the surface grows. Anything in the config is per-school; anything in `src/` outside of `schoolConfig.ts` consumers is generic and shared.

### Page templates

Schools often have a consistent institutional look for Canvas pages — Franklin wraps content in a school header/footer with a banner, school logo, and per-course nav strip; another school might use a different layout. `create_page` automatically wraps the body in a configured template, so every page Claude creates ships with your school's standard look without the teacher having to remember.

Templates are keyed by name in the school config under `pageTemplates`. Each template has:

- **`html`** — the template HTML with substitution tokens
- **`slots`** *(optional)* — named content holes used by multi-content templates like `lesson`
- **`sections`** *(optional)* — optional/conditional accordion sections with default include/omit state

Example: a generic single-content template plus a multi-slot lesson template:

```jsonc
{
  "pageTemplates": {
    "default": {
      "description": "Header-only generic wrap. Applied when no template is specified.",
      "html": "<div class=\"school-page\"><h1>{{title}}</h1>{{body}}</div>"
    },
    "lesson": {
      "description": "Lesson page with intro blocks and accordions.",
      "html": "<header>{{course_name}} — {{title}}</header><section>{{slot:about}}</section>...<!-- SECTION:discussion -->...{{slot:discussion}}...<!-- /SECTION:discussion -->",
      "slots": {
        "about":      { "description": "What students will learn about" },
        "discussion": { "description": "Discussion forum link (only when used)" }
      },
      "sections": {
        "discussion": { "default": "omit", "description": "Discussion accordion. Off by default — pass include_sections to add." }
      }
    }
  }
}
```

**Substitution tokens** (the server fills these in before posting to Canvas):

| Token | Filled with |
|---|---|
| `{{title}}` | The page's title (HTML-escaped) |
| `{{body}}` | The `body` arg to `create_page` (legacy single-slot) |
| `{{slot:NAME}}` | The value at `slots[NAME]` in the call |
| `{{course_name}}` | Canvas `course.name`. Fetched only when the template references this token. (HTML-escaped.) |
| `{{course_id}}` | Numeric course id |
| `{{course_url}}` | `https://<your-canvas-host>/courses/<course_id>` |

**How `create_page` chooses what to wrap:**

```
create_page(body: "<p>Hello</p>")                           // → "default" template
create_page(body: "<p>x</p>", template: "lesson")           // → "lesson" template
create_page(template: "lesson", slots: {about: "...", ...}) // → multi-slot
create_page(body: "<p>x</p>", template: "none")             // → no wrap
```

**Optional sections (the `include_sections` / `omit_sections` mechanism):**

Wrap conditional accordion blocks in `<!-- SECTION:name -->...<!-- /SECTION:name -->` markers. The config declares each section's default state:

- `default: "include"` → section is present unless `omit_sections: ["name"]` is passed
- `default: "omit"` → section is absent unless `include_sections: ["name"]` is passed

Section markers are stripped from the final HTML; their content is either kept (included) or removed (omitted). Section names that appear in `include_sections` / `omit_sections` but aren't declared in the config are silently ignored.

**Where the work happens (token-cost note):** template substitution runs **inside the MCP server**, not in Claude's context. The template HTML never enters the conversation — Claude passes slots + flags, the server wraps everything, posts to Canvas. This keeps token cost flat regardless of how large the template is. Symmetrically, `create_page` strips the body from its response (returning URL, slug, metadata, `template_applied`, `included_sections`, `omitted_sections`) so a freshly-wrapped page doesn't burn tokens on the way back.

**Discovering what's available:** `list_page_templates` returns the configured templates with their slot names + descriptions and section names + defaults + descriptions. (Never the full HTML.) Skills call it to know what slots to fill and which sections might need to be toggled.

**Adding more templates:** any string key works (`"weekly_recap"`, `"unit_overview"`, etc.). The names `"default"`, `"lesson"`, and `"assessment"` are conventions, not requirements.

#### Lesson template (Franklin preset)

The bundled Franklin lesson template (`configs/franklin.json` → `pageTemplates.lesson`) defines:

**Slots** (all populated by the planning skill):

| Slot | Purpose |
|---|---|
| `about` | What students will learn about (1–2 sentence topic summary) |
| `to` | What skills students will gain (typically a bulleted list of can-do statements) |
| `concepts` | Key concepts and terms with brief definitions |
| `resources` | Links to readings, videos, websites, other materials |
| `tasks` | Tasks for students to complete during the lesson |
| `discussion` | Discussion forum link / prompt (only used when the section is included) |
| `assessment` | Link to a related assessment task |

**Sections** (override per-call with `include_sections` / `omit_sections`):

| Section | Default | When to toggle |
|---|---|---|
| `discussion` | omit | Include when the teacher mentions a discussion, debate, or forum prompt |
| `assessment` | include | Omit for purely formative lessons with no graded task to link |

**Per-course tokens** the lesson template uses: `{{course_name}}`, `{{course_url}}`, `{{title}}`. The course nav strip (Start Here, Syllabus, Modules, More Resources) is templated via `{{course_url}}` so the same template works across every course without re-uploading.

Example call from a `plan-lesson` skill:

```
create_page(
  course_identifier: "DSGN_9_120251",
  title: "The Water Cycle",
  template: "lesson",
  slots: {
    about: "<p>The water cycle and watershed geography.</p>",
    to: "<ul><li>Diagram a local watershed</li><li>Explain evapotranspiration</li></ul>",
    concepts: "<p><strong>Watershed:</strong> ...</p>",
    resources: "<ul><li>USGS watershed tool</li></ul>",
    tasks: "<ol><li>Map your home watershed</li></ol>",
    assessment: "<p>See the watershed quiz, due Friday.</p>"
  }
)
```

To add a discussion accordion to that lesson, pass `include_sections: ["discussion"]` and fill `slots.discussion`. The response includes `included_sections` and `omitted_sections` arrays so Claude can confirm what landed in the page.

### What is *not* in the school config (intentionally)

These stay generic — they're either federal law, Canvas-API standard, or sensible defaults for any school:

- FERPA anonymization and the `CANVAS_MCP_ALLOW_DEANONYMIZE` gate
- Course-code preferred over numeric id in user-facing output
- `published: false` default on `create_page` / `create_quiz`
- Course-code → course-id cache and the bypass-on-write rule
- Anything Canvas-API specific (pagination, retry, error shapes)

If you find yourself tempted to put one of these in `schoolConfig.json`, push back — it's almost certainly a generic concern.

---

## execute_typescript

For token-efficient bulk operations — grading 90 submissions at once, scanning every rubric across a course, generating per-student narratives — running the loop *inside* the MCP server (rather than streaming all data into Claude's context) saves enormous amounts of token throughput. `execute_typescript` is that escape hatch.

User code runs in a `node:worker_threads` Worker:

- **Terminable timeout.** Default 120s, max 600s. On timeout, `worker.terminate()` reclaims the thread and the MCP keeps serving other tools.
- **Memory cap.** `resourceLimits.maxOldGenerationSizeMb` (default 512 MB). Worker is OOM-killed by Node; the main thread is unaffected. Caveat: `Buffer`/`ArrayBuffer` use external memory and are NOT bounded by this — only the timeout protects against those.
- **Crashes stay isolated.** A `process.exit()`, infinite loop, or OOM in user code doesn't restart Claude Desktop. The next tool call works immediately.
- **Network guard ON by default.** Patches `net.connect`, `tls.connect`, `http.request`/`get`, `https.request`/`get`, and `globalThis.fetch`. Only the Canvas host (parsed from `CANVAS_API_URL`) is allowed by default. `TS_SANDBOX_ALLOWLIST_HOSTS` adds more; `TS_SANDBOX_BLOCK_OUTBOUND=false` disables the guard entirely.
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

This is the difference between honoring the FERPA gate and bypassing it. The on-disk map is shared between the worker and the main thread, so pseudonyms stay consistent across both paths.

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

Pseudonymization is the primary defense. Real names never reach Claude's context window unless the operator has explicitly set `CANVAS_MCP_ALLOW_DEANONYMIZE=true` (and restarted). Even when Claude is asked to "show real names," the server returns pseudonyms anyway and surfaces a warning. See "Anonymization (FERPA gate)" above.

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

### Worker spawn fails with "Cannot find module 'tsx/esm'"

You ran a checkout install with `npm install --omit=dev` or similar. Currently `tsx` is a runtime dependency (the worker compiles user TypeScript on the fly). Re-install with `npm install` (no flags) and rebuild.

### "no Canvas course matches ..."

Course-code resolution failed. The MCP's `resolveCourseId` calls `GET /api/v1/courses?search_term=...` to map a course code to a numeric id; if no result matches, you get this error. Most often the cause is a typo in the course code or a course you're not enrolled in (and you don't have account-admin to see it). Try `list_account_courses` (if admin) to find it.

---

## Architecture notes

- **Single CanvasClient** (`src/canvasClient.ts`) — axios-backed, handles 429+Retry-After backoff, Canvas Link-header pagination, in-process course-code → id cache (bypassed on writes so renames can't misroute).
- **Persistent Anonymizer** (`src/anonymizer.ts`) — per-course JSON map at `${ANON_MAP_DIR}/{courseId}.json`. Atomic same-dir tmp+rename writes with `0o600`/`0o700` modes. Per-course async mutex prevents double-allocation under concurrent calls.
- **Lifted `code_api/`** (`src/code_api/`) — copied verbatim from the Python `canvas-mcp-fork` so `execute_typescript` can import the same modules the upstream MCP supports. **Do not modify locally** — fixes flow upstream first, then re-lift.
- **School config** (`src/schoolConfig.ts`) — single boundary between generic core and Franklin-specific data. Other schools point `SCHOOL_CONFIG` at their own JSON.
- **`snake_case` everywhere** — tool names AND zod schema parameter names. Matches the Python MCP signatures exactly so the user's existing `teaching-AIssitant/` skills don't need parameter renames (only the few items in `docs/MIGRATION.md`).

---

## Plan

Design document: `docs/plans/2026-05-22-001-feat-canvas-mcp-typescript-port-plan.md`.

Skill-by-skill migration (for teachers moving from the Python `canvas-mcp-fork` to this MCP): `docs/MIGRATION.md`.
