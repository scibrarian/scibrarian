import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { closeTempDb, openTempDb, type Db } from "./test-db.js";

// Which headings the Library suggests as topics, and which it holds back
// because a topic already watches them.
//
// "Already watched" used to be read off the topic's name, which was the heading
// while a topic was one heading and nobody could rename it. Neither holds now:
// a topic is renamed and its heading comes back as a suggestion, which the
// create then refuses as a topic that exists; and a topic of several headings
// that happens to be called what some other heading is called hides that
// heading, which nothing watches. What a topic watches is its headings, by
// descriptor id.

let db: Db;

const SLEEP = { ui: "D012890", name: "Sleep" };
const ATHERO = { ui: "D050197", name: "Atherosclerosis" };
const OBESITY = { ui: "D009765", name: "Obesity" };
// A check tag: on nearly every paper, and never a subject worth suggesting.
const HUMANS = { ui: "D006801", name: "Humans" };

const ALL_PUBMED = { allPubmed: true as const };
const BOTH = '"Sleep"[MeSH] AND "Atherosclerosis"[MeSH]';

type Filed = { ui: string; name: string; major: boolean };
const main = (h: { ui: string; name: string }): Filed => ({ ...h, major: true });
const aside = (h: { ui: string; name: string }): Filed => ({ ...h, major: false });

// Sleep is the main point of three held papers, atherosclerosis of two, and
// obesity is mentioned by one — which is the order they are suggested in.
const PAPERS: Record<string, Filed[]> = {
  "40000001": [main(SLEEP), main(ATHERO), aside(HUMANS)],
  "40000002": [main(SLEEP), aside(HUMANS)],
  "40000003": [main(SLEEP), aside(OBESITY)],
  "40000004": [main(ATHERO)],
};

beforeAll(async () => {
  db = await openTempDb("topic-suggest");
  db.upsertArticles(
    Object.entries(PAPERS).map(([pmid, headings]) => ({
      pmid,
      title: `Paper ${pmid}`,
      abstract: "",
      journal_name: "Gut",
      mesh: { status: "MEDLINE", headings },
      nlm_id: null,
      authors: ["Smith J"],
      pub_date: "2021-01-01",
      pub_date_display: "2021",
      doi: `10.1000/${pmid}`,
      url: `https://pubmed.ncbi.nlm.nih.gov/${pmid}/`,
    }))
  );
  // Held: suggestions are drawn from papers the Library has a file for.
  const collection = db.createCollection("Held").id;
  db.addCollectionFiles(
    collection,
    Object.keys(PAPERS).map((pmid) => ({ hash: `hash-${pmid}`, name: `${pmid}.pdf` }))
  );
  for (const f of db.listCollectionFiles(collection)) {
    db.setFileMatched(f.id, f.content_hash.replace("hash-", ""), "manual");
  }
});

afterAll(closeTempDb);

beforeEach(() => {
  db.db.exec("DELETE FROM topics");
});

const suggested = () => db.suggestTopicsFromLibrary().map((s) => s.name);

describe("the headings the Library suggests", () => {
  it("are what its held papers are mainly about, without the check tags", () => {
    expect(suggested()).toEqual(["Sleep", "Atherosclerosis", "Obesity"]);
  });

  it("leave out a heading a topic already watches on its own", () => {
    db.createTopic("Sleep", '"Sleep"[MeSH]', [SLEEP], ALL_PUBMED);
    expect(suggested()).toEqual(["Atherosclerosis", "Obesity"]);
  });

  it("go on leaving it out once that topic is called something else", () => {
    // Offered again, it would be picked and then refused: the headings are
    // already a topic, whatever it is called now.
    const topic = db.createTopic("Sleep", '"Sleep"[MeSH]', [SLEEP], ALL_PUBMED);
    db.renameTopic(topic.id, "Rest");
    expect(suggested()).toEqual(["Atherosclerosis", "Obesity"]);
  });

  it("still offer a heading a topic requires only alongside another", () => {
    // On its own, or in other company, it is a different topic.
    db.createTopic("Sleep + Atherosclerosis", BOTH, [SLEEP, ATHERO], ALL_PUBMED);
    expect(suggested()).toEqual(["Sleep", "Atherosclerosis", "Obesity"]);
  });

  it("aren't hidden by a topic that only goes by a heading's name", () => {
    db.createTopic("Obesity", BOTH, [SLEEP, ATHERO], ALL_PUBMED);
    expect(suggested()).toEqual(["Sleep", "Atherosclerosis", "Obesity"]);
  });

  it("leave out the heading of a topic from before headings were recorded", () => {
    // Such a topic has only its name to say what it watches, which was the
    // heading when it was made.
    db.createTopic("Sleep", '"Sleep"[MeSH]');
    expect(suggested()).toEqual(["Atherosclerosis", "Obesity"]);
  });
});
