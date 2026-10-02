import { MAX_TOPIC_NAME_CHARS } from "./limits.js";
import type { MeshDescriptorRef } from "./types.js";

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
