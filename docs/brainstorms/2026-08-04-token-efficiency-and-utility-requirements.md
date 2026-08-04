---
date: 2026-08-04
topic: token-efficiency-and-utility
---

# Canvas MCP: Token Efficiency + Utility Pass (pre-distribution)

## Problem Frame

The server (v0.3.17) is about to be distributed to Franklin School teachers via `.mcpb`, with the explicit goal of not needing another update after handoff. A detailed code review found three categories of pre-distribution risk:

1. **Token waste** — several list tools return raw, unfiltered Canvas API objects (full HTML assignment descriptions, avatar/media metadata on submission comments), and every tool result double-sends its payload (pretty-printed text + duplicated `structuredContent`). Long grading or curriculum sessions burn context unnecessarily and can degrade before the work is done.
2. **A silent-misroute risk** — course resolution falls back to Canvas's first fuzzy-search result when no exact match exists, and grade writes go through that same path. A teacher typo could grade the wrong course with no error.
3. **Missing CRUD symmetry** — teachers can create pages/quizzes/modules/rubrics but cannot create or edit assignments, inspect or fix quizzes after creation, edit modules, or work with discussions/announcements at all. Hitting these walls is what would force a post-distribution update.

## Requirements

**Token efficiency (response payloads)**

- R1. `list_assignments` returns a trimmed per-assignment shape by default (identity, name, due date, points, publish state, submission types, whether a rubric exists). Full HTML `description` is returned only on explicit request; `get_assignment_details` remains the full-fidelity path.
- R2. `list_submissions` trims embedded objects: submission comments reduce to author (anonymized per the FERPA gate), comment text, and timestamp; embedded `user` objects and attachment entries drop avatar URLs, media metadata, preview URLs, and similar noise. Existing parameter names and defaults are unchanged (Python-signature parity).
- R3. Every tool response is audited so that what reaches the model is an explicit field mapping rather than a raw Canvas object — following the existing `displayCourse()` pattern — except where full fidelity is the tool's purpose (e.g., `get_page_content` body, `get_assignment_details` description, `get_rubric_details` criteria).
- R3a. **Trim ordering is pinned to the FERPA gate**: for any tool routed through the anonymizer, the field-mapping/trim step operates on the anonymizer's *output*, never on the raw Canvas object. Anonymization and role classification always consume the untrimmed payload (including `user.role` / `user.enrollments`), and trimming must never run upstream of the FERPA gate. A regression test asserts that with `anonymous=true` the trimmed payload contains pseudonymized names/emails, never raw values.
- R4. `jsonResult` sends a single representation of the payload: compact JSON (no pretty-print indentation) and no duplicated `structuredContent` block. Summaries stay.

**Correctness and safety**

- R5. Course resolution never guesses: when an identifier has **no exact `course_code` or name match, or more than one exact match** (e.g., the same course_code reused across academic years), the tool returns an error listing the candidate courses (code, id, name, term, workflow_state) so the caller can select by numeric id, instead of silently using the first result. Applies to reads and writes alike; write paths keep the cache bypass.
- R6. `bulk_grade_submissions` resolves the course identifier exactly once per invocation instead of once per student (removes the current N-lookups-per-run behavior that eats API rate limit mid-grading).

**New tools: CRUD symmetry**

- R7. Assignments: `create_assignment` and `update_assignment`. Created assignments are unpublished (never-auto-publish rule). Update covers the fields teachers realistically fix: name, description, due/lock/unlock dates, points, submission types.
- R8. Quizzes: `list_quizzes`, `get_quiz` (including its questions), `update_quiz`, `update_quiz_question`, and `delete_quiz_question`, so a quiz — including its most likely in-session mistake, a bad question — can be inspected and fixed after `create_quiz` without leaving Claude.
- R9. Modules: `update_module` (rename, reposition, prerequisites, unlock date), `delete_module_item`, and `delete_module` (following the existing `delete_page` precedent for cleaning up orphan/duplicate structures), so module-building mistakes are recoverable in-session.

**New tools: discussions and announcements**

- R10. Discussions: `list_discussions`, `get_discussion` (topic + entries), `create_discussion`, and `update_discussion`. Created discussions are unpublished. Discussion entries contain student-authored content — the FERPA anonymization gate applies to entry authors. Note: Canvas discussion entries expose only flat `user_id`/`user_name` fields (no embedded enrollments), so role classification for entry authors must resolve roles via course enrollment/roster data (e.g., a cached roster fetch) so student authors are anonymized while teacher entries keep attribution. The on-disk map format is unchanged; the classification pathway is new plumbing the plan must budget for.
- R11. Announcements: `list_announcements`, `create_announcement`, and `update_announcement` (needed at minimum to fix a scheduled post time before it fires). Because Canvas announcements have no unpublished state, `create_announcement` requires an explicit, teacher-confirmed `delayed_post_at` timestamp with a minimum-delay floor (exact floor set during planning), and the tool's response summary must echo the scheduled visibility time so the teacher always knows when it goes live.

**Cross-cutting (applies to all new tools)**

- R12. All new tools follow the existing conventions from `CLAUDE.md`: snake_case names/params, `safeHandler` wrapping, cache bypass on writes, `account_id` defaulting where account-scoped, tests (happy path, error path, FERPA-override path where applicable), README tool-reference rows, and `docs/MIGRATION.md` notes for skills that should learn about them.

## Success Criteria

- A `list_assignments` call on a real ~25-assignment Franklin course produces a payload several times smaller than today (HTML descriptions no longer ride along by default).
- A full grading session (list users → list submissions → rubric-grade a class of ~20) completes without context exhaustion in Claude Desktop/Code.
- An ambiguous or typo'd course **code or name** can never produce a write to the wrong course — it produces an error with candidates. (Numeric ids remain trusted as-is, matching current behavior.)
- A teacher can complete the create → inspect → fix loop for assignments, quizzes (including individual questions), modules, pages, discussions, and announcements without leaving Claude.
- No existing tool name or parameter changes, **and no removal of output fields that `teaching-AIssitant` skills actually consume**: an audit of the skills' prompts against the proposed trim lists confirms current skills keep working unmodified.
- Nothing created by any tool is ever student-visible without either a manual teacher publish or (announcements only) a teacher-confirmed schedule whose visibility time the tool echoed back at creation.
- **Dogfooding gate**: every new tool (R7–R11) is exercised end-to-end against a real Franklin course by the maintainer in a real teaching workflow before the `.mcpb` is packaged, with the create → inspect → fix loop demonstrated at least once per domain.

## Scope Boundaries

- **No consolidation of the three grading tools** (`grade_submission`, `grade_with_rubric`, `grade_submission_with_rubric`) — Python-signature parity for existing skills outweighs the schema-surface savings.
- **No renames or behavior changes to existing tool parameters** — same reason.
- No gradebook/analytics, calendar, sections, or enrollment-management tools.
- No changes to the `execute_typescript` sandbox surface or the lifted `code_api/`.
- No auto-publish anywhere, including the new tools.

## Key Decisions

- **Trim by default, opt in to full payloads**: matches the existing `displayCourse`/`list_pages` pattern already in the codebase; the model can always fetch full detail through the single-item `get_*` tools.
- **Anonymize first, trim second**: the trim step consumes the anonymizer's output for every FERPA-scoped tool, so token-efficiency work can never weaken the FERPA gate (R3a).
- **Fail loudly on ambiguous course matches — including multiple exact matches**: for a tool distributed to non-developers with no maintainer on call, a clear error the model can recover from beats a silent guess that can misroute grades. Repeated course codes across academic years are the most common real ambiguity.
- **Keep existing signatures frozen; new capability = new tools**: durability for the already-distributed skills. Compatibility covers output fields skills consume, not just names/params.
- **Announcements require a teacher-confirmed future post time**: Canvas has no draft state for announcements, so an explicit teacher-approved `delayed_post_at` with a minimum-delay floor (plus echoed visibility time) is the mechanism that preserves the spirit of the never-auto-publish rule. The success criterion is amended accordingly rather than pretending delay equals manual publish.
- **Include discussions/announcements now** (user decision): most common "teachers will ask" gap; adding it pre-distribution avoids the very post-distribution update this pass is meant to prevent.
- **Ship nothing untested against a real course**: the ~12 new tools are themselves the top update-forcing risk, so the dogfooding gate is a release criterion, not best-effort.

## Dependencies / Assumptions

- Assumption: no current consumer depends on `structuredContent` being present in tool results (the MCP tools declare no `outputSchema`). Verify against Claude Desktop behavior during planning before removing it.
- Assumption: the anonymizer's existing on-disk map format covers discussion-entry authors; the *classification* pathway (roster-based role lookup, per R10) is new work, not a reuse.

## Outstanding Questions

### Deferred to Planning

- [Affects R1–R3][Technical] Exact trimmed field list per tool — verify against real Canvas API responses rather than assuming.
- [Affects R1–R4][Technical] Audit `teaching-AIssitant` skill prompts for dependencies on specific output fields or formats before finalizing trim lists (compatibility criterion covers outputs, not just signatures).
- [Affects R4][Technical] Confirm removing `structuredContent` (vs. removing the text duplication instead) is safe in Claude Desktop and Claude Code clients.
- [Affects R8][Technical] Whether quiz questions come back inline on `get_quiz` or need a `list_quiz_questions` companion (Canvas API shape decides).
- [Affects R8][Needs research] Confirm which quiz engine Franklin courses use (Classic vs New Quizzes). The Classic API (`/api/v1/.../quizzes`) does not list or edit New Quizzes; decide whether R8 must cover New Quizzes or explicitly document the limitation.
- [Affects R10][Technical] Decide handling for student names embedded in discussion entry *bodies* (peer @-mentions, self-identification): scrub against the anonymization map, emit a `warnings[]` entry, or document as an accepted limitation.
- [Affects R11][Needs research] Confirm the Canvas announcements API supports `delayed_post_at` on create for course announcements, and what the minimum-viable "not yet visible" mechanism is. If the delay mechanism can't be confirmed, `create_announcement` fails closed (rejects creation) rather than posting immediately. Also decide the list endpoint: `/api/v1/announcements` (requires `context_codes`, defaults to a ~14-day lookback window) vs `/courses/:id/discussion_topics?only_announcements=true` (no window) — `list_announcements` must not be silently time-windowed.
- [Affects R11][User decision] Set the minimum-delay floor for `delayed_post_at` (how much review runway before an announcement can go live).
- [Affects R5][Technical] Error-message shape for the candidate-course list (count cap, fields shown) so the model reliably self-corrects. Consider whether `sis_course_id` joins the exact-match set.

## Next Steps

-> `/ce-plan` for structured implementation planning
