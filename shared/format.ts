// "3 papers", "1 topic", "1,204 papers" — the pluralisation rule, spelled once,
// for the client and for the email alerts the server sends.
//
// Separated thousands because every caller is reporting a quantity to a person
// rather than printing an id, and a library large enough to make the separator
// matter is exactly the one where the number is worth reading carefully. It is
// here rather than at the call sites so two messages about the same rows cannot
// disagree about how to write them — which is what "1,204 papers" from a reset
// beside "1204 papers" from a collection removal was.
//
// `locale` writes the separator. Left out, it is the runtime's own: in the
// browser, the reader's. The email passes one, since the server's own locale
// says nothing about whoever reads it.
export function plural(n: number, noun: string, locale?: string): string {
  return `${n.toLocaleString(locale)} ${noun}${n === 1 ? "" : "s"}`;
}
