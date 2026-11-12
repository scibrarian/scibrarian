import {
  createTopic,
  findCatalogByNlmId,
  findMeshByUi,
  getTopic,
  journalByNlmId,
  renameTopic,
  storedHeading,
  topicByHeadings,
  topicByName,
  topicByTerm,
  topicJournals,
  type JournalSpec,
  type ScopeIds,
  type TopicScope,
} from "./db.js";
import { changeTopicScope } from "./holding.js";
import { ensureCatalogLoaded } from "./journal-catalog.js";
import { ensureMeshLoaded } from "./mesh-catalog.js";
import { nameProblem, nameTakenBy } from "./names.js";
import { isMedlineIndexed, topicTerm } from "./pubmed.js";
import type {
  JournalRemovalResult,
  MeshDescriptorRef,
  TopicDetail,
  TopicUpdateResponse,
} from "./types.js";
import { httpError } from "./util.js";
import { MAX_TOPIC_HEADINGS, MAX_TOPIC_NAME_CHARS } from "../../shared/limits.js";
import { defaultTopicName } from "../../shared/topic.js";

// What a topic may be (see GLOSSARY.md), and the order adding one or changing
// one is written in.
//
// Each takes the request body as the client sent it, because what it accepts is
// part of the definition: repeats collapse, a name is trimmed and defaulted,
// half a scope is refused. A refusal is thrown as an httpError carrying the
// status and the message the reader sees, which a route's asyncHandler passes
// to the error middleware to send.
//
// The checks are ordered around the waits. Reading the headings can load the
// MeSH vocabulary, and resolving a journal new to the library asks NLM about
// it, so anything another request could have changed meanwhile — a name taken,
// the same headings added — is asked again after the last wait, and nothing
// from there to the write waits on anything outside this process.

// The headings a request names, as descriptors. One reading for adding a
// topic, its preview and the journal suggestions, so the count the dialog shows
// is for exactly the set the add would accept.
//
// `raw` is descriptor ids, the way the picker holds them. Repeats collapse
// rather than fail: the same heading twice is the same requirement once.
//
// `orStored` also takes a heading the vocabulary has dropped, as a topic
// recorded it. For the journal suggestions alone, which an existing topic asks
// for by headings it cannot change; a new topic is still made only of headings
// NLM has now.
export async function readHeadings(raw: unknown, orStored = false): Promise<MeshDescriptorRef[]> {
  const uis = distinctStrings(raw);
  if (uis.length === 0) throw httpError(400, "Pick at least one MeSH heading.");
  if (uis.length > MAX_TOPIC_HEADINGS) {
    throw httpError(400, `A topic can have at most ${MAX_TOPIC_HEADINGS} headings.`);
  }
  await ensureMeshLoaded();
  const headings: MeshDescriptorRef[] = [];
  for (const ui of uis) {
    const descriptor = findMeshByUi(ui) ?? (orStored ? storedHeading(ui) : undefined);
    if (!descriptor) {
      throw httpError(422, `"${ui}" isn't a MeSH heading. Pick headings from the suggestions.`);
    }
    headings.push({ ui: descriptor.ui, name: descriptor.name });
  }
  return headings;
}

// A list of ids as a request carries it — an array in a body, and in a query
// either a repeated parameter or, for one value, a bare string.
function distinctStrings(raw: unknown): string[] {
  const given = Array.isArray(raw) ? raw : raw == null ? [] : [raw];
  return [...new Set(given.map((v) => String(v).trim()).filter(Boolean))];
}

// The scope a request names, as the journals' ids and nothing else: all the
// count ahead of a change needs (see ScopeIds), read as the change reads it.
export function readScope(body: unknown): ScopeIds {
  const b = (body ?? {}) as { allPubmed?: unknown; journals?: unknown };
  const allPubmed = b.allPubmed === true;
  return { allPubmed, nlmIds: allPubmed ? [] : distinctStrings(b.journals) };
}

// The same scope, with each journal resolved: against the journals some topic
// already lists, and otherwise against the NLM catalog.
//
// A journal new to the library gets its MEDLINE check here. Advisory, not a
// gate: the journal is real and the user asked for it, so it is listed either
// way — but if NLM doesn't index it for MEDLINE its papers carry no MeSH
// headings, and topics are MeSH terms. Left unsaid, that journal just quietly
// never yields a paper. An NCBI hiccup answers null, which stores as "not
// established yet". One already listed keeps the answer it was given then.
async function resolveScope(body: unknown): Promise<TopicScope> {
  const ids = readScope(body);
  if (ids.allPubmed) return { allPubmed: true };
  const journals: JournalSpec[] = [];
  for (const nlmId of ids.nlmIds) {
    const listed = journalByNlmId(nlmId);
    if (listed) {
      journals.push({ nlmId, name: listed.name, medlineIndexed: listed.medline_indexed });
      continue;
    }
    await ensureCatalogLoaded();
    // By catalog id rather than by name: catalog names aren't unique, so a name
    // round-trip could land on a different journal than the one picked.
    const cat = findCatalogByNlmId(nlmId);
    if (!cat) throw httpError(422, `"${nlmId}" isn't a journal in the NLM catalog.`);
    journals.push({
      nlmId: cat.nlm_id,
      name: cat.med_abbr || cat.title,
      medlineIndexed: await isMedlineIndexed(cat.nlm_id),
    });
  }
  return { allPubmed: false, journals };
}

// One topic with the journals it lists, as the dialog that edits them reads it.
export const topicDetail = (id: number): TopicDetail => ({ ...getTopic(id)!, journals: topicJournals(id) });

// The name rules (names.ts), with the longer cap a topic's name gets (see
// MAX_TOPIC_NAME_CHARS).
function checkName(name: string): void {
  const problem = nameProblem(name, MAX_TOPIC_NAME_CHARS, "topic name");
  if (problem) throw httpError(400, problem);
}

function checkNameFree(name: string, selfId: number | null): void {
  const taken = nameTakenBy("topic", topicByName(name), selfId);
  if (taken) throw httpError(409, taken);
}

// Topics are strictly MeSH headings, one or several that a paper must carry all
// of: the client sends headings picked from the autocomplete, each is validated
// against the indexed descriptor list, and the PubMed term is built here so a
// topic can never carry an invalid MeSH term. With them comes where the topic
// searches — all of PubMed, or journals of its own.
export async function addTopic(body: unknown): Promise<TopicDetail> {
  const b = (body ?? {}) as { headings?: unknown; name?: unknown };
  const headings = await readHeadings(b.headings);
  const name = String(b.name ?? "").trim() || defaultTopicName(headings);
  checkName(name);
  const term = topicTerm(headings);
  // Asked before the journals are resolved, which can take a request to NCBI
  // each, and again after: nothing awaits between the second and the insert.
  const checkFree = () => {
    const existing = topicByHeadings(headings.map((h) => h.ui)) ?? topicByTerm(term);
    if (existing) throw httpError(409, `These headings are already a topic (“${existing.name}”).`);
    checkNameFree(name, null);
  };
  checkFree();
  const scope = await resolveScope(body);
  checkFree();
  return topicDetail(createTopic(name, term, headings, scope).id);
}

// Change a topic's name, where it searches, or both. Its headings are not here
// to change: they are fixed when it is added (see Topic.headings).
//
// A change of scope runs under the poll lock, like a reset (see
// changeTopicScope).
export async function changeTopic(id: number, body: unknown): Promise<TopicUpdateResponse> {
  const topic = getTopic(id);
  if (!topic) throw httpError(404, "Topic not found.");
  const b = (body ?? {}) as { name?: unknown; allPubmed?: unknown; journals?: unknown };

  const renaming = b.name !== undefined;
  const name = renaming ? String(b.name ?? "").trim() : topic.name;
  if (renaming) {
    checkName(name);
    checkNameFree(name, id);
  }

  let removed: JournalRemovalResult = { deletedArticles: 0, removedFromInterests: 0 };
  if (b.allPubmed !== undefined || b.journals !== undefined) {
    // A scope is replaced whole, so half of one is refused rather than
    // completed: a list with no `journals` would resolve to an empty one and
    // take every paper out of the topic, with no count shown ahead of it. An
    // empty list is still there to be asked for, by name.
    //
    // A list, and nothing that could pass for one left out: a client that
    // writes a list it doesn't have as null, or as "", was completed the same
    // way, which a test for `undefined` let through.
    if (b.allPubmed !== true && !Array.isArray(b.journals)) {
      throw httpError(400, "'journals' must be an array unless 'allPubmed' is true.");
    }
    const scope = await resolveScope(body);
    // Asked again, as addTopic asks twice: resolving the journals can take a
    // request to NCBI each, and another topic could have taken the name
    // meanwhile. Here rather than at the rename, so a name refused now leaves
    // the scope unchanged too; nothing from here to the rename waits on
    // anything outside this process.
    if (renaming) checkNameFree(name, id);
    const changed = await changeTopicScope(id, scope);
    if (changed === null) throw httpError(409, "A check for new papers is running. Try again in a moment.");
    removed = changed.result;
  }
  // Last, so a scope that was refused doesn't leave the topic renamed.
  if (renaming) renameTopic(id, name);
  if (!getTopic(id)) throw httpError(404, "Topic not found.");
  return { topic: topicDetail(id), removed };
}
