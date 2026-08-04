---
title: "feat: Token-efficiency + utility pass (pre-distribution)"
type: feat
status: completed
date: 2026-08-04
origin: docs/brainstorms/2026-08-04-token-efficiency-and-utility-requirements.md
deepened: 2026-08-04
---

# feat: Token-efficiency + utility pass (pre-distribution)

## Overview

Final pass on canvas-mcp-node (v0.3.17) before distributing the `.mcpb` to Franklin School teachers: shrink tool-response payloads (trimmed field mappings, compact single-representation `jsonResult`), close the silent wrong-course-write hole (exact-match-or-error course resolution, single resolution per bulk-grade run), and add ~15 tools completing the create → inspect → fix loop for assignments, quizzes (including questions), modules, discussions, and announcements — all under the existing FERPA gate and never-auto-publish invariants.

## Problem Frame

See origin doc for full framing. Three pre-distribution risks: (1) token waste — raw Canvas objects (full HTML assignment descriptions, comment/avatar metadata) plus a double-sent payload in every result burn context in long grading sessions; (2) course resolution silently falls back to the first fuzzy match, and grade writes ride that path; (3) missing CRUD symmetry means teachers hit walls that would force the post-distribution update this pass exists to prevent.

## Requirements Trace

From origin (all must be satisfied):

**Payload efficiency & output shape**
- R1 trimmed `list_assignments` (+ opt-in description) — Unit 3
- R2 trimmed `list_submissions` embedded objects — Unit 3
- R3 explicit field mapping audit across tools — Unit 3
- R3a anonymize-first-trim-second, with regression test — Units 3, 7
- R4 single compact `jsonResult` representation — Unit 1

**Course-resolution correctness**
- R5 exact-match-or-error course resolution (incl. multiple exact matches) — Unit 2
- R6 one course resolution per bulk-grade run — Unit 2

**Create → inspect → fix loops**
- R7 `create_assignment` / `update_assignment` — Unit 4
- R8 quiz list/get/update + question update/delete — Unit 5
- R9 `update_module` / `delete_module` / `delete_module_item` — Unit 6
- R10 discussions CRUD + entry-author anonymization via roster lookup — Units 7, 8
- R11 announcements list/create/update with teacher-confirmed `delayed_post_at` — Unit 9

**Engineering practices & documentation**
- R12 conventions (snake_case, `safeHandler`, cache bypass on writes, tests, README/MIGRATION rows) — every unit; Unit 10 sweeps docs
- Success criteria: payload-size reduction, no wrong-course writes, fix loop per domain, skills-compatibility audit, dogfooding gate — Units 1–10 + Operational Notes

## Scope Boundaries

- No consolidation/renames of the three existing grading tools; no parameter renames anywhere (Python-signature parity). New *parameters* are additive only (e.g., `include_description`).
- No gradebook/analytics, calendar, sections, or enrollment-management tools.
- No changes to `execute_typescript` sandbox or lifted `src/code_api/` (its own response shapes stay as-is).
- No auto-publish anywhere. New Quizzes API support is out of scope (documented limitation, see decisions).

### Deferred to Separate Tasks

- `teaching-AIssitant` SKILL.md updates for the new tools: notes land in `docs/MIGRATION.md` (Unit 10); actual skill edits happen in that project.
- Capturing post-implementation learnings into `docs/solutions/` via `/ce-compound` (the knowledge base is nearly empty; this pass will generate several).

## Context & Research

### Relevant Code and Patterns

- `src/tools/toolHelpers.ts` — `jsonResult` currently pretty-prints AND duplicates payload into `structuredContent`; `safeHandler`/`errorResult` pattern all new tools must use.
- `src/canvasClient.ts` — `resolveCourseId` (`results.find(exact code) ?? find(exact name) ?? results[0]` — the fallback to `results[0]` is the bug); `getPaginated` with `truncated` flag; course-code cache + `bypassCache`.
- `src/tools/courses.ts` `displayCourse()` and `src/tools/pages.ts` `trimResponseBody()` / `list_pages` mapping — the two existing (divergent) trim patterns; this plan consolidates the idiom via a shared helper.
- `src/tools/grading.ts` — `writeGrade()` re-resolves the course per student inside `bulk_grade_submissions` (the N+1); `buildGradeFormData` form-encoding pattern reused for any form-encoded writes.
- `src/anonymizer.ts` — `classifyRole` reads `user.role` / `user.enrollments[]`; `anonymizeUser` (policy-driven), `anonymizeSubmission` (submitter always student-policy; comment authors teacher-policy). Discussion entries carry no role data, hence the roster-lookup plumbing in Unit 7.
- `src/tools/modules.ts` `add_module_item` type-routing switch — pattern for content_id routing; `create_module` unpublished-by-default note.
- `tests/_helpers/mockCanvas.ts` + `tests/tools/*.test.ts` — `buildMockCanvas` / `buildToolHarness` harness; `tests/tools/pages.test.ts` uses isolated fixture configs (endorsed pattern).
- `src/index.ts` — registration order; anonymizer wired before student-data tools.

### Institutional Learnings

- `docs/solutions/conventions/franklin-page-template-chrome-convention-2026-05-24.md`: fail loudly, never silently — a structurally-valid stub/guess ships unnoticed in the `.mcpb`. Directly endorses R5's error-with-candidates over guessing, and "omit a half-built tool rather than ship a stub." Also: make content-path decisions explicit — discussions/announcements bypass `pageTemplates` chrome **by stated decision** (they are discussion topics, not wiki pages).

### External References (verified against official Canvas docs + canvas-lms source)

- **Announcements**: cannot be draft (`Announcement` model rejects `unpublished`); `delayed_post_at` on `POST /api/v1/courses/:id/discussion_topics` (with `is_announcement=true`) delays visibility (`workflow_state: post_delayed`); a **past** timestamp posts immediately — the tool must validate server-side. `PUT .../discussion_topics/:id` can change `delayed_post_at` before it fires. `unlock_at` is the emerging alias.
- **Listing announcements**: `GET /api/v1/announcements` defaults to a `[now−14d, now+14d]` window and hides far-future scheduled posts; `GET /api/v1/courses/:id/discussion_topics?only_announcements=true` has **no window** and returns `post_delayed` items to teachers → use the latter.
- **Discussions**: entries expose `user_id` + `user_name` only (no embedded user object); `/view` adds `participants` (id, display_name, avatar_url) and can 503 while its cache builds or 403 on `require_initial_post`. `published: false` is valid for discussions. `PUT` accepts same params as create.
- **Classic quiz questions**: `GET/POST/PUT/DELETE /api/v1/courses/:id/quizzes/:quiz_id/questions[/:id]` all exist; questions are **not** inline on `GET /quizzes/:id` (only `question_count`). Editing questions after submissions exist versions the quiz; quizzes with submissions are `unpublishable: false`.
- **New Quizzes**: disjoint API (`/api/quiz/v1/...`, PATCH-based, assignment_id-keyed); classic endpoints do not list them; they appear in the Assignments API as `external_tool` submissions with `is_quiz_lti_assignment: true` (note: the `is_quiz_assignment` doc comment is wrong — it flags *classic* quizzes).
- **Assignments**: `POST /api/v1/courses/:id/assignments` defaults to `workflow_state: "unpublished"` (controller sets it; only overridden if `published` key present). `assignment[submission_types][]` on PUT is silently ignored once student submissions exist; `unpublishable: false` with submissions.
- **Modules**: `PUT /modules/:id` (name, position, prerequisite_module_ids, unlock_at, require_sequential_progress), `DELETE /modules/:id`, `PUT/DELETE /modules/:module_id/items/:id` all exist; module deletion soft-deletes only the module + content tags — underlying pages/assignments survive.

## Key Technical Decisions

- **`jsonResult` becomes text-only, compact**: text = optional summary line + `JSON.stringify(payload)` (no indent); `structuredContent` removed entirely (no tool declares `outputSchema`, so it is optional per MCP spec). `execute_typescript`'s hand-built `structuredContent` is removed the same way (its human-readable text block stays). Verified in dogfooding against Claude Desktop before packaging.
- **Exact-match-or-error in `resolveCourseId`**: exact `course_code` match (case-insensitive) wins when unique; exact name match when unique; **zero or multiple** exact matches → `CanvasApiError` (`VALIDATION`/`NOT_FOUND`) whose message lists up to 10 candidates as `course_code (id NNN) — name [term, workflow_state]` so the model re-calls with a numeric id. Numeric ids stay trusted verbatim (documented). Fuzzy `results[0]` fallback is deleted, not gated. Two endpoint realities shape the implementation: `search_term` is **not documented** on the enrollment-scoped `GET /api/v1/courses` (it is on the accounts endpoint), so matching is effectively client-side over the user's own courses — the lookup switches to `getPaginated` (full enrollment list, not first 50) and candidates are client-filtered by case-insensitive substring on code/name before the ≤10 cap. The zero-match error text states that codes resolve only within the caller's own enrollments and account courses need the numeric id from `list_account_courses`.
- **Bulk grade resolves once — no `writeGrade` signature change**: `resolveCourseId` already short-circuits numeric ids with zero HTTP calls, so the bulk loop simply passes its already-resolved numeric `courseId` (line-224 value) into `writeGrade` instead of the raw `args.course_identifier`. Single-submission grading tools keep per-call bypass resolution unchanged (CLAUDE.md invariant #4 wording updated to "per invocation" in Unit 10).
- **Write-path cache-bypass sweep**: five *existing* writes currently resolve without `bypassCache: true` — `create_page`, `edit_page_content`, `create_quiz`, `create_quiz_question`, `add_module_item` — contradicting the stated CLAUDE.md convention. Unit 2 sweeps them, closing the same rename-misroute class R5 targets.
- **Numeric-id code cache seeding**: the new error steers callers toward numeric ids, which never populate `courseIdToCode` (degrading `download_submission_attachment` directory naming and `list_user_enrollments` code display). Mitigation: seed `courseIdToCode` from `list_courses`/`get_course_details` responses, which already carry id + code at zero extra API cost. Cache shape is otherwise untouched (`include[]=term` only widens the response typing, not the cache).
- **Shared trim helper, anonymize-first**: `displayCourse` and `trimResponseBody` are actually two different operations — allowlist projection vs. omission-with-marker. The shared idiom is the projection: a `pick`-with-null-fill primitive in `toolHelpers.ts` consumed by per-resource `displayX(...)` functions (the `displayCourse` pattern generalized; nested arrays mapped by nested display functions). `trimResponseBody` and its skills-visible `body_omitted` marker **stay as-is** in pages.ts — a legitimately different idiom, noted, not migrated. For FERPA-scoped tools the mapping consumes the **anonymizer's output**, never the raw payload (R3a), with a regression test asserting pseudonyms survive trimming.
- **New-tool code conventions** (pre-decided so 15 tools don't fork the idioms): input schemas are plain ZodRawShape consts named `<TOOL>_INPUT` (never top-level `z.object`); nested payloads use `z.object` (Unit 5 reuses `QUESTION_PAYLOAD_SCHEMA` verbatim); handler arg casts use the `z.infer<z.ZodObject<typeof X_INPUT>>` idiom already used in `quizzes.ts`/`grading.ts`. The thrice-duplicated `resolveAnonymous` (users.ts, submissions.ts, inline in assignments.ts) is hoisted next to `DEANON_DENIED_NOTE` in `featureFlags.ts` as the single source of truth; Units 7–8 import it rather than minting copy #4.
- **`list_assignments` opt-in description**: new additive `include_description: boolean` param (default false). Additive params don't break Python-signature parity (which bans renames/changes, not additions).
- **Announcements**: `create_announcement` requires `delayed_post_at`, validates it is ≥ now + 30 minutes (constant `MIN_ANNOUNCEMENT_DELAY_MINUTES = 30`, overridable via `CANVAS_MCP_MIN_ANNOUNCEMENT_DELAY_MINUTES` — the floor doubles as the clock-skew buffer, so the override clamps to a ≥5-minute lower bound), fails closed on missing/null/past/near timestamps, and echoes the scheduled visibility time in the summary. Timestamps **must carry an explicit offset or `Z`** — offset-less ISO strings parse as server-local time while Canvas reads them as UTC, which can silently defeat the floor; they are rejected before any Canvas call. Defense in depth: after create/update, the tool asserts the response's `workflow_state === "post_delayed"` and raises a loud error if the announcement came back `active` (catches clock skew no client-side check can). `update_announcement` allows moving the time (same floor + offset rule; null/empty `delayed_post_at` rejected — Canvas clears the delay on empty → immediate post). `list_announcements` uses `discussion_topics?only_announcements=true` (no silent window). `update_discussion` refuses topics with `is_announcement: true` and directs to `update_announcement`, so the floor can't be bypassed cross-tool.
- **Discussions FERPA**: entry authors classified via per-invocation roster fetches — a **staff fetch** (`enrollment_type[]=teacher,ta,designer` → staff-id set) and a **student fetch** (student names for the body scrub). Failure polarities differ and are by design: staff-fetch failure/truncation fails *closed* (unknown → student → pseudonymized; worst case a TA gets a pseudonym), while student-fetch truncation fails *open* for the body scrub (names on unfetched pages survive) and therefore surfaces a distinct truncation warning. Authors not in the staff set — including dropped students, observers, and the Student View test account — are treated as students and pseudonymized via the existing per-course map (`getOrAllocate` with a synthetic user `{id: user_id, name: user_name}`; same on-disk format; map "pollution" by non-roster authors is accepted — fail-closed beats map purity). Entries with null/absent `user_id` (deleted users, anonymous discussions) render a fixed "Former participant" placeholder — never verbatim `user_name`, never an allocation.
- **Body-scrub matching rules** (this is where FERPA false positives/negatives live, so they're fixed now): case-insensitive, word-boundary matching, longest-match-first (full names before first-name tokens, so "Ana Maria" never becomes "Student 2 Maria"), covering full names and bare first-name tokens. Every generated pattern passes through a shared `escapeRegExp(name)` helper — real names carry apostrophes, hyphens, and periods that would otherwise throw or silently change matching semantics. The scrub applies to discussion **entry** messages, the **topic-level** `message`, and announcement bodies (teacher prose routinely names students — "reply to your assigned partner: Grace"). The anonymized payload carries a dedicated warning constant (not `DEANON_DENIED_NOTE`) stating both residual risks: free-text may still contain unmapped identifying details (nicknames, misspellings), and substitutions may have altered quoted student text.
- **Submission-comment authors fail closed** (closes the one production FERPA fail-open this pass would otherwise ship): real Canvas comment authors are UserDisplay objects with no role/enrollment data, so `classifyRole` returns "unknown" and the current `unknownRolePolicy: "teacher"` preserves real student names under `anonymous=true`. `list_submissions` (when comments are included) now classifies comment authors against the same staff-id set used for discussion entries — staff authors keep attribution, everyone else is pseudonymized. The `buildStaffIdSet` roster helper is therefore created in Unit 3 (`src/tools/roster.ts`) and reused by Unit 7. Cost: one paginated staff fetch per comments-included `list_submissions` call — same class as `list_users`. Origin R2's "author (anonymized per the FERPA gate)" is now literally true for production payloads.
- **Classic Quizzes only, loudly**: R8 tools target the classic API; tool descriptions state the New Quizzes limitation, and `list_quizzes` includes a `note` field when the course's assignments contain `is_quiz_lti_assignment` items (cheap detection, best-effort) so a New-Quizzes course isn't silently half-listed.
- **All new writes**: `bypassCache: true`, `safeHandler`, snake_case, drafts by default (`published: false` explicit for discussions; assignments rely on Canvas's unpublished default *and* send `published: false` explicitly for belt-and-suspenders).

## Open Questions

### Resolved During Planning

- `structuredContent` removal vs. text de-dup: **remove `structuredContent`** (no `outputSchema` declared anywhere; text is what Claude clients feed the model). Dogfooding verifies.
- Quiz questions inline vs. companion: Canvas does **not** inline questions → `get_quiz` performs quiz + questions fetches and returns both; no separate `list_quiz_questions` tool needed.
- Announcements "not yet visible" mechanism: `delayed_post_at` confirmed; drafts impossible; fail-closed validation with a 30-minute default floor.
- `list_announcements` endpoint: `discussion_topics?only_announcements=true` (windowless).
- Discussion body names: best-effort pseudonym substitution + `warnings[]`, per decision above.
- Candidate-list error shape: ≤10 candidates, `course_code (id) — name [term, state]`.
- `sis_course_id` in the exact-match set: **no** — Franklin skills use course codes; SIS ids would widen the ambiguity surface. Numeric id remains the disambiguator.

### Deferred to Implementation

- Exact trimmed field lists per tool: locked against real Canvas responses during Unit 3 (the plan names the intended shape; live payloads have the final say).
- Whether `list_quizzes` New-Quizzes detection is worth the extra assignments call on every invocation or only on demand — decide once real latency is observed.
- teaching-AIssitant output-field audit findings (Unit 3 precondition, re-verified in Unit 10; performed against the live skills repo).

## Implementation Units

Sequencing note: **Unit 1 lands first.** Every subsequent unit's tests are written against the parsed-text idiom (the `parseJsonResult` helper below), never `structuredContent`.

- [x] **Unit 1: Compact single-representation `jsonResult`**

**Goal:** Every tool result carries the payload exactly once, compact.

**Requirements:** R4

**Dependencies:** None

**Files:**
- Modify: `src/tools/toolHelpers.ts`, `src/tools/code_exec.ts`, `tests/_helpers/mockCanvas.ts` (drop `structuredContent` from `ToolHarness.call`'s return type; add shared parse helper)
- Test: all 14 `tests/tools/*.test.ts` files assert `structuredContent` today (~150 sites) — the sweep re-points every one

**Approach:**
- `jsonResult`: `JSON.stringify(payload)` (no indent), stop setting `structuredContent`; keep the `summary` prefix line. Remove the `McpTextResult.structuredContent` field or leave the type but never populate it. Protocol-safe: no tool declares `outputSchema`, and the MCP SDK only requires `structuredContent` when one is declared.
- `code_exec.ts` returns its human-readable text only (drop the hand-built `structured` object).
- Add `parseJsonResult(result)` to `tests/_helpers/mockCanvas.ts` — strips the optional summary line, `JSON.parse`s the remainder; `isError` results are returned as raw text (error text is not JSON). All 14 test files re-point through this single choke point instead of 14 hand-rolled text-splitting idioms; the per-file local `ToolResponse` interfaces centralize there too.

**Test scenarios:**
- Happy path: `jsonResult({a:1},{summary:"S"})` text is `"S\n\n{\"a\":1}"`; no `structuredContent` key.
- Edge case: non-object payloads (array, string) stringify compactly without wrapper objects.
- Helper: `parseJsonResult` round-trips summary-prefixed, summary-less, and `isError` results.
- Integration: a representative tool (e.g., `list_courses`) round-trips through the harness with parseable JSON after the summary line.

**Verification:** `npm test` green; no `structuredContent` remains in `src/` outputs or test assertions (grep clean, `code_api/` excluded).

- [x] **Unit 2: Exact-match course resolution + bulk-grade single resolution**

**Goal:** No write (or read) can silently land on a guessed course; bulk grading stops making N resolution calls.

**Requirements:** R5, R6

**Dependencies:** Unit 1 (tests use the parsed-text idiom)

**Files:**
- Modify: `src/canvasClient.ts` (resolution rewrite + `seedCourseCodes`), `src/tools/courses.ts` (seeding call sites), `src/tools/grading.ts`, `src/tools/pages.ts`, `src/tools/quizzes.ts`, `src/tools/modules.ts` (bypassCache sweep)
- Test: `tests/canvasClient.test.ts`, `tests/tools/grading.test.ts`, `tests/tools/courses.test.ts` (seeding), plus request-count updates in `tests/tools/pages.test.ts`, `tests/tools/quizzes.test.ts`, `tests/tools/modules.test.ts`

**Approach:**
- `resolveCourseId`: fetch the caller's courses via `getPaginated` (the enrollment-scoped endpoint's `search_term` is undocumented — treat matching as client-side; also fixes false NOT_FOUNDs for users with >50 courses), `include[]=term` widening only the inline response type. Pin the fetch's course-state params (e.g., `state[]=unpublished,available,completed`) so concluded prior-term courses appear as candidates — the flagship cross-year ambiguity (same code, two terms) only fires if concluded courses are actually in the list, and a teacher fixing grades right after term rollover must not get a misleading NOT_FOUND. Collect exact code matches (lowercased) → if exactly one, use it; else exact name matches → if exactly one, use it; else throw `CanvasApiError` listing ≤10 candidates (client-filtered by case-insensitive substring on code/name so the list is relevant, "+N more" suffix past 10) with code, id, name, term, workflow_state. Zero-match error text notes that codes resolve only within the caller's enrollments — account courses need the numeric id from `list_account_courses`. Delete the `?? results[0]` fallback. Cache only unique exact matches; seed `courseIdToCode` from `list_courses`/`get_course_details` responses so numeric-id callers keep code-labeled output.
- Bulk N+1: `bulk_grade_submissions` passes its already-resolved numeric `courseId` into `writeGrade` (no signature change — `resolveCourseId`'s numeric short-circuit is the pre-resolved path). Single-grade tools unchanged.
- bypassCache sweep: add `{ bypassCache: true }` to the five existing writes missing it — `create_page`, `edit_page_content`, `create_quiz`, `create_quiz_question`, `add_module_item`.
- Cache seeding mechanism: new public `CanvasClient.seedCourseCodes(courses)` populating `courseIdToCode` (and `courseCodeCache` for unique codes), called from the `list_courses` and `get_course_details` handlers in `src/tools/courses.ts` — `courseIdToCode` is private, so the seeding cannot be delivered without this method.

**Test scenarios:**
- Happy path: unique exact course_code resolves; unique exact name resolves; numeric string/number passes through untouched with zero HTTP calls.
- Error path: zero exact matches → error contains substring-relevant candidate codes/ids and the enrollment-scope note; multiple exact code matches (same code, two terms) → error listing both with term labels.
- Edge case: candidate list truncates at 10 with "+N more"; >1-page course list still finds a page-2 course; ambiguous pair spanning an `available` and a `completed` course both appear as candidates (state pinning); `seedCourseCodes` makes `getCachedCourseCode` return the code after a `list_courses` call with no resolution having run.
- Integration: `bulk_grade_submissions` with a course *code* and 3 students performs exactly one course-list fetch (mock call-count assertion); rename-mid-run scenario still writes to the originally resolved id; the five swept writes each perform a fresh resolution call (request-count assertions).

**Verification:** grading tests assert one resolution call per bulk run; ambiguous-code test proves no write is attempted; no write path resolves through the cache.

- [x] **Unit 3: Response trimming audit (anonymize-first)**

**Goal:** What reaches the model is an explicit field mapping everywhere; FERPA output is trimmed after anonymization.

**Requirements:** R1, R2, R3, R3a

**Dependencies:** Unit 1 (result shape settled)

**Files:**
- Create: `src/tools/roster.ts` (`buildStaffIdSet` — shared with Unit 7)
- Modify: `src/tools/toolHelpers.ts` (shared mapping helper), `src/featureFlags.ts` (`resolveAnonymous` hoist target), `src/tools/users.ts` (re-point to hoisted helper), `src/tools/assignments.ts`, `src/tools/submissions.ts`, `src/tools/modules.ts` (`list_modules` item mapping), `src/tools/quizzes.ts` (`create_quiz` response), `src/tools/rubrics.ts` (only if live payloads show noise — `get_rubric_details` stays full-fidelity)
- Test: `tests/tools/assignments.test.ts`, `tests/tools/submissions.test.ts`, `tests/tools/modules.test.ts`, `tests/tools/quizzes.test.ts` (trimmed `create_quiz` response assertions)

**Approach:**
- **Precondition — skills output-field audit**: before locking any tool's trim list, grep the `teaching-AIssitant` SKILL.md files for references to output fields (`description` on list results, comment metadata fields, `structuredContent`); trim lists must not remove a field a skill's prompt consumes. Unit 10 re-verifies before packaging, but discovery happens *here*, before Units 4–9 build on the trimmed shapes (origin doc: audit "before finalizing trim lists").
- Shared `pick`-with-null-fill primitive in `toolHelpers.ts` + per-resource `displayX(...)` functions (see Key Technical Decisions — `trimResponseBody` stays as-is in pages.ts).
- Hoist `resolveAnonymous` into `src/featureFlags.ts` beside `DEANON_DENIED_NOTE`; re-point `users.ts`, `submissions.ts`, `assignments.ts`.
- Comment-author fail-closed fix (see Key Technical Decisions): `buildStaffIdSet` lives in `src/tools/roster.ts`; when `list_submissions` includes comments, comment authors are classified against the staff set — staff verbatim, everyone else pseudonymized via the existing map.
- `list_assignments` default shape: `id, name, due_at, unlock_at, lock_at, points_possible, published/workflow_state, submission_types, has_rubric` (+ `description` only when `include_description: true`; embedded `submission`/`submission_history` keep the existing anonymize path, then trim).
- `list_submissions`: after `anonymizeSubmission`, map submissions to `id, user_id, user (pseudonymized name/email only), workflow_state, submitted_at, late, grade, score, attempt, attachments (id, filename, content_type, size), rubric_assessment (as-is), submission_comments (author_id, author_name, comment, created_at)`.
- Full-fidelity carve-outs stay raw: `get_page_content`, `get_assignment_details`, `get_rubric_details`, `get_course_details`.
- Ordering is structural: trim functions take the anonymizer's output; no tool calls the trimmer before the FERPA gate.

**Test scenarios:**
- Happy path: `list_assignments` omits `description` by default; includes it with `include_description: true`.
- R3a regression: with `anonymous=true`, trimmed `list_submissions` output contains `Student N` pseudonyms and `@anonymized.local` emails, never the raw fixture names (assert raw name absent from the entire serialized result) — **including a role-less UserDisplay comment author** (the realistic production shape), who must come back pseudonymized under the new staff-set classification while a staff-set author keeps attribution.
- Edge case: submission with no comments/attachments maps to empty arrays; assignment with rubric → `has_rubric: true`.
- Integration: FERPA-override path (`CANVAS_MCP_ALLOW_DEANONYMIZE=true`, `anonymous:false`) still returns trimmed shape with real names — trim and gate are independent.
- Denied-override path: (`CANVAS_MCP_ALLOW_DEANONYMIZE` unset, `anonymous:false`) → the override triple (forced anonymous, `warnings[]`, `anonymized: true`) survives the new trimmed envelope — the allowlist mapper must not drop the envelope keys `resolveAnonymous` rides on.

**Verification:** serialized `list_submissions` fixture output shrinks materially vs. current (assert absence of `avatar_url`/`preview_url`/`media_comment` keys); all FERPA tests green.

- [x] **Unit 4: Assignment tools**

**Goal:** Teachers can create and fix assignments.

**Requirements:** R7

**Dependencies:** Unit 2 (error shape), Unit 3 (trim helper)

**Files:**
- Modify: `src/tools/assignments.ts`, `src/index.ts` (registration already exists for the domain)
- Test: `tests/tools/assignments.test.ts`

**Approach:**
- `create_assignment(course_identifier, name, description?, due_at?, unlock_at?, lock_at?, points_possible?, submission_types?)` → POST with explicit `assignment[published]=false`; bypassCache; trimmed response + summary naming the draft state.
- `update_assignment(course_identifier, assignment_id, ...same optional fields)` → PUT only the provided keys; never sends `published`. Surface Canvas's silent-ignore of `submission_types` when submissions exist as a `warnings[]` entry when the response's submission_types differ from the request.

**Patterns to follow:** `create_page` (draft-forcing + summary wording), `create_module` payload assembly.

**Test scenarios:**
- Happy path: create sends `published: false` and only provided keys; update PUTs a partial payload.
- Error path: update with zero updatable fields throws the "provide at least one field" error; Canvas 403 surfaces via `errorResult`.
- Edge case: `submission_types` echo mismatch on update → `warnings[]` present.

**Verification:** created assignment summary says "draft"; no code path can send `published: true`.

- [x] **Unit 5: Quiz inspect/fix tools**

**Goal:** The quiz loop closes, including question-level fixes.

**Requirements:** R8

**Dependencies:** Units 2, 3 (error shape / resolution mocks; trim helper)

**Files:**
- Modify: `src/tools/quizzes.ts`
- Test: `tests/tools/quizzes.test.ts`

**Approach:**
- `list_quizzes(course_identifier)` → paginated, trimmed (`id, title, quiz_type, published, due_at, points_possible, question_count`); best-effort New-Quizzes note (see decisions; implementation may defer the detection call — flag in description regardless).
- `get_quiz(course_identifier, quiz_id)` → quiz GET + questions GET (paginated) in parallel; returns quiz (full) + `questions[]` (trimmed: id, position, question_name, question_type, points_possible, question_text, answers).
- `update_quiz(course_identifier, quiz_id, ...create_quiz's optional fields)` → PUT partial; never sends `published`.
- `update_quiz_question(course_identifier, quiz_id, question_id, question)` and `delete_quiz_question(...)` → reuse `QUESTION_PAYLOAD_SCHEMA`; descriptions warn that editing a quiz with existing submissions versions the quiz.

**Test scenarios:**
- Happy path: `get_quiz` merges quiz + questions; `update_quiz_question` PUTs the nested `question` payload.
- Error path: `delete_quiz_question` on missing question surfaces Canvas 404 with tool context.
- Edge case: quiz with zero questions returns `questions: []`, `question_count: 0`.

**Verification:** create → get → update-question → get round-trip in mocked harness shows the edit.

- [x] **Unit 6: Module fix tools**

**Goal:** Module-building mistakes recoverable in-session, including whole-module deletion.

**Requirements:** R9

**Dependencies:** Units 1, 2 (parsed-text tests; error shape)

**Files:**
- Modify: `src/tools/modules.ts`
- Test: `tests/tools/modules.test.ts`

**Approach:**
- `update_module(course_identifier, module_id, name?, position?, prerequisite_module_ids?, require_sequential_progress?, unlock_at?)` → PUT partial; never sends `published`.
- `delete_module(course_identifier, module_id)` → DELETE; bypassCache; summary states content survives ("removes the module structure only — pages/assignments inside remain in the course"), matching `delete_page`'s description style.
- `delete_module_item(course_identifier, module_id, item_id)` → DELETE.

**Test scenarios:**
- Happy path: update PUTs only provided fields; delete summary names the deleted module.
- Error path: deleting a nonexistent module surfaces 404 with context.
- Test expectation for publish state: no payload ever includes `published`.

**Verification:** all three registered, README rows present (Unit 10), tests green.

- [x] **Unit 7: Discussion-entry anonymization plumbing**

**Goal:** Entry authors are classified without embedded role data; bodies get best-effort scrubbing — before any discussion tool ships.

**Requirements:** R10 (gate half), R3a

**Dependencies:** Unit 3 (shared `buildStaffIdSet` in `src/tools/roster.ts`)

**Files:**
- Create: `src/tools/discussionAnonymizer.ts` (keeps `Anonymizer` network-free; composes the injected CanvasClient + Anonymizer per the existing register*Tools DI pattern)
- Modify: `src/tools/roster.ts` (student-name fetch joins the staff fetch here)
- Test: `tests/tools/discussions.test.ts`

**Approach:**
- Per-invocation roster data, no cross-call cache (rosters change; a stale cache is a FERPA leak vector):
  - `buildStaffIdSet(canvas, courseId)` (from Unit 3): paginated fetch with `enrollment_type[]=teacher,ta,designer` → `Set<string>`. Failure polarity: fail-**closed** for classification (unknown → student); total fetch failure errors the tool rather than proceeding unclassified.
  - Student-name roster fetch (student enrollments, real names) feeding the body scrub. Truncation here is fail-**open** (unfetched pages' names survive in bodies) → the response carries a distinct truncation warning when `truncated: true`.
- `anonymizeDiscussionEntry(courseId, entry, staffIds, studentNames)`: author in staff set → verbatim; null/absent `user_id` → fixed "Former participant" placeholder (never verbatim `user_name`, never an allocation — `getOrAllocate` throws on missing id); otherwise `getOrAllocate` with synthetic `{id: user_id, name: user_name}` → replace `user_name` (and `participants` display_name where applicable). Non-roster authors (dropped students, observers, Student View test account) allocate pseudonyms by design — fail-closed beats map purity.
- Body scrub per the decided matching rules: case-insensitive, word-boundary, longest-match-first, full names + first-name tokens, every pattern built through `escapeRegExp(name)`. Dedicated warning constant (distinct from `DEANON_DENIED_NOTE`) covering both unmapped-details and altered-quoted-text risks.
- Same on-disk map format (invariant: `getOrAllocate` untouched — no second allocation path).

**Execution note:** Test-first — the FERPA behavior is the spec; write the classification/scrub tests before the implementation.

**Test scenarios:**
- Happy path: student entry author → pseudonymized `user_name`; teacher author → verbatim.
- Edge cases: author absent from roster (dropped student) → pseudonymized; Student-View-authored entry → pseudonymized, not verbatim; null `user_id` entry → "Former participant", tool call succeeds; empty `message` unchanged.
- Failure paths: staff fetch truncated → authors still pseudonymized (fail-closed); student roster truncated → distinct truncation warning present.
- Body scrub: real name replaced with stable pseudonym; possessive ("Grace's" → "Student 3's"); case variant ("GRACE"); common-word name ("grace" the word survives, "Grace" the student doesn't — word-boundary + case handling documented); overlapping names ("Ana Maria" before "Ana"); a name with regex-special characters ("D'Angelo O'Brien-Smith") neither throws nor mismatches; teacher names untouched.
- Integration: pseudonyms match `list_users` pseudonyms for the same course, pinned to a shared real-student fixture (so non-roster map entries can't destabilize the assertion).

**Verification:** R3a-style regression — raw student names never appear anywhere in a serialized anonymized entry set.

- [x] **Unit 8: Discussion tools**

**Goal:** Discussions readable, creatable (draft), and fixable.

**Requirements:** R10

**Dependencies:** Units 2, 3, 7 (error shape / resolution mocks; trim helper; anonymization plumbing)

**Files:**
- Create: `src/tools/discussions.ts`
- Modify: `src/index.ts` (register)
- Test: `tests/tools/discussions.test.ts`

**Approach:**
- `list_discussions(course_identifier)` → `GET .../discussion_topics` (exclude announcements by default — Canvas already separates them), trimmed: `id, title, published, posted_at, discussion_type, locked, reply_count`.
- `get_discussion(course_identifier, topic_id, include_entries?)` → topic GET; entries via the paginated `/entries` endpoint (not `/view`, avoiding its 503-while-caching and 403 `require_initial_post` sharp edges for a teacher token — documented in description); entries pass through Unit 7 anonymization, then trim (`id, user_id, user_name, message, created_at, recent_replies` similarly anonymized). The **topic-level `message` runs through the same body scrub** when `anonymous=true` — teacher prose routinely names students — and the R3a-style regression asserts raw names absent from the full serialized result including the topic body. `anonymous` param + env gate + `warnings[]` per convention.
- `create_discussion(course_identifier, title, message, discussion_type?, delayed_post_at?)` → POST with explicit `published: false`; bypassCache. Body is NOT wrapped in `pageTemplates` chrome (stated decision — discussion topics, not wiki pages).
- `update_discussion(course_identifier, topic_id, title?, message?, ...)` → PUT partial; never sends `published: true`; `published: false` allowed (un-drafting stays manual in Canvas UI). **Refuses announcements**: checks the target's `is_announcement` and errors with a pointer to `update_announcement` — otherwise the announcement delay floor is bypassable cross-tool.

**Test scenarios:**
- Happy path: create sends `published: false`; list excludes announcements; get with entries anonymizes student authors.
- FERPA-override path: `anonymous: false` without the env flag → forced anonymous + `warnings[]` (standard triple).
- Error paths: entries fetch 403 → structured error naming the tool; `update_discussion` against an `is_announcement: true` topic → refused with pointer to `update_announcement`, zero PUTs.
- Integration: entry-author pseudonym matches the course map used by `list_users`.

**Verification:** no code path publishes a discussion; FERPA tests cover gate, override, and denial.

- [x] **Unit 9: Announcement tools**

**Goal:** Announcements listable and schedulable with a teacher-confirmed future post time — never immediately visible.

**Requirements:** R11

**Dependencies:** Units 2, 3, 8 (Unit 8 creates `src/tools/discussions.ts`, which this unit extends)

**Files:**
- Modify: `src/tools/discussions.ts` (announcements are discussion topics; same module), `src/index.ts`
- Test: `tests/tools/discussions.test.ts` (announcement describe block)

**Approach:**
- `list_announcements(course_identifier)` → `GET .../discussion_topics?only_announcements=true` (windowless; includes `post_delayed`), trimmed + each item's `delayed_post_at`/`posted_at`/`workflow_state` so scheduled state is visible.
- `create_announcement(course_identifier, title, message, delayed_post_at)` → `delayed_post_at` **required**; server-side validation, all fail-closed before any Canvas call: parseable ISO-8601 **with an explicit offset or `Z`** (offset-less strings rejected — local-vs-UTC parsing divergence can defeat the floor), AND ≥ now + `MIN_ANNOUNCEMENT_DELAY_MINUTES` (default 30, env-overridable with a clamped ≥5-minute lower bound — the floor is also the clock-skew buffer). POST with `is_announcement: true`; **post-write assertion**: response `workflow_state` must be `post_delayed` — if `active`, attempt a best-effort DELETE of the just-created topic, then raise a loud error that always carries the `topic_id` and an explicit remediation instruction ("announcement {id} went live immediately — deleted it / delete it in Canvas now"), so clock skew can't pass silently *and* the bad state doesn't stand. Summary echoes "goes live at {time}".
- `update_announcement(course_identifier, topic_id, title?, message?, delayed_post_at?)` → PUT; a new `delayed_post_at` obeys the same offset + floor rules; null/empty `delayed_post_at` rejected at the schema level (Canvas clears the delay on empty → immediate post); same post-write `workflow_state` assertion when a time is set; description warns edits after the post time are live edits.

**Test scenarios:**
- Happy path: valid offset-carrying future timestamp creates; summary contains the scheduled time verbatim; response `post_delayed` passes the post-write assertion.
- Error paths: missing `delayed_post_at` → validation error naming the param; past timestamp → error naming the floor; timestamp 10 minutes out with 30-minute floor → rejected; unparseable string → rejected; **offset-less ISO string → rejected** (each with zero POSTs asserted); `update_announcement` with `delayed_post_at: null`/`""` → rejected; mocked Canvas response returning `workflow_state: "active"` → best-effort DELETE issued, loud error still raised with the topic_id in the message (asserted even when the DELETE itself fails).
- Edge cases: env override `CANVAS_MCP_MIN_ANNOUNCEMENT_DELAY_MINUTES=5` accepts a 10-minute-out timestamp; override below the 5-minute clamp is clamped.
- Integration: `list_announcements` fixture includes a `post_delayed` item and it appears in output with its scheduled time.

**Verification:** no test path can create an immediately-visible announcement; the fail-closed branches (missing/past/near/offset-less/null) and the post-write `workflow_state` assertion all have explicit coverage.

- [x] **Unit 10: Registration, docs, invariants sweep, version**

**Goal:** Everything is wired, documented, and the stated rules match the new behavior.

**Requirements:** R12; success criteria (skills audit, dogfooding gate prep)

**Dependencies:** Units 1–9

**Files:**
- Modify: `src/index.ts` (SERVER_VERSION bump + registrations), `package.json` (version), `README.md` (tool-reference rows for all ~15 new tools; note trimmed-shape defaults and `include_description`), `docs/MIGRATION.md` (new-tools section for teaching-AIssitant; note `list_assignments`/`list_submissions` trimmed output + opt-in), `CLAUDE.md` (invariant #4 wording → "grading writes resolve with bypassCache at least once per invocation"; add R3a anonymize-before-trim to the FERPA invariant; add announcements-delay rule to the no-auto-publish invariant), `manifest.json` if tool listings appear there
- Test: `npm run validate:manifest`

**Approach:**
- Registration order keeps anonymizer-dependent tools after anonymizer init (existing pattern).
- MIGRATION.md records the skills output-field audit results (the audit itself ran as Unit 3's precondition); this unit re-verifies against the final shipped shapes before packaging.

**Test scenarios:** Test expectation: none — docs/wiring; covered by the full suite + manifest validation.

**Verification:** `npm run build && npm test && npm run validate:manifest` all green; README row count matches registered tool count.

## System-Wide Impact

- **Interaction graph:** `resolveCourseId` change touches every tool; its new error is recoverable-by-design (candidates in message). Asymmetry worth knowing: course-code resolution is enrollment-scoped, so account courses reachable only via `list_account_courses` never resolved correctly by code — the old path silently misrouted them to an enrolled course; the new path errors with guidance to use the numeric id. Numeric-id usage doesn't populate `courseIdToCode`, which would degrade `download_submission_attachment` directory naming and `list_user_enrollments` code display — mitigated by seeding the reverse map from `list_courses`/`get_course_details` responses (Unit 2). `jsonResult` change touches every tool result and all 14 test files (~150 assertion sites) via the shared parse helper.
- **Error propagation:** all new tools use `safeHandler` → structured tool errors, never MCP protocol exceptions; announcement validation errors fire before any Canvas call.
- **State lifecycle risks:** anonymizer map is append-only and shared — Unit 7 must not introduce a second allocation path (it reuses `getOrAllocate`). Bulk-grade keeps its honest `unprocessed[]` accounting.
- **API surface parity:** existing tool names/params frozen; additions only. `code_api/` (execute_typescript surface) intentionally unchanged — its consumers are user scripts, not skills.
- **Integration coverage:** cross-map pseudonym stability (list_users ↔ discussions) is asserted, not assumed; bulk-grade single-resolution asserted via mock call counts.
- **Unchanged invariants:** FERPA env gate (`CANVAS_MCP_ALLOW_DEANONYMIZE`), never-auto-publish, snake_case parity, `.mcpb` distribution via GitHub Releases.

## Risks & Dependencies

| Risk | Mitigation |
|------|------------|
| Removing `structuredContent` behaves unexpectedly in some MCP client | Protocol-safe per SDK (only required when `outputSchema` is declared — none is); dogfooding gate in Claude Desktop + Claude Code before packaging; change is one function — trivially revertible |
| `search_term` semantics on the enrollment-scoped courses endpoint are undocumented | Resolution treats matching as client-side over the paginated enrollment list; candidate quality and >50-course coverage verified against real Canvas during dogfooding |
| Student-roster truncation makes the body scrub fail open (unfetched names survive in bodies) | Distinct truncation warning on the response; paginated fetch minimizes occurrence; documented as best-effort alongside the scrub warning |
| R5's stricter matching breaks a skill that relied on fuzzy resolution | Error lists candidates so the model self-corrects in-session; MIGRATION.md flags it; skills audit checks for hardcoded near-miss names |
| Trimmed outputs remove a field a skill's prompt references | Unit 10 output-field audit against teaching-AIssitant before packaging; `get_*` full-fidelity tools remain the escape hatch |
| Discussion body scrub gives false confidence (nicknames, misspellings survive) | Standing `warnings[]` on every anonymized entry payload; documented as best-effort in tool description |
| Franklin adopts New Quizzes and classic tools miss them | Documented limitation in descriptions + best-effort detection note; New-Quizzes API support is a known, scoped follow-up |
| Roster fetch per discussion read adds latency | One paginated users call per invocation — same cost class as `list_users`; acceptable for FERPA correctness; no caching by design |
| ~15 new tools ship with zero field exposure | Dogfooding release gate: every new tool exercised against a real Franklin course, create→inspect→fix once per domain, before `npm run build:mcpb` |

## Documentation / Operational Notes

- **Dogfooding gate (release criterion, not best-effort):** before packaging, run each domain's loop against a real course; verify payload sizes (a ~25-assignment `list_assignments` and a ~20-student `list_submissions`) and the Claude Desktop behavior of the new `jsonResult` shape.
- Version: 0.3.17 → 0.4.0 (new tool surface + output-shape change).
- Distribute via GitHub Releases per README; `.mcpb` stays gitignored.
- After landing: capture learnings (`delayed_post_at` semantics, structuredContent client behavior, discussion-entry anonymization pattern) via `/ce-compound` — `docs/solutions/` is nearly empty and this pass generates exactly the knowledge it lacks.

## Sources & References

- **Origin document:** [docs/brainstorms/2026-08-04-token-efficiency-and-utility-requirements.md](../brainstorms/2026-08-04-token-efficiency-and-utility-requirements.md)
- Related code: `src/canvasClient.ts` (resolveCourseId), `src/tools/toolHelpers.ts` (jsonResult), `src/anonymizer.ts` (classifyRole/getOrAllocate), `src/tools/grading.ts` (writeGrade)
- Institutional learning: `docs/solutions/conventions/franklin-page-template-chrome-convention-2026-05-24.md`
- External docs: canvas.instructure.com/doc/api — discussion_topics, announcements, quiz_questions, quizzes, new_quizzes, assignments, modules (migrating to developerdocs.instructure.com after 2026-07-01)
