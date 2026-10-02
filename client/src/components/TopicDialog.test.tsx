// @vitest-environment jsdom
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { TopicDialog } from "./TopicDialog";
import { MAX_TOPIC_HEADINGS } from "../../../shared/limits";
import type { MeshSearchResult, Topic } from "../types";

// jsdom has no layout, so no scrollIntoView, which the typeahead's highlight
// calls to stay in view.
beforeAll(() => {
  Element.prototype.scrollIntoView = () => {};
});

afterEach(cleanup);

// The topic dialog: a topic is the headings picked into it.
//
// What is pinned is what the dialog decides on its own, ahead of the server:
// that nothing can be created from no headings, that a heading already picked
// is not offered twice, that the name follows the headings until someone types
// one and is then left alone, and that an existing topic shows its headings
// without offering to change them.

const api = vi.hoisted(() => ({
  searchMesh: vi.fn(),
  suggestTopics: vi.fn(),
  previewTopic: vi.fn(),
  createTopic: vi.fn(),
  renameTopic: vi.fn(),
}));

vi.mock("../api", () => ({ api }));

const hit = (ui: string, name: string): MeshSearchResult => ({ ui, name, synonym: null });
const ATHERO = hit("D050197", "Atherosclerosis");
const SLEEP = hit("D012890", "Sleep");

const TOPIC: Topic = {
  id: 7,
  name: "Plaque and rest",
  term: '"Sleep"[MeSH] AND "Atherosclerosis"[MeSH]',
  headings: [
    { ui: ATHERO.ui, name: ATHERO.name },
    { ui: SLEEP.ui, name: SLEEP.name },
  ],
  last_polled_at: null,
  created_at: "2026-10-01 00:00:00",
  pubmed_polled_at: null,
};

beforeEach(() => {
  vi.clearAllMocks();
  api.searchMesh.mockResolvedValue({ results: [ATHERO, SLEEP] });
  api.suggestTopics.mockResolvedValue({ results: [], heldPapers: 0, unchecked: 0 });
  api.previewTopic.mockResolvedValue({ term: "", count: 119 });
  api.createTopic.mockImplementation(async () => TOPIC);
  api.renameTopic.mockImplementation(async () => TOPIC);
});

function open(topic: Topic | null = null) {
  const onSaved = vi.fn();
  const onClose = vi.fn();
  render(<TopicDialog open topic={topic} onClose={onClose} onSaved={onSaved} />);
  return { onSaved, onClose };
}

const search = () => screen.getByRole("combobox") as HTMLInputElement;
const nameBox = () => screen.getByLabelText("Name") as HTMLInputElement;
const submit = (label: string) => screen.getByRole("button", { name: label }) as HTMLButtonElement;
const chips = () => screen.queryAllByRole("listitem").map((li) => li.textContent);

// Type into the heading search and take the option of that name. The whole
// name, so that no two picks in a row type the same thing: the box searches
// when its text changes, and a test picks faster than its debounce.
async function pick(name: string) {
  fireEvent.focus(search());
  fireEvent.change(search(), { target: { value: name } });
  fireEvent.click(await screen.findByRole("option", { name }));
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
    await waitFor(() => expect(screen.getByRole("status").textContent).toBe("119 papers in PubMed match"));
    expect(api.previewTopic).toHaveBeenLastCalledWith([ATHERO.ui, SLEEP.ui]);
  });

  it("says so when they match more than one search returns", async () => {
    api.previewTopic.mockResolvedValue({ term: "", count: 67548 });
    open();
    await pick("Atherosclerosis");
    await waitFor(() => expect(screen.getByRole("status").textContent).toMatch(/^67,548 papers/));
    expect(screen.getByRole("status").textContent).toMatch(/more than the 9,999 one search returns/);
  });

  it("is not held up by a count that can't be had", async () => {
    api.previewTopic.mockRejectedValue(new Error("network"));
    open();
    await pick("Atherosclerosis");
    await waitFor(() => expect(screen.getByRole("status").textContent).toMatch(/Couldn't count/));
    expect(submit("Create topic").disabled).toBe(false);
  });

  it("sends the headings as picked and leaves an untyped name to the server", async () => {
    const { onSaved, onClose } = open();
    await pick("Atherosclerosis");
    await pick("Sleep");
    fireEvent.click(submit("Create topic"));
    await waitFor(() => expect(onSaved).toHaveBeenCalledWith(TOPIC));
    expect(api.createTopic).toHaveBeenCalledWith([ATHERO.ui, SLEEP.ui], undefined);
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
      expect(api.createTopic).toHaveBeenCalledWith([ATHERO.ui, SLEEP.ui], "Plaque and rest")
    );
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
  it("shows its headings and offers no way to change them", () => {
    open(TOPIC);
    expect(chips()).toEqual(["Atherosclerosis", "Sleep"]);
    expect(screen.queryByRole("combobox")).toBeNull();
    expect(screen.queryByRole("button", { name: /^Remove / })).toBeNull();
    // Nothing to count: the topic's feed already says how many it matched.
    expect(screen.queryByRole("status")).toBeNull();
    expect(api.previewTopic).not.toHaveBeenCalled();
  });

  it("saves a new name, and only a new one", async () => {
    const { onSaved } = open(TOPIC);
    expect(nameBox().value).toBe("Plaque and rest");
    expect(submit("Save").disabled).toBe(true);
    fireEvent.change(nameBox(), { target: { value: "  " } });
    expect(submit("Save").disabled).toBe(true);
    fireEvent.change(nameBox(), { target: { value: " Arteries at night " } });
    fireEvent.click(submit("Save"));
    await waitFor(() => expect(onSaved).toHaveBeenCalled());
    expect(api.renameTopic).toHaveBeenCalledWith(7, "Arteries at night");
  });
});
