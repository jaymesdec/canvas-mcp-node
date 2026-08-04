---
title: "FERPA name leak in role-less Canvas author data (submission comments, discussion entries)"
date: 2026-08-04
category: security-issues
module: anonymizer
problem_type: security_issue
component: authentication
severity: critical
symptoms:
  - "anonymous: true still returned real student full names in submission_comments[].author_name"
  - "Discussion entry and reply author names (user_name) were not pseudonymized despite anonymous: true"
  - "classifyRole(user) returns \"unknown\" for Canvas UserDisplay/discussion-entry author shapes (no role/enrollments field present)"
  - "unknownRolePolicy: \"teacher\" caused every unknown-role author to be treated as staff and left unredacted (fail-open)"
  - "Name-scrub regexes built with \\b silently skipped names with accented or punctuated edges (René, Sammy Jr.)"
root_cause: missing_permission
resolution_type: code_fix
related_components:
  - service_object
tags:
  - ferpa
  - anonymization
  - canvas-api
  - fail-open
  - roster-classification
  - regex-word-boundary
  - discussions
  - submission-comments
---

# FERPA name leak in role-less Canvas author data (submission comments, discussion entries)

> Note on `component: authentication` — this repo is a TypeScript MCP server, not Rails; `authentication` is the least-bad enum fit for an identity-classification defect (who counts as staff vs. student).

## Problem

Two related fail-open defects in the FERPA gate, both rooted in the same Canvas API property: several payload shapes carry **no role data at all**, so role-based anonymization had nothing to key off of. Real student names shipped in output that claimed `anonymized: true`.

## Symptoms

- With `anonymous: true`, `list_submissions` returned real student names in `submission_comments[].author_name`.
- Discussion entry and reply authors (`user_name`) would have leaked the same way (caught at plan review before the tools shipped).
- Names with non-word edge characters ("René", "Sammy Jr.", trailing apostrophes) survived the body-text scrub verbatim — no error, no warning.

## What Didn't Work

- **Relying on `classifyRole` alone.** Canvas discussion entries are `{user_id, user_name}`; submission-comment authors are bare `UserDisplay` objects (id, display_name, avatar). `classifyRole()` inspects `user.role` and `user.enrollments[]` — with neither present, every author classifies as `"unknown"`. There is nothing to classify.
- **`unknownRolePolicy: "teacher"` for comment authors** (`src/anonymizer.ts` `anonymizeSubmission`, preserved-attribution intent). Since production comment authors *never* carry role data, `unknown → preserve verbatim` meant every student comment author's real name shipped. This path still exists in `anonymizer.ts` but is superseded — the real gate now runs afterward in `submissions.ts`.
- **`\b` word boundaries in the name scrubber.** JS `\b` anchors on `\w = [A-Za-z0-9_]`, so a name starting/ending in a character outside that class has no boundary there. Verified: `/\bRené\b/.test("René posted")` → `false`. The name is present in the text and the scrub silently leaves it.
- **Cross-call roster caching** (rejected by design): a stale roster (TA removed mid-semester) is itself a leak vector, so classification data is fetched per invocation.
- **Vacuous regression fixtures.** The original whole-result FERPA test passed because its fixture authors carried classifiable roles (`role: "student"`) — a shape production never returns for these objects, so the broken `unknown` branch never executed under test.

## Solution

When a payload shape has no role data, classify against an explicit **per-invocation staff-id set** instead of `classifyRole`. Staff keep real attribution; everyone else — dropped students, Student View, unrecognized enrollment types — is pseudonymized through the existing per-course map. Applied identically in three places: discussion entries/topic authors (`src/tools/discussionAnonymizer.ts`), submission-comment authors (`src/tools/submissions.ts` `anonymizeNonStaffCommentAuthors`), including embedded submissions in `list_assignments`.

Build the set fresh every call (`src/tools/roster.ts`):

```typescript
export async function buildStaffIdSet(canvas: CanvasClient, courseId: number): Promise<Set<string>> {
  const { items } = await canvas.getPaginated<CanvasRosterUser>(
    `/api/v1/courses/${courseId}/users`,
    { params: { "enrollment_type[]": ["teacher", "ta", "designer"] } },
  );
  return new Set(items.map((user) => String(user.id)));
}
```

Classify against the set, fail closed on unknown, placeholder on missing id (`discussionAnonymizer.ts`):

```typescript
if (entry.user_id === undefined || entry.user_id === null) {
  transformed.user_name = FORMER_PARTICIPANT_NAME;   // never getOrAllocate (throws on missing id)
} else if (!scrubber.staffIdSet.has(String(entry.user_id))) {
  const { pseudonym } = await deps.anonymizer.getOrAllocate(courseId, {
    id: entry.user_id,
    name: typeof entry.user_name === "string" ? entry.user_name : undefined,
  });
  transformed.user_name = pseudonym;
}
```

Staff-fetch failure propagates (tool errors rather than proceeding unclassified — fail closed). Student-roster truncation, which only affects body-text scrubbing, is fail-open by design and surfaces a distinct `warnings[]` entry instead.

Body-text scrubbing uses lookarounds instead of `\b`, longest-match-first, everything through `escapeRegExp`, replacement via callback so `$` in a pseudonym can't misfire (`buildNameScrubber`):

```typescript
const patterns = tokens.map(({ token, pseudonym }) => ({
  regex: new RegExp(`(?<![A-Za-z0-9_])${escapeRegExp(token)}(?![A-Za-z0-9_])`, "gi"),
  pseudonym,
}));
```

Ordering invariant across all of it: **anonymize first, trim second** — response field-trimming always consumes the anonymizer's output, never the raw payload.

## Why This Works

The root cause was an authorization-classification gap: absent role data, the code granted real-name attribution by default. The staff-id set replaces the missing role signal with an explicit, freshly-fetched source of truth, and inverts the default — unknown means student, so every failure mode (missing data, dropped enrollment, truncated staff page) degrades toward *more* anonymization, never less. The lookaround boundary `(?<![A-Za-z0-9_])…(?![A-Za-z0-9_])` expresses what `\b` only approximates: "not adjacent to a word character," which holds regardless of what character the name itself starts or ends with.

```
/\bRené\b/.test("René posted")                              // false — LEAKS
/(?<![A-Za-z0-9_])René(?![A-Za-z0-9_])/.test("René posted") // true  — scrubbed
```

## Prevention

- **Fixtures must match the endpoint's real shape.** If you have to add `role:` or `enrollments:` to an author fixture to make a FERPA test pass, the fixture is lying about production and the test is vacuous. Test fixtures for these paths carry only `{id, name}` (see `tests/tools/discussionAnonymizer.test.ts`).
- **Assert on the serialized whole result.** `JSON.stringify` the full payload and `not.toContain` every fragment of every fixture name (first, last, hyphenated segments, nested replies). Field-by-field assertions miss leaks in fields the author didn't think to check.
- **Keep a boundary-hostile name in every roster fixture** — the suite uses `"D'Angelo O'Brien-Smith"`, `"René Dubois"`, `"Sammy Jr."`, `"Émile Zola"` to pin the `escapeRegExp` + lookaround behavior.
- **Test the fail-closed/fail-open asymmetry explicitly**: staff-fetch failure → `rejects.toThrow`; student-roster truncation → `warnings[]` entry present.
- **Test the null-id placeholder path** asserts both the placeholder appears and the on-disk map gained no entry.
- **Whenever matching human names in free text, default to lookaround boundaries** — `\b` fails on any name with a non-`[A-Za-z0-9_]` edge, which real rosters always contain.

## Related Issues

- Origin plan: [docs/plans/2026-08-04-001-feat-token-efficiency-utility-pass-plan.md](../../plans/2026-08-04-001-feat-token-efficiency-utility-pass-plan.md) (R3a, R10, Units 3/7/8)
- Shipping PR: [awesome-town/canvas-mcp-node#1](https://github.com/awesome-town/canvas-mcp-node/pull/1) — "FERPA hardening" section summarizes this fix
- Implementation: `src/tools/roster.ts`, `src/tools/discussionAnonymizer.ts`, `src/tools/submissions.ts`, `src/anonymizer.ts` (`classifyRole`, `getOrAllocate`)
- Related principle (fail loudly, never silently): [../conventions/franklin-page-template-chrome-convention-2026-05-24.md](../conventions/franklin-page-template-chrome-convention-2026-05-24.md)
