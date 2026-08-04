# Skill migration guide — Python canvas-mcp-fork → Node canvas-mcp

This document is for the operator of `teaching-AIssitant/` (Franklin School). It catalogs every change needed in the skills' `SKILL.md` files when cutting over from the Python `canvas-mcp-fork` to this Node MCP.

**Big picture.** The new MCP keeps the same `snake_case` tool names AND parameter names as the Python MCP, so the bulk of every skill stays unchanged. The migration is concentrated in four narrow changes:

1. **Google tool retargeting** — `fetch_google_doc` / `fetch_google_slides` / `google_authenticate` move off the Canvas MCP and onto the existing Claude Drive MCP.
2. **execute_typescript text update** — six skills carry a "Do NOT use `execute_typescript` — it bypasses FERPA anonymization" warning that is no longer accurate. The new MCP ships a FERPA-safe adapter at `./anonymizer.js`.
3. **`write-narratives` env var name change** — `ENABLE_DATA_ANONYMIZATION` (Python) → `CANVAS_MCP_ALLOW_DEANONYMIZE` (new, with inverted semantics).
4. **`get_anonymization_status` output shape change** — the response now lists files on disk rather than session counters.

Everything else — `list_courses`, `list_users`, `list_assignments`, `list_submissions`, all four grading tools, every page/quiz/module tool, both rubric tools, both account-scoped tools, `create_student_anonymization_map`, `list_competencies` — keeps the exact same call signature.

---

## Cutover

When you're ready to switch:

1. Install the new MCP via the one-click `.mcpb` installer (or update your existing `canvas-mcp-node-test` config entry). See the new MCP's `README.md` → "Install".
2. In `claude_desktop_config.json`, **rename** the new server's key from whatever test name you used (e.g. `canvas-mcp-node-test`) to `canvas-mcp`. **Remove** the old Python MCP entry under that same key. The `mcp__canvas-mcp__*` tool prefix in your skills' `allowed-tools` front-matter now resolves to the new server.
3. Restart Claude Desktop.
4. Apply the per-skill changes in this document.

> Parallel run is not supported — both servers would expose identical `snake_case` tool names and Claude couldn't tell which it's calling. The cutover is a hard swap.

---

## Per-skill audit table

| Skill | Google tools? | execute_typescript text? | Other changes | Effort |
|---|:---:|:---:|---|---|
| `grade-submissions` | ✅ retarget | — | None | medium |
| `create-activity-doc` | ✅ retarget | — | Update `allowed-tools` front-matter | small |
| `create-quiz` | ✅ retarget | ✅ rewrite | None | medium |
| `generate-tdc-portfolio` | ✅ retarget | — | None | medium |
| `write-narratives` | ✅ retarget (auth section) | — | `ENABLE_DATA_ANONYMIZATION` → `CANVAS_MCP_ALLOW_DEANONYMIZE` (inverted) | medium |
| `student-portrait` | ✅ retarget | — | None | medium |
| `scan-tdc-rubrics` | — | ✅ rewrite | None | small |
| `setup-class` | — | ✅ rewrite | None | small |
| `transition-report` | — | ✅ rewrite | None | small |
| `assess-tdc-scores` | — | ✅ rewrite | None | small |
| `plan-lesson` | — | ✅ rewrite | None | small |
| `pedagogical-council` | — | — | None | — |
| `export-tdc-timeline` | — | — | None | — |
| `competency-explorer` | — | — | None | — |
| `ubd-unit-plan` | — | — | None | — |
| `canvas-course-audit` | — | — | None (uses bash scripts, not MCP tools) | — |
| `grade-rgm` | — | — | None | — |
| `limitless` | — | — | None | — |
| `google-docs` | ✅ retarget (or retire) | — | This whole skill exists to handle Google content. Consider retiring it — the Claude Drive MCP handles the same surface natively. | medium |

---

## Change 1 — Google tool retargeting

The Python MCP exposed three Google tools through the Canvas MCP prefix:
- `mcp__canvas-mcp__google_authenticate`
- `mcp__canvas-mcp__fetch_google_doc`
- `mcp__canvas-mcp__fetch_google_slides`

The new Node MCP drops all three. **Skills migrate to the Claude Drive MCP**, which is already authenticated in the Claude.ai environment. The replacement tools are:

| Old | New | Notes |
|---|---|---|
| `mcp__canvas-mcp__google_authenticate` | *(no replacement needed)* | The Claude Drive MCP handles its own OAuth in the Claude.ai web/desktop session. No auth prompt step in skills. |
| `mcp__canvas-mcp__fetch_google_doc` | `mcp__claude_ai_Google_Drive__read_file_content` | Takes a Drive file id, not a URL — skills extract the id from the URL first. |
| `mcp__canvas-mcp__fetch_google_slides` | `mcp__claude_ai_Google_Drive__read_file_content` | Same endpoint handles slides; returns text formatted per slide. |

### Before / after — URL handling

Old skill pattern (e.g., `grade-submissions`):

```
* If submission types include `online_url`, check Google auth: call
  `fetch_google_doc` with a test — if it returns an auth error, tell
  the teacher to run `google_authenticate` first.
* docs.google.com/document/d/<ID>/... → call fetch_google_doc(url)
```

New skill pattern:

```
* If submission types include `online_url` and the URL is a Google
  Docs/Slides link, extract the file id from the path:
  - https://docs.google.com/document/d/<ID>/... → file_id = <ID>
  - https://docs.google.com/presentation/d/<ID>/... → file_id = <ID>
  Call `mcp__claude_ai_Google_Drive__read_file_content(file_id=<ID>)`.
  No separate auth step — the Claude Drive MCP manages OAuth itself.
```

### Skills to update with this change

- `grade-submissions` — every reference to `fetch_google_doc`, `fetch_google_slides`, `google_authenticate` (5+ mentions)
- `create-activity-doc` — `allowed-tools` front-matter lists `mcp__canvas-mcp__fetch_google_doc`; drop it, add `mcp__claude_ai_Google_Drive__read_file_content`
- `create-quiz` — OAuth-check sequence + `fetch_google_doc` call
- `generate-tdc-portfolio` — `online_url` row in the submission-type table
- `write-narratives` — entire OAuth-status section (P3.1 OAuth scope check) becomes a no-op
- `student-portrait` — `online_url` row + the optional-tools list at the bottom
- `google-docs` (the skill itself) — consider retiring; the Claude Drive MCP handles its purpose

### Edge case: writing to Google Docs

The Python MCP's `fetch_google_doc` was read-only. The Claude Drive MCP's `create_file` and `copy_file` can also **write**, which the Python flow didn't support. If you previously used `write-narratives` to read a teacher's draft and re-write it via the bundled `google-docs` Python script, that script can move to `mcp__claude_ai_Google_Drive__create_file` natively. Out of scope for this migration but worth noting.

---

## Change 2 — execute_typescript text update

Six skills carry a "Do NOT use execute_typescript — it bypasses FERPA anonymization" warning. **This is no longer accurate** — the new MCP exposes `./anonymizer.js` from `code_api/` that binds to the same on-disk pseudonym map the typed tools use. User code that routes through the adapter gets the same `Student N` pseudonyms `list_users` and `list_submissions` produce.

### Before / after

Find any line resembling:

```
- Do NOT use `execute_typescript` — it bypasses FERPA anonymization.
```

Replace with:

```
- When using `execute_typescript` with student data, import
  `{ anonymizeSubmissions, anonymizeUsers } from "./anonymizer.js"`
  and route every student-facing transform through the adapter — this
  produces the same Student N pseudonyms that list_users and
  list_submissions return for the same course.
```

### Skills to update with this change

- `scan-tdc-rubrics`
- `setup-class`
- `transition-report`
- `create-quiz`
- `assess-tdc-scores`
- `plan-lesson`
- *(grep `teaching-AIssitant/.claude/skills/*/SKILL.md` for the literal string "bypasses FERPA" to catch any I missed)*

### Worked example — when to use the adapter

```ts
// inside execute_typescript user code
import { listSubmissions } from "./canvas/assignments/listSubmissions.js";
import { anonymizeSubmissions } from "./anonymizer.js";

const subs = await listSubmissions({ courseIdentifier: "60366", assignmentId: "123" });
const safe = await anonymizeSubmissions(60366, subs);
// safe[i].user.name is "Student N"; safe[i].submission_comments[j].author is
// preserved verbatim if the author is a teacher (per the FERPA-gate policy).
```

---

## Change 3 — write-narratives env var

The Python MCP used `ENABLE_DATA_ANONYMIZATION` (default off; setting it ON enabled the anonymizer). The new MCP uses `CANVAS_MCP_ALLOW_DEANONYMIZE` (default off; the env is now the **de-anonymization** opt-in, with inverted semantics).

### Before / after

Old text in `write-narratives` SKILL.md:

```
If `ENABLE_DATA_ANONYMIZATION` is on, `list_users` returns pseudonyms — the
maps become useless. Fall back to a cleartext roster cached in
`classes/{course-slug}/config.yaml` under a `roster:` key.
```

New text:

```
`list_users` ALWAYS returns pseudonyms unless the operator has explicitly
set `CANVAS_MCP_ALLOW_DEANONYMIZE=true` in the MCP server env (and
restarted). Real-name workflows must either:
  (a) flip the env var temporarily — restart Claude Desktop, do the
      work, flip it back, restart again, OR
  (b) call `create_student_anonymization_map` once for the course and
      use the returned real-name → pseudonym mapping locally to resolve
      Student N back to real students for this run.

Option (b) is preferred — it doesn't require an MCP restart and keeps the
default-anonymize posture intact.
```

### What this means in practice

`write-narratives` used to assume the operator could opt into real names by leaving an env var off. Now real names require an opt-IN with a server restart, OR the skill uses `create_student_anonymization_map`'s response (which contains real names when `CANVAS_MCP_ALLOW_DEANONYMIZE=true`).

Recommended pattern going forward: **`create_student_anonymization_map` is the per-course "look up real names" workflow**. Don't toggle the env var during a session.

---

## Change 4 — get_anonymization_status output shape

The Python version reported session statistics (counts of how many users had been anonymized in the current process). The new version reports **persistent state on disk**: one entry per course map file, with the entry count and the file's `generated_at` timestamp.

If a skill asserts on a specific field name from the old response, it'll break. Spot-check by grepping for `get_anonymization_status` in your skills:

```bash
grep -rn "get_anonymization_status" teaching-AIssitant/.claude/skills/
```

Based on the current audit, no skill depends on the specific shape — they just call the tool to surface state. The output is more useful now (it shows which courses already have stable pseudonyms vs. which still allocate on-the-fly), so any skill that uses it benefits without modification.

---

## Change 5 (recommended, not required) — Seed pseudonyms with `create_student_anonymization_map`

The new MCP allocates pseudonyms **lazily**. The first time you call `list_users` (or any other student-data tool) for a course, students get assigned `Student 1`, `Student 2`, … in whatever order Canvas returns them. That order is not guaranteed to be stable across Canvas API calls.

**Best practice:** at the start of any longitudinal workflow (narratives, council reviews, transition reports, portfolios) for a given course, call `create_student_anonymization_map` once. That writes a stable pseudonym file in roster order, and every subsequent call uses it.

Skills that should adopt this prelude:

- `write-narratives` (already does it implicitly via the cached roster — make it explicit)
- `generate-tdc-portfolio`
- `transition-report` (already calls it — good)
- `student-portrait`
- `pedagogical-council` (when used with student work)

Recommended add-on snippet (somewhere near the top of each skill's "Workflow" section):

```
**Step 0 — Seed pseudonyms.** Before any other student-data tool call:
`create_student_anonymization_map(course_identifier=<course>)`. This
locks in stable Student N pseudonyms for the course. Subsequent calls
to list_users / list_submissions / list_assignments return the same
pseudonyms across this session and any future session.
```

---

## Verification checklist (after applying changes)

Run each skill against a real (or test) Canvas course and confirm:

- [ ] `grade-submissions` — Google Docs/Slides submission grading still works (now via Claude Drive MCP).
- [ ] `create-activity-doc` — pulling reference Google Docs still works.
- [ ] `create-quiz` — Google Doc → quiz pipeline still works.
- [ ] `write-narratives` — anonymization no longer requires `ENABLE_DATA_ANONYMIZATION`; the `create_student_anonymization_map` path returns real names when needed (with the env opt-in or via the returned mapping).
- [ ] `generate-tdc-portfolio` — student portfolio generation produces stable pseudonyms across runs.
- [ ] `student-portrait` — narrative portraits still produced; Google submission types accessible.
- [ ] `transition-report` — pseudonym map gets seeded; cross-course workflow stays coherent.
- [ ] `scan-tdc-rubrics`, `setup-class`, `assess-tdc-scores`, `plan-lesson` — `execute_typescript` warning has been replaced; verify the skill still steers Claude away from accidentally bypassing anonymization.
- [ ] All other skills — verify they call the same tools and get the same shapes. No behavioral change expected.

If a skill behaves unexpectedly, run `list_code_api_modules` or check the new MCP's `README.md` "Tool reference" to confirm signatures.

---

## What didn't change (so you don't have to second-guess)

- Every `mcp__canvas-mcp__*` tool name is identical to the Python MCP's name.
- Every zod schema parameter name is `snake_case` and matches the Python MCP's signature exactly. Skills' tool calls don't need parameter renames.
- `course_identifier` accepts either a course code (`DSGN_9_120251`) or a numeric id, same as before.
- `published: false` is still forced on `create_page` / `create_quiz` (this is a cross-project rule from `Documents/CLAUDE.md`).
- Course code preferred over numeric id in user-facing output, same as before.
- All Franklin TD Competency descriptions (when `SCHOOL_CONFIG` points at the bundled `configs/franklin.json`) are byte-equal to the Python MCP's `_format_competencies_list` output, modulo whitespace.

---

## v0.4.0 — new tools + output changes

Twenty new tools plus output-shape changes from the token-efficiency pass. Existing tool names and parameters are unchanged — additions only — but a few output shapes changed in ways worth knowing when a skill inspects specific fields.

### New tools

Assignments:

- `create_assignment(course_identifier, name, description?, due_at?, unlock_at?, lock_at?, points_possible?, submission_types?)` — created unpublished, always.
- `update_assignment(course_identifier, assignment_id, ...same optional fields)` — partial update; never touches published state; warns if Canvas ignores a `submission_types` change.

Quizzes (classic only — New Quizzes are on a separate API and show up in `list_assignments` as `external_tool` items):

- `list_quizzes(course_identifier)` — trimmed quiz list with question counts.
- `get_quiz(course_identifier, quiz_id)` — full settings + trimmed questions.
- `update_quiz(course_identifier, quiz_id, ...)` — settings update; never touches published state.
- `update_quiz_question(course_identifier, quiz_id, question_id, question)` — replace a question (same payload as `create_quiz_question`).
- `delete_quiz_question(course_identifier, quiz_id, question_id)` — remove a question. Both question tools note Canvas's quiz-versioning behavior on quizzes with submissions.

Modules:

- `update_module(course_identifier, module_id, name?, position?, prerequisite_module_ids?, require_sequential_progress?, unlock_at?)` — partial update.
- `update_module_item(course_identifier, module_id, item_id, title?, position?, indent?, new_tab?)` — partial update of one module item. Deliberately no `published` parameter — a module item's published flag controls student visibility, so publish stays manual (never-auto-publish rule).
- `delete_module(course_identifier, module_id)` — removes the module shell; contents remain in the course.
- `delete_module_item(course_identifier, module_id, item_id)` — removes the module entry; underlying content remains.

Discussions:

- `list_discussions(course_identifier)` — trimmed topic list (announcements excluded).
- `get_discussion(course_identifier, topic_id, include_entries?, anonymous?)` — topic + entries; student authors pseudonymized, roster names scrubbed from bodies (best-effort) by default.
- `create_discussion(course_identifier, title, message, discussion_type?, delayed_post_at?)` — created unpublished, always.
- `update_discussion(course_identifier, topic_id, ...)` — partial update; refuses announcements; `published` accepts only `false`.
- `delete_discussion(course_identifier, topic_id)` — permanently deletes a discussion topic and its entries; refuses announcements (use `delete_announcement`).

Announcements (cannot be drafts, so scheduling replaces the draft rule):

- `list_announcements(course_identifier)` — windowless list; scheduled (`post_delayed`) items appear with `delayed_post_at`.
- `create_announcement(course_identifier, title, message, delayed_post_at)` — `delayed_post_at` REQUIRED: ISO-8601 with explicit offset or `Z`, at least 30 minutes in the future (env-tunable floor). Skills must ask the teacher to confirm the post time.
- `update_announcement(course_identifier, topic_id, title?, message?, delayed_post_at?)` — same floor rules for a new time; null/empty rejected; edits after the post time are live.
- `delete_announcement(course_identifier, topic_id)` — permanently deletes an announcement, before the post time (cancels the schedule) or after (removes the live announcement); refuses plain discussions (use `delete_discussion`).

Deliberately excluded: **`delete_assignment` and `delete_quiz` do not exist** — assignments and quizzes are grade-bearing objects, and deleting one destroys student submissions and grades. Delete those in the Canvas UI, where Canvas shows its own confirmation and impact warnings.

### Output-shape changes

- **`list_assignments` is trimmed by default.** Rows carry scheduling/grading fields (id, name, due_at, unlock_at, lock_at, points_possible, published, workflow_state, submission_types, has_rubric) — HTML descriptions are omitted unless `include_description: true`, and `published_only: true` filters to published assignments. The `write-narratives` skill already called `list_assignments` expecting compact rows — its existing calls now work as intended without post-filtering. Any skill that needs the full assignment body should call `get_assignment_details`.
- **`list_submissions` is trimmed.** Rows keep id, user_id, workflow_state, submitted_at, late, missing, grade, score, **`attempt`**, user, attachments, rubric_assessment, and submission_comments — and each comment keeps its **`author_id`** — both of which `grade-submissions` depends on. Submission-comment **authors are now anonymized unless they're course staff** (teachers/TAs keep real attribution); previously non-staff commenters could come through verbatim.
- **`list_submissions` nested objects are allowlisted too.** `user` keeps `{id, name, email}`; `attachments` keep `{id, filename, display_name, content_type, size}` — the signed download `url` is **intentionally removed** (it embeds a bearer-equivalent verifier), use `download_submission_attachment` instead; `submission_comments` keep `{id, author_id, author_name, comment, created_at, attempt}`.
- **`list_modules` is trimmed.** Modules carry id, name, position, workflow_state, published, items_count, unlock_at, require_sequential_progress, prerequisite_module_ids (plus `items` trimmed to id, title, type, content_id, page_url, position, published when `include_items: true`).
- **`create_quiz` returns a trimmed response** (id, title, quiz_type, published, due_at, points_possible, question_count, html_url). Call `get_quiz` for the full settings (description, shuffle_answers, allowed_attempts, time_limit, access_code, ...).
- **`execute_typescript` returns human-readable text only.** The structured result object was removed — parse the printed stdout/stderr text; don't expect a JSON payload block.
- **Course-code ambiguity errors instead of guessing.** A non-numeric `course_identifier` resolves only on a unique exact match (code first, then name). Multiple exact matches return an error listing the candidate courses with numeric ids — the model self-corrects by passing the id. Skills that relied on fuzzy near-miss resolution should switch to exact codes or numeric ids.
- **`structuredContent` removed.** Tool results are now a single compact-JSON text block plus a one-line summary — payloads are no longer duplicated. No skill in the current audit reads `structuredContent`, so no changes are expected; if one asserts on it, parse the text block's JSON instead.

---

## v0.4.1 — assignment descriptions template-wrapped by default

- **`create_assignment` / `update_assignment` now wrap descriptions in the school's page templates** — the same `template` / `slots` / `include_sections` / `omit_sections` machinery as `create_page` / `edit_page_content`. When a school config is loaded, a provided `description` is wrapped in the `default` template automatically; pass `template: 'assessment'` (discover slot names + the ASMT title format via `list_page_templates`) for Franklin assessments, or `template: 'none'` to opt out and send the description verbatim. Calls with neither `description` nor `slots` skip templating entirely — no chrome-only descriptions. `update_assignment` mirrors `edit_page_content`'s two modes: simple field update (description verbatim) vs. rebuild-from-template when any template arg is passed (pass ALL slots you want in the result). Responses carry `template_applied` / `included_sections` / `omitted_sections` / `warnings` like `create_page`.
- **Quiz descriptions stay verbatim by design** — quiz intros render above the questions, not as wiki pages, so `create_quiz` / `update_quiz` do no page-template wrapping (their tool descriptions now say so).
