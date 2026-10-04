// @vitest-environment jsdom
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { TopicDialog, describeTopicSave } from "./TopicDialog";
import { withAnExitAnimation } from "./test-exit-animation";
import { MAX_TOPIC_HEADINGS } from "../../../shared/limits";
import type { Journal, JournalSearchResult, MeshSearchResult, Topic, TopicDetail } from "../types";

// jsdom has no layout, so no scrollIntoView, which the typeahead's highlight
// calls to stay in view.
beforeAll(() => {
  Element.prototype.scrollIntoView = () => {};
});

afterEach(cleanup);

// The topic dialog: a topic is the headings picked into it, and where it
// searches for them.
//
// What is pinned is what the dialog decides on its own, ahead of the server:
// that nothing can be created from no headings, that a heading already picked
// is not offered twice, that the name follows the headings until someone types
// one and is then left alone, that an existing topic shows its headings
// without offering to change them — and that a change of scope which would
// take papers out says how many before it does, and only then.

const api = vi.hoisted(() => ({
  searchMesh: vi.fn(),
  suggestTopics: vi.fn(),
  previewTopic: vi.fn(),
  createTopic: vi.fn(),
  getTopic: vi.fn(),
  updateTopic: vi.fn(),
  scopeChangeCount: vi.fn(),
  searchJournals: vi.fn(),
  suggestJournals: vi.fn(),
}));

vi.mock("../api", () => ({ api }));

const hit = (ui: string, name: string): MeshSearchResult => ({ ui, name, synonym: null });
const ATHERO = hit("D050197", "Atherosclerosis");
const SLEEP = hit("D012890", "Sleep");

const journal = (id: number, nlm_id: string, name: string, indexed = true): Journal => ({
  id,
  nlm_id,
  name,
  metric: 5,
  created_at: "2026-10-01 00:00:00",
  medline_indexed: indexed,
});
const LANCET = journal(1, "2985213R", "Lancet");
const BMJ = journal(2, "8900488", "BMJ");
const CIRC: JournalSearchResult = {
  nlm_id: "0147763",
  title: "Circulation",
  abbr: "Circulation",
  issn: "",
  metric: 30,
};

const TOPIC: Topic = {
  id: 7,
  name: "Plaque and rest",
  term: '"Sleep"[MeSH] AND "Atherosclerosis"[MeSH]',
  headings: [
    { ui: ATHERO.ui, name: ATHERO.name },
    { ui: SLEEP.ui, name: SLEEP.name },
  ],
  all_pubmed: false,
  journalCount: 2,
  last_polled_at: null,
  created_at: "2026-10-01 00:00:00",
};
const DETAIL: TopicDetail = { ...TOPIC, journals: [BMJ, LANCET] };
const EVERYWHERE: Topic = { ...TOPIC, all_pubmed: true, journalCount: 0 };

const NOTHING_REMOVED = { deletedArticles: 0, removedFromInterests: 0 };

beforeEach(() => {
  vi.clearAllMocks();
  api.searchMesh.mockResolvedValue({ results: [ATHERO, SLEEP] });
  api.suggestTopics.mockResolvedValue({ results: [], heldPapers: 0, unchecked: 0 });
  api.previewTopic.mockResolvedValue({ term: "", count: 119 });
  api.createTopic.mockImplementation(async () => ({ ...EVERYWHERE, journals: [] }));
  api.getTopic.mockResolvedValue(DETAIL);
  api.updateTopic.mockImplementation(async () => ({ topic: DETAIL, removed: NOTHING_REMOVED }));
  api.scopeChangeCount.mockResolvedValue({ count: 0 });
  api.searchJournals.mockResolvedValue({ results: [CIRC] });
  api.suggestJournals.mockResolvedValue({ results: [] });
});

function open(topic: Topic | null = null, topics: Topic[] = []) {
  const onSaved = vi.fn();
  const onClose = vi.fn();
  render(<TopicDialog open topic={topic} topics={topics} onClose={onClose} onSaved={onSaved} />);
  return { onSaved, onClose };
}

const search = () => screen.getByRole("combobox") as HTMLInputElement;
const nameBox = () => screen.getByLabelText("Name") as HTMLInputElement;
const submit = (label: string) => screen.getByRole("button", { name: label }) as HTMLButtonElement;
const chips = () =>
  within(screen.getByRole("list", { name: "MeSH headings" }))
    .getAllByRole("listitem")
    .map((li) => li.textContent);
const scopeRadio = (label: string) => screen.getByRole("radio", { name: label }) as HTMLInputElement;
const listPane = () => screen.getByRole("region", { name: "This topic's journals" });
const catalogPane = () => screen.getByRole("region", { name: "Catalog journals" });
const listed = () =>
  within(listPane())
    .queryAllByRole("checkbox")
    .map((box) => box.closest("li")!.getAttribute("title"));

// Type into the heading search and take the option of that name. The whole
// name, so that no two picks in a row type the same thing: the box searches
// when its text changes, and a test picks faster than its debounce.
async function pick(name: string) {
  fireEvent.focus(search());
  fireEvent.change(search(), { target: { value: name } });
  fireEvent.click(await screen.findByRole("option", { name }));
}

// The stored list has arrived and is on screen.
const listLoaded = () => waitFor(() => expect(listed()).toEqual(["BMJ", "Lancet"]));

// Tick a journal in the right-hand pane and press Remove.
function drop(name: string) {
  fireEvent.click(within(listPane()).getByRole("checkbox", { name: new RegExp(`^${name}`) }));
  fireEvent.click(screen.getByRole("button", { name: /Remove$/ }));
}

describe("creating a topic", () => {
  it("can't be submitted until a heading is picked", async () => {
    open();
    expect(submit("Create topic").disabled).toBe(true);
    await pick("Atherosclerosis");
    expect(submit("Create topic").disabled).toBe(false);
  });

  it("names itself after its headings, in the order they were picked", async () => {
    open();
    await pick("Atherosclerosis");
    expect(nameBox().value).toBe("Atherosclerosis");
    await pick("Sleep");
    expect(chips()).toEqual(["Atherosclerosis", "Sleep"]);
    expect(nameBox().value).toBe("Atherosclerosis + Sleep");
  });

  it("stops offering a heading once it is picked", async () => {
    open();
    await pick("Atherosclerosis");
    fireEvent.change(search(), { target: { value: "slee" } });
    await screen.findByRole("option", { name: "Sleep" });
    expect(screen.queryByRole("option", { name: "Atherosclerosis" })).toBeNull();
  });

  it("drops a heading by its ×, and the name follows", async () => {
    open();
    await pick("Atherosclerosis");
    await pick("Sleep");
    fireEvent.click(screen.getByRole("button", { name: "Remove Atherosclerosis" }));
    expect(chips()).toEqual(["Sleep"]);
    expect(nameBox().value).toBe("Sleep");
  });

  it("counts what the headings match together", async () => {
    open();
    await pick("Atherosclerosis");
    await pick("Sleep");
    await waitFor(() =>
      expect(screen.getByRole("status").textContent).toBe("119 papers in PubMed match")
    );
    expect(api.previewTopic).toHaveBeenLastCalledWith([ATHERO.ui, SLEEP.ui]);
  });

  it("says so when they match more than one search returns", async () => {
    api.previewTopic.mockResolvedValue({ term: "", count: 67548 });
    open();
    await pick("Atherosclerosis");
    await waitFor(() => expect(screen.getByRole("status").textContent).toMatch(/^67,548 papers/));
    expect(screen.getByRole("status").textContent).toMatch(
      /more than the 9,999 one search returns.*or choose journals/
    );
  });

  it("is not held up by a count that can't be had", async () => {
    api.previewTopic.mockRejectedValue(new Error("network"));
    open();
    await pick("Atherosclerosis");
    await waitFor(() => expect(screen.getByRole("status").textContent).toMatch(/Couldn't count/));
    expect(submit("Create topic").disabled).toBe(false);
  });

  it("searches all of PubMed unless told otherwise, and leaves an untyped name to the server", async () => {
    const { onSaved, onClose } = open();
    expect(scopeRadio("All of PubMed").checked).toBe(true);
    // No list to pick from while it searches everything.
    expect(screen.queryByRole("region", { name: "Catalog journals" })).toBeNull();
    await pick("Atherosclerosis");
    await pick("Sleep");
    fireEvent.click(submit("Create topic"));
    await waitFor(() => expect(onSaved).toHaveBeenCalled());
    expect(api.createTopic).toHaveBeenCalledWith(
      [ATHERO.ui, SLEEP.ui],
      { allPubmed: true, journals: [] },
      undefined
    );
    expect(onSaved.mock.calls[0][1]).toEqual({ created: true, removed: 0, unindexed: [] });
    expect(onClose).toHaveBeenCalled();
  });

  it("keeps a typed name when another heading is picked, and sends it", async () => {
    open();
    await pick("Atherosclerosis");
    fireEvent.change(nameBox(), { target: { value: "Plaque and rest" } });
    await pick("Sleep");
    expect(nameBox().value).toBe("Plaque and rest");
    fireEvent.click(submit("Create topic"));
    await waitFor(() =>
      expect(api.createTopic).toHaveBeenCalledWith(
        [ATHERO.ui, SLEEP.ui],
        { allPubmed: true, journals: [] },
        "Plaque and rest"
      )
    );
  });

  it("sends the journals picked for it when it searches a list", async () => {
    api.createTopic.mockImplementation(async () => ({
      ...TOPIC,
      journalCount: 1,
      journals: [journal(9, CIRC.nlm_id, "Circulation", false)],
    }));
    const { onSaved } = open();
    await pick("Atherosclerosis");
    fireEvent.click(scopeRadio("Only these journals"));
    fireEvent.change(within(catalogPane()).getByRole("searchbox"), { target: { value: "circ" } });
    fireEvent.click(await within(catalogPane()).findByRole("checkbox", { name: /^Circulation/ }));
    fireEvent.click(screen.getByRole("button", { name: /^Add/ }));
    expect(listed()).toEqual(["Circulation"]);

    fireEvent.click(submit("Create topic"));
    await waitFor(() => expect(onSaved).toHaveBeenCalled());
    expect(api.createTopic).toHaveBeenCalledWith(
      [ATHERO.ui],
      { allPubmed: false, journals: [CIRC.nlm_id] },
      undefined
    );
    // What NLM said about a journal just listed travels out with the save.
    expect(onSaved.mock.calls[0][1].unindexed).toEqual(["Circulation"]);
  });

  it("reports a refusal and stays open", async () => {
    api.createTopic.mockRejectedValue(new Error("These headings are already a topic (“Sleep”)."));
    const { onSaved, onClose } = open();
    await pick("Sleep");
    fireEvent.click(submit("Create topic"));
    await screen.findByText(/already a topic/);
    expect(onSaved).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });

  it("doesn't count the last opening's headings when it is opened again", async () => {
    // The headings are cleared as the dialog opens, but the count ran a
    // debounce behind them, and for that long still held the ones the last
    // opening ended with: a PubMed search for a set nobody was looking at.
    const rest = { topic: null, topics: [], onClose: vi.fn(), onSaved: vi.fn() };
    const { rerender } = render(<TopicDialog open {...rest} />);
    await pick("Atherosclerosis");
    await waitFor(() => expect(api.previewTopic).toHaveBeenCalledTimes(1));

    rerender(<TopicDialog open={false} {...rest} />);
    rerender(<TopicDialog open {...rest} />);
    // Past the debounce, so a search that was only waiting would have left.
    await act(() => new Promise<void>((r) => setTimeout(r, 400)));
    expect(api.previewTopic).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("list", { name: "MeSH headings" })).toBeNull();
  });

  it("takes no more headings once it has as many as a topic may", async () => {
    const many = Array.from({ length: MAX_TOPIC_HEADINGS }, (_, i) => hit(`D9${i}`, `Heading ${i}`));
    api.searchMesh.mockResolvedValue({ results: many });
    open();
    for (const h of many) await pick(h.name);
    expect(chips()).toHaveLength(MAX_TOPIC_HEADINGS);
    expect(search().disabled).toBe(true);
  });
});

describe("editing a topic", () => {
  it("shows its headings and offers no way to change them", async () => {
    open(TOPIC);
    expect(chips()).toEqual(["Atherosclerosis", "Sleep"]);
    expect(screen.queryByRole("combobox")).toBeNull();
    expect(screen.queryByRole("button", { name: /^Remove / })).toBeNull();
    // Nothing to count: the topic's feed already says how many it matched.
    expect(screen.queryByRole("status")).toBeNull();
    expect(api.previewTopic).not.toHaveBeenCalled();
    await listLoaded();
  });

  it("holds its scope still until the stored one has arrived", async () => {
    // The stored scope replaces whatever the dialog shows when it lands. On a
    // slow server there was time to switch the radio or add a journal first,
    // and the answer then put both back without a word.
    let arrive!: (detail: TopicDetail) => void;
    api.getTopic.mockReturnValue(new Promise((r) => (arrive = r)));
    open(TOPIC);
    const auto = () => screen.getByRole("button", { name: "Auto" }) as HTMLButtonElement;
    expect(scopeRadio("All of PubMed").disabled).toBe(true);
    expect(scopeRadio("Only these journals").disabled).toBe(true);
    expect(auto().disabled).toBe(true);
    // The name is the dialog's own, and waits on nothing.
    expect(nameBox().disabled).toBe(false);

    await act(async () => arrive(DETAIL));
    await listLoaded();
    expect(scopeRadio("All of PubMed").disabled).toBe(false);
    expect(scopeRadio("Only these journals").disabled).toBe(false);
    expect(auto().disabled).toBe(false);
  });

  it("saves a new name, and only a new one, without touching the scope", async () => {
    const { onSaved } = open(TOPIC);
    await listLoaded();
    expect(nameBox().value).toBe("Plaque and rest");
    expect(submit("Save").disabled).toBe(true);
    fireEvent.change(nameBox(), { target: { value: "  " } });
    expect(submit("Save").disabled).toBe(true);
    fireEvent.change(nameBox(), { target: { value: " Arteries at night " } });
    fireEvent.click(submit("Save"));
    await waitFor(() => expect(onSaved).toHaveBeenCalled());
    expect(api.updateTopic).toHaveBeenCalledWith(7, { name: "Arteries at night" });
    // A rename takes nothing out, so there is nothing to count or confirm.
    expect(api.scopeChangeCount).not.toHaveBeenCalled();
  });

  it("asks before a change that takes papers out, with how many", async () => {
    api.scopeChangeCount.mockResolvedValue({ count: 214 });
    api.updateTopic.mockImplementation(async () => ({
      topic: { ...DETAIL, journalCount: 1, journals: [BMJ] },
      removed: { deletedArticles: 200, removedFromInterests: 214 },
    }));
    const { onSaved } = open(TOPIC);
    await listLoaded();
    drop("Lancet");
    expect(listed()).toEqual(["BMJ"]);

    fireEvent.click(submit("Save"));
    await screen.findByText("Remove 1 journal from this topic?");
    expect(screen.getByText("This will remove its 214 stored papers from “Plaque and rest”.")).toBeTruthy();
    expect(api.scopeChangeCount).toHaveBeenCalledWith(7, {
      allPubmed: false,
      journals: [BMJ.nlm_id],
    });
    // Nothing has been changed by asking.
    expect(api.updateTopic).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Remove" }));
    await waitFor(() => expect(onSaved).toHaveBeenCalled());
    expect(api.updateTopic).toHaveBeenCalledWith(7, { allPubmed: false, journals: [BMJ.nlm_id] });
    expect(onSaved.mock.calls[0][1]).toEqual({ created: false, removed: 214, unindexed: [] });
  });

  it("changes nothing when that question is answered no", async () => {
    api.scopeChangeCount.mockResolvedValue({ count: 3 });
    const { onSaved, onClose } = open(TOPIC);
    await listLoaded();
    drop("Lancet");
    fireEvent.click(submit("Save"));
    const confirm = (await screen.findByText("Remove 1 journal from this topic?")).closest(
      ".modal"
    ) as HTMLElement;
    fireEvent.click(within(confirm).getByRole("button", { name: "Cancel" }));
    expect(api.updateTopic).not.toHaveBeenCalled();
    expect(onSaved).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
    // The dropped journal is still dropped, and still within reach to put back.
    expect(listed()).toEqual(["BMJ"]);
    expect(within(catalogPane()).getByRole("checkbox", { name: /^Lancet/ })).toBeTruthy();
  });

  it("doesn't ask when the change takes nothing out", async () => {
    const { onSaved } = open(TOPIC);
    await listLoaded();
    fireEvent.click(scopeRadio("All of PubMed"));
    fireEvent.click(submit("Save"));
    await waitFor(() => expect(onSaved).toHaveBeenCalled());
    expect(screen.queryByText(/from this topic\?/)).toBeNull();
    expect(api.updateTopic).toHaveBeenCalledWith(7, { allPubmed: true, journals: [] });
  });

  it("stops rather than guess when the count can't be had", async () => {
    api.scopeChangeCount.mockRejectedValue(new Error("network"));
    const { onSaved } = open(TOPIC);
    await listLoaded();
    drop("Lancet");
    fireEvent.click(submit("Save"));
    await screen.findByText("network");
    expect(api.updateTopic).not.toHaveBeenCalled();
    expect(onSaved).not.toHaveBeenCalled();
  });

  it("offers the lists of other topics to copy, and adds what is new", async () => {
    const other: Topic = { ...TOPIC, id: 8, name: "Other", journalCount: 2 };
    const circ = journal(3, CIRC.nlm_id, "Circulation");
    api.getTopic.mockImplementation(async (id: number) =>
      id === 8 ? { ...other, journals: [LANCET, circ] } : DETAIL
    );
    // Itself, and a topic with no list, are not offered.
    open(TOPIC, [TOPIC, other, EVERYWHERE]);
    await listLoaded();
    const copy = screen.getByRole("combobox", { name: "Copy another topic's journals" });
    expect(within(copy).getAllByRole("option").map((o) => o.textContent)).toEqual([
      "Copy from…",
      "Other (2)",
    ]);
    fireEvent.change(copy, { target: { value: "8" } });
    // Lancet was already on the list, so one journal is new to it.
    await waitFor(() => expect(listed()).toEqual(["BMJ", "Circulation", "Lancet"]));
  });

  it("says it is searching the catalog from the first keystroke, not that nothing matched", async () => {
    // The search waits out a debounce before it leaves. Until it does, nothing
    // is loading and nothing has been found, which used to read as "No matches."
    let answer!: (r: { results: JournalSearchResult[] }) => void;
    api.searchJournals.mockReturnValue(new Promise((r) => (answer = r)));
    open(TOPIC);
    await listLoaded();
    fireEvent.change(within(catalogPane()).getByRole("searchbox"), { target: { value: "zzzz" } });
    expect(within(catalogPane()).getByText("Searching…")).toBeTruthy();
    expect(within(catalogPane()).queryByText("No matches.")).toBeNull();

    // Still searching once the request is out, and only then an answer.
    await waitFor(() => expect(api.searchJournals).toHaveBeenCalledWith("zzzz", 30));
    expect(within(catalogPane()).getByText("Searching…")).toBeTruthy();
    answer({ results: [] });
    await within(catalogPane()).findByText("No matches.");
  });

  it("dismisses a notice without saving or closing", async () => {
    // The notice sits inside the dialog's form, and its × was a submit button:
    // dismissing "Added 1 journal…" stored the change and closed the dialog.
    const other: Topic = { ...TOPIC, id: 8, name: "Other", journalCount: 1 };
    api.getTopic.mockImplementation(async (id: number) =>
      id === 8 ? { ...other, journals: [journal(3, CIRC.nlm_id, "Circulation")] } : DETAIL
    );
    const { onSaved, onClose } = open(TOPIC, [TOPIC, other]);
    await listLoaded();
    fireEvent.change(screen.getByRole("combobox", { name: "Copy another topic's journals" }), {
      target: { value: "8" },
    });
    await screen.findByText("Added 1 journal from “Other”.");

    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    await waitFor(() => expect(screen.queryByText("Added 1 journal from “Other”.")).toBeNull());
    expect(api.scopeChangeCount).not.toHaveBeenCalled();
    expect(api.updateTopic).not.toHaveBeenCalled();
    expect(onSaved).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
    // The journal it announced is still staged.
    expect(listed()).toEqual(["BMJ", "Circulation", "Lancet"]);
  });

  it("keeps Enter in the journal panes from saving the topic", async () => {
    // The panes sit inside the dialog's form too, where Enter in a box submits:
    // searching the catalog for "circ" and pressing Enter saved the topic as it
    // stood. jsdom submits no form on a key, so what is pinned is the cause —
    // whether the key's default was prevented, which fireEvent answers false for.
    open(TOPIC);
    await listLoaded();
    const box = within(catalogPane()).getByRole("searchbox");
    fireEvent.change(box, { target: { value: "circ" } });
    expect(fireEvent.keyDown(box, { key: "Enter" })).toBe(false);
    const tick = within(listPane()).getByRole("checkbox", { name: /^Lancet/ });
    expect(fireEvent.keyDown(tick, { key: "Enter" })).toBe(false);

    // A button keeps its Enter, which is how a keyboard presses one — and so
    // does the name, where saving is what Enter is for.
    expect(fireEvent.keyDown(screen.getByRole("button", { name: "Auto" }), { key: "Enter" })).toBe(true);
    expect(fireEvent.keyDown(nameBox(), { key: "Enter" })).toBe(true);
  });

  it("drops what Auto finds once the panes that asked are gone", async () => {
    // Auto takes several PubMed round trips, and the dialog can be cancelled
    // and opened on another topic before it answers. The answer used to land
    // there: the first topic's journals and its suggestions in place of the
    // second's own, one Save from replacing them.
    const other: Topic = { ...TOPIC, id: 8, name: "Other", journalCount: 1 };
    api.getTopic.mockImplementation(async (id: number) =>
      id === 8 ? { ...other, journals: [LANCET] } : DETAIL
    );
    let answer!: (r: { results: JournalSearchResult[] }) => void;
    api.suggestJournals.mockReturnValue(new Promise((r) => (answer = r)));
    const rest = { topics: [TOPIC, other], onClose: vi.fn(), onSaved: vi.fn() };
    const { rerender } = render(<TopicDialog open topic={TOPIC} {...rest} />);
    await listLoaded();
    fireEvent.click(screen.getByRole("button", { name: "Auto" }));
    await waitFor(() => expect(api.suggestJournals).toHaveBeenCalled());

    rerender(<TopicDialog open={false} topic={null} {...rest} />);
    rerender(<TopicDialog open topic={other} {...rest} />);
    await waitFor(() => expect(listed()).toEqual(["Lancet"]));

    await act(async () => answer({ results: [CIRC] }));
    expect(listed()).toEqual(["Lancet"]);
    expect(submit("Save").disabled).toBe(true);
  });
});

// The dialog on its way out. Both callers clear the topic in the update that
// closes it, and it stays on screen for its exit after that — as a dialog for
// no topic, which is the New topic form. Cancel on an edit flashed that form.
describe("a topic dialog while it closes", () => {
  afterEach(() => vi.restoreAllMocks());

  it("is still the dialog for the topic it was editing", async () => {
    withAnExitAnimation();
    const rest = { topics: [TOPIC], onClose: vi.fn(), onSaved: vi.fn() };
    const { rerender } = render(<TopicDialog open topic={TOPIC} {...rest} />);
    await listLoaded();

    rerender(<TopicDialog open={false} topic={null} {...rest} />);
    expect(screen.getByRole("heading", { name: "Edit topic" })).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "New topic" })).toBeNull();
    // And is the edit form under that heading, not the one that picks headings.
    expect(screen.queryByRole("combobox")).toBeNull();
    expect(screen.getByRole("button", { name: "Save" })).toBeTruthy();
  });
});

describe("where the focus starts", () => {
  // The info icon beside "MeSH headings" is the dialog's first tab stop, and
  // Radix opens a dialog on its first tab stop. The field the icon explains
  // takes the focus instead.
  it("is the heading search, for a new topic", async () => {
    open();
    await waitFor(() => expect(document.activeElement).toBe(search()));
  });

  it("is the name, for a topic being edited", async () => {
    open(TOPIC);
    await waitFor(() => expect(document.activeElement).toBe(nameBox()));
  });
});

describe("what a save has to say", () => {
  it("is nothing when nothing left and nothing needs a warning", () => {
    expect(describeTopicSave(TOPIC, { created: true, removed: 0, unindexed: [] })).toBeNull();
  });

  it("counts the papers that left the topic", () => {
    expect(describeTopicSave(TOPIC, { created: false, removed: 214, unindexed: [] })).toBe(
      "Removed 214 papers from “Plaque and rest”."
    );
  });

  it("warns about journals MEDLINE doesn't index", () => {
    const said = describeTopicSave(TOPIC, { created: true, removed: 0, unindexed: ["PLoS One"] });
    expect(said).toMatch(/MEDLINE doesn't index PLoS One\. Its papers carry no MeSH headings/);
  });
});
