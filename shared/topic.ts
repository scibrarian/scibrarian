import { MAX_TOPIC_NAME_CHARS } from "./limits.js";
import type { MeshDescriptorRef, Topic } from "./types.js";

// Whether a topic has anywhere to search: all of PubMed, or a list with
// something on it. A topic that lists journals and has none searches nothing —
// searching its bare term would be all of PubMed, which is a scope a topic is
// given and never one it falls into.
//
// Here because both halves ask it. The poller skips a topic that can't be
// searched, and the client says which those are, under the topic's name in
// Settings and in place of its empty feed; written once in each, the three had
// only to be kept in step by whoever changed one.
export function canPoll(topic: Pick<Topic, "all_pubmed" | "journalCount">): boolean {
  return topic.all_pubmed || topic.journalCount > 0;
}

// What a topic is called until someone names it: its headings, in the order
// they were picked. Here rather than in either half because both need it — the
// dialog shows this in the name box before anything is sent, and the server
// applies it when a request carries no name, and a topic created the second way
// has to end up called what the first way showed.
//
// Cut to the cap rather than refused: ten long headings run past it, and the
// name nobody typed is not a reason to reject the topic.
export function defaultTopicName(headings: MeshDescriptorRef[]): string {
  const joined = headings.map((h) => h.name).join(" + ");
  return joined.length > MAX_TOPIC_NAME_CHARS
    ? `${joined.slice(0, MAX_TOPIC_NAME_CHARS - 1)}…`
    : joined;
}
