import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { buildMockCanvas, type FakeResponse } from "../_helpers/mockCanvas.js";
import { Anonymizer } from "../../src/anonymizer.js";
import { fetchStudentRoster } from "../../src/tools/roster.js";
import {
  DISCUSSION_SCRUB_NOTE,
  FORMER_PARTICIPANT_NAME,
  ROSTER_TRUNCATED_NOTE,
  anonymizeDiscussionEntries,
  buildCourseScrubber,
  buildNameScrubber,
  escapeRegExp,
  type DiscussionEntryLike,
} from "../../src/tools/discussionAnonymizer.js";

const COURSE_ID = 777;

const STAFF_PAGE: FakeResponse = {
  status: 200,
  data: [{ id: 5000, name: "Mr. Smith" }],
};

const STUDENT_ROSTER = [
  { id: 1001, name: "Grace Park" },
  { id: 1002, name: "Ana Maria" },
  { id: 1003, name: "D'Angelo O'Brien-Smith" },
];

const STUDENT_PAGE: FakeResponse = { status: 200, data: STUDENT_ROSTER };

let anonRoot: string;
let anonymizer: Anonymizer;
beforeEach(async () => {
  anonRoot = await fs.mkdtemp(path.join(os.tmpdir(), "canvas-anon-disc-"));
  anonymizer = new Anonymizer({ rootDir: anonRoot });
  await anonymizer.init();
});
afterEach(async () => {
  await fs.rm(anonRoot, { recursive: true, force: true });
});

function pageWithNext(url: string, page: number, data: unknown[]): FakeResponse {
  return {
    status: 200,
    data,
    headers: { link: `<https://canvas.example.com${url}?page=${page + 1}>; rel="next"` },
  };
}

describe("escapeRegExp", () => {
  it("escapes every regex metacharacter", () => {
    expect(escapeRegExp("a.b*c+d?e^f$g(h)i|j[k]l{m}n\\o")).toBe(
      "a\\.b\\*c\\+d\\?e\\^f\\$g\\(h\\)i\\|j\\[k\\]l\\{m\\}n\\\\o",
    );
  });

  it("leaves apostrophes and hyphens intact", () => {
    expect(escapeRegExp("D'Angelo O'Brien-Smith")).toBe("D'Angelo O'Brien-Smith");
  });
});

describe("buildNameScrubber", () => {
  const scrub = buildNameScrubber([
    { name: "Grace Park", pseudonym: "Student 1" },
    { name: "Ana Maria", pseudonym: "Student 2" },
    { name: "Park Min", pseudonym: "Student 3" },
    { name: "D'Angelo O'Brien-Smith", pseudonym: "Student 4" },
  ]);

  it("replaces full names and bare first names with the same pseudonym", () => {
    expect(scrub("Grace Park said hi")).toBe("Student 1 said hi");
    expect(scrub("Grace said hi")).toBe("Student 1 said hi");
  });

  it("handles possessives via the word boundary", () => {
    expect(scrub("I liked Grace's essay")).toBe("I liked Student 1's essay");
  });

  it("matches case variants", () => {
    expect(scrub("GRACE PARK was here")).toBe("Student 1 was here");
    expect(scrub("GRACE was here")).toBe("Student 1 was here");
  });

  it("replaces 'grace' the common word too — accepted fail-closed tradeoff of case-insensitive matching", () => {
    expect(scrub("saved by the grace of the deadline")).toBe(
      "saved by the Student 1 of the deadline",
    );
  });

  it("respects word boundaries: 'Park' not replaced inside 'parking'", () => {
    expect(scrub("meet in the parking lot")).toBe("meet in the parking lot");
    expect(scrub("I saw Park today")).toBe("I saw Student 3 today");
  });

  it("applies longest match first: 'Ana Maria' never becomes 'Student 2 Maria'", () => {
    expect(scrub("Ana Maria wrote this")).toBe("Student 2 wrote this");
    expect(scrub("Ana wrote this")).toBe("Student 2 wrote this");
  });

  it("neither throws nor mismatches on regex-special names", () => {
    expect(scrub("D'Angelo O'Brien-Smith replied")).toBe("Student 4 replied");
    expect(scrub("D'Angelo replied")).toBe("Student 4 replied");
  });

  it("leaves names outside the replacement list untouched", () => {
    expect(scrub("Mr. Smith posted the rubric")).toBe("Mr. Smith posted the rubric");
  });

  describe("non-word boundary names (\\b would fail at accented/punctuation edges)", () => {
    const accentScrub = buildNameScrubber([
      { name: "René Dubois", pseudonym: "Student 5" },
      { name: "Sammy Jr.", pseudonym: "Student 6" },
      { name: "Émile Zola", pseudonym: "Student 7" },
    ]);

    it("scrubs a name ending in an accented letter mid-sentence", () => {
      expect(accentScrub("I think René made a great point")).toBe(
        "I think Student 5 made a great point",
      );
      expect(accentScrub("I agree with René Dubois here")).toBe("I agree with Student 5 here");
    });

    it("scrubs a name ending in a period", () => {
      expect(accentScrub("Sammy Jr. wrote the intro")).toBe("Student 6 wrote the intro");
      expect(accentScrub("Great job Sammy Jr.")).toBe("Great job Student 6");
    });

    it("scrubs accented-boundary names at string start and end", () => {
      expect(accentScrub("Émile Zola said so")).toBe("Student 7 said so");
      expect(accentScrub("That quote is from Émile")).toBe("That quote is from Student 7");
      expect(accentScrub("René")).toBe("Student 5");
    });

    it("still respects word boundaries around the scrubbed token", () => {
      expect(accentScrub("Renée is a different student")).toBe("Renée is a different student");
    });
  });

  it("returns empty text unchanged", () => {
    expect(scrub("")).toBe("");
  });
});

describe("anonymizeDiscussionEntries", () => {
  it("pseudonymizes student authors and preserves staff authors verbatim", async () => {
    const { client, requests } = buildMockCanvas([STAFF_PAGE, STUDENT_PAGE]);
    const entries: DiscussionEntryLike[] = [
      { id: 1, user_id: 1001, user_name: "Grace Park", message: "Hello", created_at: "2026-05-01T00:00:00Z" },
      { id: 2, user_id: 5000, user_name: "Mr. Smith", message: "Welcome", created_at: "2026-05-01T01:00:00Z" },
    ];
    const result = await anonymizeDiscussionEntries({ canvas: client, anonymizer }, COURSE_ID, entries);

    expect(requests[0]?.url).toBe(`/api/v1/courses/${COURSE_ID}/users`);
    expect(requests[0]?.params).toMatchObject({ "enrollment_type[]": ["teacher", "ta", "designer"] });
    expect(requests[1]?.url).toBe(`/api/v1/courses/${COURSE_ID}/users`);
    expect(requests[1]?.params).toMatchObject({ "enrollment_type[]": ["student"] });

    expect(result.entries[0]?.user_name).toBe("Student 1");
    expect(result.entries[1]?.user_name).toBe("Mr. Smith");
    expect(result.warnings).toContain(DISCUSSION_SCRUB_NOTE);
  });

  it("pseudonymizes authors absent from every roster (dropped students, Student View) — fail closed", async () => {
    const { client } = buildMockCanvas([STAFF_PAGE, STUDENT_PAGE]);
    const entries: DiscussionEntryLike[] = [
      { id: 1, user_id: 9999, user_name: "Dropped Dan", message: "" },
      { id: 2, user_id: 8888, user_name: "Test Student", message: "" },
    ];
    const result = await anonymizeDiscussionEntries({ canvas: client, anonymizer }, COURSE_ID, entries);

    expect(result.entries[0]?.user_name).toMatch(/^Student \d+$/);
    expect(result.entries[1]?.user_name).toMatch(/^Student \d+$/);
    expect(result.entries[1]?.user_name).not.toBe("Test Student");
  });

  it("renders 'Former participant' for null user_id without allocating a map entry", async () => {
    const { client } = buildMockCanvas([STAFF_PAGE, STUDENT_PAGE]);
    const entries: DiscussionEntryLike[] = [
      { id: 3, user_id: null, user_name: "Ghost User", message: "" },
    ];
    const result = await anonymizeDiscussionEntries({ canvas: client, anonymizer }, COURSE_ID, entries);

    expect(result.entries[0]?.user_name).toBe(FORMER_PARTICIPANT_NAME);
    expect(JSON.stringify(result.entries)).not.toContain("Ghost User");

    const map = await anonymizer.loadMap(COURSE_ID);
    expect(Object.keys(map?.students ?? {}).sort()).toEqual(["1001", "1002", "1003"]);
  });

  it("leaves an empty message unchanged", async () => {
    const { client } = buildMockCanvas([STAFF_PAGE, STUDENT_PAGE]);
    const entries: DiscussionEntryLike[] = [
      { id: 1, user_id: 1001, user_name: "Grace Park", message: "" },
    ];
    const result = await anonymizeDiscussionEntries({ canvas: client, anonymizer }, COURSE_ID, entries);
    expect(result.entries[0]?.message).toBe("");
  });

  it("scrubs roster names out of message bodies with pseudonyms stable across author and body", async () => {
    const { client } = buildMockCanvas([STAFF_PAGE, STUDENT_PAGE]);
    const entries: DiscussionEntryLike[] = [
      {
        id: 1,
        user_id: 1001,
        user_name: "Grace Park",
        message: "I agree with Ana Maria, and D'Angelo O'Brien-Smith made Grace's point too.",
      },
    ];
    const result = await anonymizeDiscussionEntries({ canvas: client, anonymizer }, COURSE_ID, entries);

    expect(result.entries[0]?.user_name).toBe("Student 1");
    expect(result.entries[0]?.message).toBe(
      "I agree with Student 2, and Student 3 made Student 1's point too.",
    );
  });

  it("leaves teacher names in bodies untouched by the scrub", async () => {
    const { client } = buildMockCanvas([STAFF_PAGE, STUDENT_PAGE]);
    const entries: DiscussionEntryLike[] = [
      { id: 1, user_id: 1001, user_name: "Grace Park", message: "Thanks Mr. Smith!" },
    ];
    const result = await anonymizeDiscussionEntries({ canvas: client, anonymizer }, COURSE_ID, entries);
    expect(result.entries[0]?.message).toBe("Thanks Mr. Smith!");
  });

  it("recursively anonymizes recent_replies (authors and bodies)", async () => {
    const { client } = buildMockCanvas([STAFF_PAGE, STUDENT_PAGE]);
    const entries: DiscussionEntryLike[] = [
      {
        id: 1,
        user_id: 5000,
        user_name: "Mr. Smith",
        message: "Reply to your partner.",
        recent_replies: [
          {
            id: 11,
            user_id: 1002,
            user_name: "Ana Maria",
            message: "Grace Park +1",
            recent_replies: [
              { id: 111, user_id: null, user_name: "Ghost User", message: "Ana was right" },
            ],
          },
        ],
      },
    ];
    const result = await anonymizeDiscussionEntries({ canvas: client, anonymizer }, COURSE_ID, entries);

    const reply = result.entries[0]?.recent_replies?.[0];
    expect(reply?.user_name).toBe("Student 2");
    expect(reply?.message).toBe("Student 1 +1");
    const nested = reply?.recent_replies?.[0];
    expect(nested?.user_name).toBe(FORMER_PARTICIPANT_NAME);
    expect(nested?.message).toBe("Student 2 was right");
  });

  it("staff fetch truncated: staff beyond the fetched pages are pseudonymized (fail closed)", async () => {
    const staffUrl = `/api/v1/courses/${COURSE_ID}/users`;
    const responses: FakeResponse[] = [
      pageWithNext(staffUrl, 1, [{ id: 5000, name: "Mr. Smith" }]),
      STUDENT_PAGE,
    ];
    for (let page = 2; page <= 10; page += 1) {
      responses.push(pageWithNext(staffUrl, page, []));
    }
    const { client } = buildMockCanvas(responses);
    const entries: DiscussionEntryLike[] = [
      { id: 1, user_id: 5000, user_name: "Mr. Smith", message: "" },
      { id: 2, user_id: 6000, user_name: "Unfetched TA", message: "" },
    ];
    const result = await anonymizeDiscussionEntries({ canvas: client, anonymizer }, COURSE_ID, entries);

    expect(result.entries[0]?.user_name).toBe("Mr. Smith");
    expect(result.entries[1]?.user_name).toMatch(/^Student \d+$/);
  });

  it("student roster truncated: fail-open scrub surfaces ROSTER_TRUNCATED_NOTE", async () => {
    const studentUrl = `/api/v1/courses/${COURSE_ID}/users`;
    const responses: FakeResponse[] = [
      STAFF_PAGE,
      pageWithNext(studentUrl, 1, STUDENT_ROSTER),
    ];
    for (let page = 2; page <= 10; page += 1) {
      responses.push(pageWithNext(studentUrl, page, []));
    }
    const { client } = buildMockCanvas(responses);
    const entries: DiscussionEntryLike[] = [
      { id: 1, user_id: 1001, user_name: "Grace Park", message: "hi" },
    ];
    const result = await anonymizeDiscussionEntries({ canvas: client, anonymizer }, COURSE_ID, entries);

    expect(result.entries[0]?.user_name).toBe("Student 1");
    expect(result.warnings).toContain(ROSTER_TRUNCATED_NOTE);
    expect(result.warnings).toContain(DISCUSSION_SCRUB_NOTE);
  });

  it("propagates staff-fetch failure instead of proceeding unclassified", async () => {
    const { client } = buildMockCanvas([
      { status: 500, data: { errors: [{ message: "boom" }] } },
      STUDENT_PAGE,
    ]);
    await expect(
      anonymizeDiscussionEntries({ canvas: client, anonymizer }, COURSE_ID, [
        { id: 1, user_id: 1001, user_name: "Grace Park", message: "" },
      ]),
    ).rejects.toThrow();
  });

  it("cross-map stability: pseudonyms match anonymizeUser output for the same user id", async () => {
    const { client } = buildMockCanvas([STAFF_PAGE, STUDENT_PAGE]);
    await anonymizeDiscussionEntries({ canvas: client, anonymizer }, COURSE_ID, [
      { id: 1, user_id: 1001, user_name: "Grace Park", message: "" },
    ]);

    const separateInstanceSharingDisk = new Anonymizer({ rootDir: anonRoot });
    const anonymized = await separateInstanceSharingDisk.anonymizeUser(COURSE_ID, {
      id: 1001,
      name: "Grace Park",
      role: "student",
    });
    expect(anonymized.name).toBe("Student 1");
  });

  it("R3a regression: serialized anonymized entries contain no raw student fixture names", async () => {
    const { client } = buildMockCanvas([STAFF_PAGE, STUDENT_PAGE]);
    const entries: DiscussionEntryLike[] = [
      {
        id: 1,
        user_id: 1001,
        user_name: "Grace Park",
        message: "Ana Maria and D'Angelo O'Brien-Smith agreed with Grace.",
        recent_replies: [
          { id: 11, user_id: 1003, user_name: "D'Angelo O'Brien-Smith", message: "Ana said it first" },
        ],
      },
      { id: 2, user_id: 5000, user_name: "Mr. Smith", message: "Nice work everyone." },
      { id: 3, user_id: 9999, user_name: "Dropped Dan", message: "" },
    ];
    const result = await anonymizeDiscussionEntries({ canvas: client, anonymizer }, COURSE_ID, entries);

    const serialized = JSON.stringify(result.entries);
    expect(serialized).not.toContain("Grace");
    expect(serialized).not.toContain("Park");
    expect(serialized).not.toContain("Ana");
    expect(serialized).not.toContain("Maria");
    expect(serialized).not.toContain("D'Angelo");
    expect(serialized).not.toContain("O'Brien");
    expect(serialized).not.toContain("Dropped Dan");
    expect(serialized).toContain("Mr. Smith");
  });
});

describe("buildCourseScrubber reuse (topic-level scrubbing for Unit 8)", () => {
  it("returns a scrub function usable on arbitrary text plus roster warnings", async () => {
    const { client, requests } = buildMockCanvas([STAFF_PAGE, STUDENT_PAGE]);
    const scrubber = await buildCourseScrubber({ canvas: client, anonymizer }, COURSE_ID);

    expect(scrubber.scrub("Reply to your assigned partner: Grace")).toBe(
      "Reply to your assigned partner: Student 1",
    );
    expect(scrubber.warnings).toEqual([]);
    expect(requests).toHaveLength(2);
  });

  it("a pre-built scrubber passed to anonymizeDiscussionEntries avoids refetching rosters", async () => {
    const { client, requests } = buildMockCanvas([STAFF_PAGE, STUDENT_PAGE]);
    const scrubber = await buildCourseScrubber({ canvas: client, anonymizer }, COURSE_ID);
    const result = await anonymizeDiscussionEntries(
      { canvas: client, anonymizer },
      COURSE_ID,
      [{ id: 1, user_id: 1002, user_name: "Ana Maria", message: "Grace Park rocks" }],
      scrubber,
    );

    expect(requests).toHaveLength(2);
    expect(result.entries[0]?.user_name).toBe("Student 2");
    expect(result.entries[0]?.message).toBe("Student 1 rocks");
  });
});

describe("fetchStudentRoster", () => {
  it("requests student enrollments and returns string ids with names", async () => {
    const { client, requests } = buildMockCanvas([STUDENT_PAGE]);
    const roster = await fetchStudentRoster(client, COURSE_ID);

    expect(requests[0]?.url).toBe(`/api/v1/courses/${COURSE_ID}/users`);
    expect(requests[0]?.params).toMatchObject({ "enrollment_type[]": ["student"] });
    expect(roster.truncated).toBe(false);
    expect(roster.students).toEqual([
      { id: "1001", name: "Grace Park" },
      { id: "1002", name: "Ana Maria" },
      { id: "1003", name: "D'Angelo O'Brien-Smith" },
    ]);
  });

  it("propagates the getPaginated truncated flag", async () => {
    const studentUrl = `/api/v1/courses/${COURSE_ID}/users`;
    const responses: FakeResponse[] = [];
    for (let page = 1; page <= 10; page += 1) {
      responses.push(pageWithNext(studentUrl, page, [{ id: page, name: `Student Page ${page}` }]));
    }
    const { client } = buildMockCanvas(responses);
    const roster = await fetchStudentRoster(client, COURSE_ID);
    expect(roster.truncated).toBe(true);
    expect(roster.students).toHaveLength(10);
  });
});
