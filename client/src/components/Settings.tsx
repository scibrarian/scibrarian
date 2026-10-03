import { FormEvent, useEffect, useState } from "react";
import { Share2, Check, Trash2 } from "lucide-react";
import { api } from "../api";
import { copyTextToClipboard } from "../lib/clipboard";
import { useReveal } from "../lib/hooks";
import {
  describeCacheCleared,
  describeResetDone,
  errorMessage,
  formatBytes,
  plural,
} from "../lib/format";
import { Banner } from "./Banner";
import { ConfirmDialog } from "./Dialogs";
import { InfoTip } from "./InfoTip";
import { ListRowSkeleton, SkeletonBar, StackedFormSkeleton } from "./Skeleton";
import { TopicDialog, type TopicSaveOutcome } from "./TopicDialog";
import { ProPanel } from "./ProPanel";
import type { ViewerCache } from "../lib/viewerCache";
import type {
  AppSettings,
  Topic,
  TopicDetail,
  ProCollectionStamp,
  ProStatus,
} from "../types";
import { canPoll } from "../../../shared/topic";

// What "Delete all data" is asking about, in the terms the app is navigated in.
//
// Fixed text rather than counts. The three sections are what someone actually
// holds a picture of — the Library, Interests and Bookmarks in the header — so
// naming them says what will be missing afterwards in the words the UI already
// uses, which a row of totals does not. It is also the same sentence every
// time, which is what makes it possible to have read it once and know what the
// button does.
const RESET_WARNING =
  "All papers saved to library, interests, and bookmarks will be deleted. " +
  "All library collections, interest topics, and bookmark folders will also be deleted. " +
  "This cannot be undone.";

// The help behind an info icon: how a thing works, read once and in the way
// from then on.
//
// Only that. What a reader has to copy — the cron format, the sharing setup —
// stays printed on the page, where it can be selected and kept in view while
// typing, and so does anything that says what a control will do to their data:
// what Open Library exposes, what the cache and Delete all data take with them.
// A bubble that closes when the pointer moves is the wrong place for either.
const HELP = {
  topics:
    "Each topic appears under Interests. A topic is one or more MeSH headings, and a paper " +
    "has to carry all of them to appear — typing a synonym (e.g. type 2 diabetes or NIDDM) " +
    "finds the official term (Diabetes Mellitus, Type 2). Each topic searches all of PubMed, " +
    "or journals of its own.",
  polling:
    "When on, every topic is checked for new papers on the schedule below; “Check for new " +
    "papers” works either way. A topic with no journals chosen is skipped.",
  email:
    "Optional but recommended. Sent to NCBI and OpenAlex so they can contact you before " +
    "blocking access if requests ever exceed their limits.",
  apiKey: "Optional. A free key raises the rate limit from ~3 to ~10 requests/sec.",
};

// The cron field's format line. A constant because the form's stand-in prints
// it too, unseen, to take the room it will (see StackedFormSkeleton).
const CRON_HINT = (
  <>
    Default <code>0 6 * * *</code> = daily at 6am. Format: min hour day month weekday.
  </>
);

// Where a topic searches and how much it has found, under its name.
function scopeLine(t: Topic): string {
  if (!canPoll(t)) return "No journals chosen yet · nothing to check";
  const scope = t.all_pubmed ? "All of PubMed" : plural(t.journalCount, "journal");
  return t.articleCount == null ? scope : `${scope} · ${plural(t.articleCount, "paper")}`;
}

export function Settings({
  pro,
  viewerCache,
  onDataChanged,
  onPairingChanged,
  onSharingChanged,
  onPapersRemoved,
  onTopicSaved,
  onLibraryReset,
}: {
  // Null in a free build, which is the only thing gating the shared-holdings
  // panel — there is no separate feature flag to keep in step with it.
  pro: ProStatus | null;
  // The desktop viewer cache, which the shell owns: its header draws a warning
  // from the same reading this panel prints, and either can clear it. Inert on
  // every other build, where the section that uses it is not drawn.
  viewerCache: ViewerCache;
  onDataChanged: () => void;
  // This instance connected to an organization's library or left one, so the
  // `pro` block above is now stale. Passed straight through to the panel that
  // does it — Settings has no opinion on it beyond being in the way.
  onPairingChanged: () => void;
  // A collection was shared or un-shared. Separate from the above because it
  // leaves `pro` untouched — what goes stale is the stamp the Library draws its
  // icon and badge from, and nothing else. Carries the panel's fresh reading of
  // those stamps, or null if it couldn't take one; see ProPanel.
  onSharingChanged: (stamps: ProCollectionStamp[] | null) => void;
  // Papers left the Interests feeds (a topic removed): the app refreshes the
  // paper views and reports the count.
  onPapersRemoved: (count: number) => void;
  // A topic was saved from this panel's dialog. The shell reloads what it
  // draws from topics and says whatever the save has to say — see
  // describeTopicSave.
  onTopicSaved: (topic: TopicDetail, outcome: TopicSaveOutcome) => void;
  // The library was deleted outright. Separate from onPapersRemoved, which the
  // panel could otherwise have reused: that one describes papers leaving the
  // topic feeds, and the shell answers it by reloading them. Here every source
  // is gone — folders and collections included — so the selections pointing at
  // them have to be dropped too, and only the shell can do that.
  //
  // Carries nothing, because the shell has nothing to say: what was destroyed is
  // reported in the panel the button is in, beside the button, rather than in a
  // notice at the top of a page the reader has scrolled to the bottom of.
  onLibraryReset: () => void;
}) {
  const [topics, setTopics] = useState<Topic[]>([]);
  const [settings, setSettings] = useState<AppSettings | null>(null);
  // The last-persisted settings, held so the "Save settings" button can tell
  // whether the form has unsaved edits. Kept in step with `settings` wherever
  // the server confirms a write (initial load and a successful save).
  const [baseline, setBaseline] = useState<AppSettings | null>(null);
  // False only until the first reload settles — the panels show skeletons
  // instead of misleading "No topics yet." empty states and a form that pops
  // in. Later reloads (after mutations) keep showing the current data.
  const [loaded, setLoaded] = useState(false);
  // The same, for the Pro panel, which fetches on its own and used to arrive
  // whenever it arrived. See `ready` below.
  const [proReady, setProReady] = useState(false);

  // The topic dialog: closed, creating a topic, or editing this one.
  const [topicDialog, setTopicDialog] = useState<Topic | "new" | null>(null);
  const [apiKey, setApiKey] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [savedMsg, setSavedMsg] = useState<string | null>(null);
  const [copiedUrl, setCopiedUrl] = useState<string | null>(null);
  // The topic warning depends on an article count fetched *before* the dialog
  // opens, so the pending removal carries its message along.
  const [topicToRemove, setTopicToRemove] = useState<{ topic: Topic; message: string } | null>(null);
  // Unlike topicToRemove above, this carries nothing: the reset confirmation
  // says the same thing every time, so there is no reading to travel with it.
  const [confirmingReset, setConfirmingReset] = useState(false);
  const [resetting, setResetting] = useState(false);
  // Bumped after a reset, to send ProPanel back for its own data. It loads
  // once on mount and Settings' reload() does not reach it, so everything it
  // draws — the per-node totals, the org stamps, the list of shared shelves —
  // outlives the rows it was counted over, down to Share buttons carrying
  // collection ids that no longer resolve.
  const [proReloadToken, setProReloadToken] = useState(0);
  // What the reset did, or why it didn't — reported in its own panel rather
  // than through `error` and the shell's notice, which both draw at the top of
  // a page this button sits at the bottom of. The failure is the half that
  // makes this worth the extra state: an error the reader never scrolls up to
  // see reads as nothing having happened, and the natural response to a
  // "delete everything" that appears to have done nothing is to press it again.
  const [resetResult, setResetResult] = useState<{
    kind: "info" | "error";
    message: string;
  } | null>(null);
  // The last reading of the desktop viewer cache, and whether a clear is
  // running — both the shell's now (see ViewerCache for the reading's three
  // states). The section is drawn on settings.desktop rather than on this
  // reading, which is why "unreadable" has to be told apart from "not yet".
  const { cache, clearing: clearingCache } = viewerCache;
  // Reported in this panel rather than through savedMsg or the shell's notice,
  // for the reason resetResult is: both of those draw far from the button that
  // caused them — savedMsg under the Polling heading, three panels up — and a
  // result the reader never sees reads as a click that did nothing.
  const [cacheResult, setCacheResult] = useState<{
    kind: "info" | "error";
    message: string;
  } | null>(null);

  function reload() {
    Promise.all([api.getTopics(), api.getSettings()])
      .then(([d, s]) => {
        setTopics(d);
        setSettings(s);
        setBaseline(s);
      })
      // errorMessage rather than `e.message`: a rejection reason need not be an
      // Error, and reading .message off one that isn't puts an empty banner on
      // screen — or, for a null reason, throws inside the handler that exists to
      // report the failure. The .finally saves the page either way, which is
      // what makes this the smaller cousin of the ProPanel bug and not the
      // same one.
      .catch((e) => setError(errorMessage(e)))
      .finally(() => setLoaded(true));
  }

  useEffect(reload, []);

  // The topics alone, after a change that touched nothing else: one saved, or
  // one removed. reload() fetches the settings too and puts them back over the
  // Polling & NCBI form, taking any edit there not yet saved.
  function reloadTopics() {
    api
      .getTopics()
      .then(setTopics)
      .catch((e) => setError(errorMessage(e)));
  }

  // A fresh reading for a panel that is about to print one. The shell re-reads
  // when the window regains focus, which covers the cache growing; this covers
  // the reader who came here to look at the number. Once the settings say this
  // is the desktop build, and not before: the route 404s everywhere else, and
  // asking anyway would put a failed request in the console of every server
  // deployment on every visit to this page.
  useEffect(() => {
    if (settings?.desktop === true) viewerCache.reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settings?.desktop]);

  async function askRemoveTopic(d: Topic) {
    setError(null);
    let count = 0;
    try {
      count = (await api.topicArticleCount(d.id)).count;
    } catch {
      /* if the count lookup fails, fall through with the gentle warning */
    }
    const message =
      count > 0
        ? `This will permanently delete ${count} stored paper${
            count === 1 ? "" : "s"
          }. Papers that also appear under other topics, or are saved in your Library, are kept. This cannot be undone.`
        : "No stored papers are exclusive to this topic — papers under other topics and in your Library are kept.";
    setTopicToRemove({ topic: d, message });
  }

  async function removeTopic() {
    if (!topicToRemove) return;
    setTopicToRemove(null);
    try {
      const res = await api.deleteTopic(topicToRemove.topic.id);
      reloadTopics();
      onDataChanged();
      if (res.deletedArticles > 0) onPapersRemoved(res.deletedArticles);
    } catch (err) {
      setError(errorMessage(err));
    }
  }

  // Asks first: requestClear puts up the shell's confirmation, and answers with
  // what the clear did once the reader has said to go ahead. Null is them
  // backing out, which leaves nothing to report.
  async function clearCache() {
    setCacheResult(null);
    try {
      const cleared = await viewerCache.requestClear();
      if (cleared) setCacheResult({ kind: "info", message: describeCacheCleared(cleared) });
    } catch (err) {
      setCacheResult({ kind: "error", message: errorMessage(err) });
    }
  }

  async function resetEverything() {
    setConfirmingReset(false);
    setError(null);
    setSavedMsg(null);
    setResetResult(null);
    setResetting(true);
    try {
      const deleted = await api.resetLibrary();
      setResetResult({ kind: "info", message: describeResetDone(deleted) });
      // This panel's own list first — the topics it is still showing are
      // gone — then ProPanel, which is counting over collections
      // that went with them, then the shell, which owns every other view of all
      // of it.
      reload();
      setProReloadToken((n) => n + 1);
      onLibraryReset();
    } catch (err) {
      setResetResult({ kind: "error", message: errorMessage(err) });
    } finally {
      setResetting(false);
    }
  }

  async function copyUrl(url: string) {
    try {
      await copyTextToClipboard(url);
    } catch {
      return; // Copy blocked — skip the "Copied ✓" flash rather than claim success.
    }
    setCopiedUrl(url);
    setTimeout(() => setCopiedUrl((cur) => (cur === url ? null : cur)), 2000);
  }

  // The Open Library switch lives outside the settings form and saves
  // immediately; the PUT has patch semantics so only this key is sent.
  const [librarySaved, setLibrarySaved] = useState(false);
  async function toggleOpenLibrary(on: boolean) {
    if (!settings) return;
    const before = settings;
    setError(null);
    setSettings({ ...settings, library_open: on }); // optimistic; server confirms below
    try {
      const updated = await api.updateSettings({ library_open: on });
      // Patch only library_open from the server response — replacing the whole
      // object would clobber unsaved edits in the settings form. Baseline tracks
      // the same field so the "Save settings" dirty check stays accurate.
      setSettings((s) => (s ? { ...s, library_open: updated.library_open } : updated));
      setBaseline((b) => (b ? { ...b, library_open: updated.library_open } : updated));
      setLibrarySaved(true);
      setTimeout(() => setLibrarySaved(false), 2000);
    } catch (err) {
      setSettings(before);
      setError(errorMessage(err));
    }
  }

  async function saveSettings(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setSavedMsg(null);
    if (!settings) return;
    try {
      const payload: Partial<AppSettings> & { ncbi_api_key?: string } = {
        ncbi_email: settings.ncbi_email,
        poll_cron: settings.poll_cron,
        poll_enabled: settings.poll_enabled,
      };
      if (apiKey.trim()) payload.ncbi_api_key = apiKey.trim();
      const updated = await api.updateSettings(payload);
      setSettings(updated);
      setBaseline(updated);
      setApiKey("");
      setSavedMsg("Settings saved.");
    } catch (err) {
      setError(errorMessage(err));
    }
  }

  // Enable "Save settings" only when the form differs from what's persisted.
  // The API key is write-only (never read back from the server), so any entry
  // there always counts as a change.
  const settingsDirty =
    settings != null &&
    baseline != null &&
    (settings.ncbi_email !== baseline.ncbi_email ||
      settings.poll_cron !== baseline.poll_cron ||
      settings.poll_enabled !== baseline.poll_enabled ||
      apiKey.trim() !== "");

  // Every panel waits for the slowest of them.
  //
  // These load from two independent places — one Promise.all here for the
  // topics and settings, and the Pro panel's own reload
  // — and each used to reveal itself the moment its own data landed. The result
  // was a column that resettled two or three times: the Pro panel would paint
  // its unpaired form, then Sharing would arrive underneath and shove it, and
  // anything the eye had already started reading moved out from under it.
  //
  // One flag rather than each panel keeping its own is the whole point: a
  // second source of truth is how they got out of step to begin with.
  //
  // The Pro half is only waited on when there is a Pro panel. `pro` is null in
  // a free build, where nothing ever sets proReady, and reading it
  // unconditionally would leave the whole page skeletal forever.
  //
  // Read through useReveal, so the stand-ins cross-fade into the panels the way
  // the paper views' do. Everything below takes this one lagged flag, the
  // disabled buttons and the Pro panel included, so the whole page changes in
  // that single faded commit rather than a button enabling a frame ahead of it.
  const ready = useReveal(loaded && (pro == null || proReady));

  // The reading itself, or null when there is not one — in flight, or failed.
  const cacheStats = cache === null || cache === "unreadable" ? null : cache;
  // Pressable when there is something to clear, and when we cannot tell whether
  // there is: an unreadable cache is exactly the case where the press is how
  // the reader finds out, since clearing reports what it did. Not while the
  // first reading is still in flight, which settles in a moment on its own.
  const somethingToClear = cache === "unreadable" || (cacheStats !== null && cacheStats.files > 0);

  return (
    <div className="settings">
      <Banner kind="error" message={error} onDismiss={() => setError(null)} />

      <section className="panel">
        {/* The icon beside the heading rather than in it, where its help would
            become part of the heading's name: a screen reader moving by heading
            would read the whole paragraph as the title of the panel. */}
        <div className="with-tip">
          <h2>Topics</h2>
          <InfoTip text={HELP.topics} />
        </div>
        <button type="button" className="accent-btn" onClick={() => setTopicDialog("new")}>
          Add topic…
        </button>

        <ul className="list scroll-list topic-list">
          {!ready ? (
            // A fixed box, so the panel is the same height however many topics
            // arrive and nothing under it moves on the handoff. Four rows is as
            // many as fit whole.
            ["42%", "30%", "36%", "26%"].map((w, i) => (
              <ListRowSkeleton key={i} w={w} sub={["24%", "20%", "22%", "18%"][i]} />
            ))
          ) : (
            <>
              {topics.map((d) => (
                <li key={d.id}>
                  <span title={d.term}>
                    <strong>{d.name}</strong>
                    <small className={canPoll(d) ? "muted" : "hint warn"}>{scopeLine(d)}</small>
                  </span>
                  {/* A div for the reason .list-label is one: a span in a list
                      row is stacked into a column. */}
                  <div className="list-actions">
                    <button className="link-btn" onClick={() => setTopicDialog(d)}>
                      Edit
                    </button>
                    <button className="link-btn danger" onClick={() => askRemoveTopic(d)}>
                      Remove
                    </button>
                  </div>
                </li>
              ))}
              {topics.length === 0 && <li className="muted">No topics yet.</li>}
            </>
          )}
        </ul>
      </section>

      <section className="panel">
        <h2>Polling & NCBI</h2>
        <Banner kind="success" message={savedMsg} onDismiss={() => setSavedMsg(null)} />
        {!ready && <StackedFormSkeleton cronHint={CRON_HINT} />}
        {ready && settings && (
          <form className="stacked-form" onSubmit={saveSettings}>
            {/* A field with an info icon is a div whose <label> holds only the
                words, and the icon sits beside it. Inside the label, a click
                that missed the icon by a pixel would land on the label and flip
                or focus its control. The help still reaches the field, as its
                description. */}
            <div className="field">
              <span className="label-line">
                <label htmlFor="settings-poll-enabled">Scheduled polling</label>
                <InfoTip id="settings-poll-enabled-help" text={HELP.polling} />
              </span>
              <input
                id="settings-poll-enabled"
                aria-describedby="settings-poll-enabled-help"
                type="checkbox"
                role="switch"
                className="switch"
                checked={settings.poll_enabled}
                onChange={(e) => setSettings({ ...settings, poll_enabled: e.target.checked })}
              />
            </div>
            <label>
              Poll schedule (cron)
              <input
                value={settings.poll_cron}
                onChange={(e) => setSettings({ ...settings, poll_cron: e.target.value })}
                disabled={!settings.poll_enabled}
              />
              <span className="hint">{CRON_HINT}</span>
            </label>
            <div className="field">
              <span className="label-line">
                <label htmlFor="settings-ncbi-email">Contact email</label>
                <InfoTip id="settings-ncbi-email-help" text={HELP.email} />
              </span>
              <input
                id="settings-ncbi-email"
                aria-describedby="settings-ncbi-email-help"
                value={settings.ncbi_email}
                onChange={(e) => setSettings({ ...settings, ncbi_email: e.target.value })}
                placeholder="optional"
              />
            </div>
            <div className="field">
              <span className="label-line">
                <label htmlFor="settings-api-key">NCBI API key</label>
                <InfoTip id="settings-api-key-help" text={HELP.apiKey} />
                {settings.has_api_key && <span className="pill">set <Check size={12} className="inline-icon" aria-hidden /></span>}
              </span>
              <input
                id="settings-api-key"
                aria-describedby="settings-api-key-help"
                type="password"
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
                placeholder={settings.has_api_key ? "•••••• (leave blank to keep)" : "optional"}
              />
            </div>
            <button type="submit" disabled={!settingsDirty}>
              Save settings
            </button>
          </form>
        )}
      </section>

      {/* Absent entirely in a free build — `pro` is null there.

          Mounted from the first render, skeleton or not: its reload runs on
          mount, and withholding it until `ready` would be a deadlock — `ready`
          waits on the answer that mounting is what asks for. So it draws its
          own stand-in, gated on the same flag as everything above it. */}
      {pro && (
        <ProPanel
          ready={ready}
          onReady={() => setProReady(true)}
          desktop={settings?.desktop ?? null}
          onPairingChanged={onPairingChanged}
          onSharingChanged={onSharingChanged}
          reloadToken={proReloadToken}
        />
      )}

      {/* Absent entirely in the desktop build, which binds to loopback with no
          admin token and no server/.env: nothing here is configurable, and no
          address it could print would reach anyone. Pointing at the server
          instructions instead would send someone looking for files the installer
          never created; the README says outright that sharing is unavailable in
          this build, which is the place for it. Run the server build to share.

          Held until `ready` rather than dropped the moment the flag lands, which
          is what `!ready ||` is doing here. The heading and the two bars below
          sit outside the `ready` gate and do occupy height, so keying the
          section on the flag alone made a Pro desktop build paint them and then
          take them away on its own — `ready` is `loaded && proReady` there, and
          Settings' own fetch lands well before the Pro panel reports in. That is
          a lone reflow with nothing else moving, the one thing the stand-ins on
          this page exist to prevent; this way the removal happens inside the
          single coordinated reveal. A free build never had the gap, `ready`
          being just `loaded` when `pro` is null.

          `=== false` rather than `!== true`, so a null flag past `ready` — a
          settings request that failed — withholds the section rather than
          showing a heading over nothing, the same reading the Pro panel gives
          its own null. */}
      {(!ready || settings?.desktop === false) && (
        <section className="panel">
          <h2>Sharing</h2>
          {!ready && (
            <p className="hint" aria-busy="true" aria-label="Loading sharing info">
              {/* Two lines of the paragraph, each bar on a line box of its own:
                  too wide to share one, so the second wraps, and with no margin
                  of its own each line is the text's. The unseen <code> is for
                  the first line, which carries HOST and ADMIN_TOKEN: 12px
                  monospace sits lower than the text around it and makes that
                  line 20px rather than 19.5, by however much its font says. */}
              <SkeletonBar w="85%" h={12} />
              <code style={{ visibility: "hidden" }}>{"​"}</code>
              <SkeletonBar w="60%" h={12} />
            </p>
          )}
          {ready && settings &&
            (settings.share_urls.length === 0 ? (
              <p className="hint">
                Only this machine can connect right now. To let others view your server, set{" "}
                <code>HOST</code> and <code>ADMIN_TOKEN</code> in <code>server/.env</code> and
                restart — see the README&rsquo;s &ldquo;Sharing your server&rdquo; section.
              </p>
            ) : (
              <>
                <p className="hint">
                  Send one of these addresses to anyone on your network. They can view
                  everything except stored PDFs — share those with the{" "}
                  <Share2 size={14} className="inline-icon" aria-hidden /> buttons, or turn
                  on Open Library below. Changing anything still requires the admin token.
                </p>
                <ul className="list">
                  {settings.share_urls.map((url) => (
                    <li key={url}>
                      <span>
                        <code>{url}</code>
                      </span>
                      <button className="link-btn" onClick={() => copyUrl(url)}>
                        {copiedUrl === url ? <>Copied <Check size={13} className="inline-icon" aria-hidden /></> : "Copy"}
                      </button>
                    </li>
                  ))}
                </ul>
                {/* Only the name is the switch's <label>, not the sentence
                    beside it. This switch saves the moment it changes, and
                    turned on it opens every stored file to everyone on the
                    network, so a click meant for selecting that sentence must
                    not reach it. */}
                <div className="open-library">
                  <span>
                    <label htmlFor="settings-library-open">Open Library</label>{" "}
                    {librarySaved && <span className="pill">Saved <Check size={12} className="inline-icon" aria-hidden /></span>}
                  </span>
                  <span className="switch-row">
                    <input
                      id="settings-library-open"
                      aria-describedby="settings-library-open-help"
                      type="checkbox"
                      role="switch"
                      className="switch"
                      checked={settings.library_open}
                      onChange={(e) => toggleOpenLibrary(e.target.checked)}
                    />
                    <span id="settings-library-open-help" className="hint">
                      When on, viewers can freely download stored files and collection zips —
                      no share link needed. When off, files are owner-only and shared via
                      expiring links.
                    </span>
                  </span>
                </div>
              </>
            ))}
        </section>
      )}

      {/* Desktop only, and drawn on the flag rather than on whether the fetch
          worked: a server build has no such cache, and a section that appeared
          only when a request failed would be a section nobody could explain.
          Above "Delete all data" because it is the harmless half of the same
          errand — reclaiming disk — and the destructive control stays last. */}
      {settings?.desktop === true && (
        <section className="panel">
          <h2>Cached copies</h2>
          <p className="hint">
            The cache allows anything you annotate and save to go back into the library.
            If you clear the cache, you will have to reopen files before editing them again.
            {cacheStats !== null && cacheStats.files > 0 && (
              <> Currently {plural(cacheStats.files, "file")}, {formatBytes(cacheStats.bytes)}.</>
            )}
            {cacheStats !== null && cacheStats.files === 0 && <> Nothing is cached right now.</>}
            {/* Said rather than left blank. A reader who cannot see a size and
                cannot press the button has no way to tell a cache that is empty
                from one this panel failed to ask about. */}
            {cache === "unreadable" && (
              <> The cache could not be read just now — clearing it still works, and reports what it did.</>
            )}
          </p>
          {/* The one thing in this section a reader may have to act on, so it
              is a warning rather than another clause of the hint above. A
              check-in can fail — a full disk, a file the viewer still holds, a
              save the viewer never finished — and until now that was a console
              warning in an app with no console: the paper was annotated, the
              viewer reported the save, and the library went on serving the
              older document with every search answering from the older text.
              Reopening the paper is what takes the changes, and the next launch
              tries again on its own. */}
          {cacheStats !== null && cacheStats.unsaved > 0 && (
            <p className="hint warn">
              {plural(cacheStats.unsaved, "cached file")}{" "}
              {cacheStats.unsaved === 1 ? "holds" : "hold"} changes that are not in the library.
              Scibrarian tries again when you reopen the paper and on every launch. Clearing the
              cache is what would lose them.
            </p>
          )}
          <button
            type="button"
            className="accent-btn icon-btn"
            onClick={clearCache}
            disabled={!ready || clearingCache || !somethingToClear}
          >
            {clearingCache ? (
              <span className="btn-spinner" aria-hidden="true" />
            ) : (
              <Trash2 size={12} aria-hidden />
            )}
            {clearingCache ? "Clearing…" : "Clear cached copies"}
          </button>
          {/* After the button, like the reset's report and for the same reason:
              a message inserted above would push the control out from under the
              pointer that just pressed it. */}
          <Banner
            kind={cacheResult?.kind ?? "info"}
            message={cacheResult?.message ?? null}
            onDismiss={() => setCacheResult(null)}
          />
        </section>
      )}

      {/* Last, and deliberately so: the one control here that destroys
          everything sits below every control that builds it, so nothing above
          can be reached past it by accident. Its own panel rather than a row in
          Sharing, because it belongs to no other setting — and the red is on
          the button alone, not the panel, so the section doesn't read as an
          alarm about the settings above it. */}
      <section className="panel">
        <h2>Delete all data</h2>
        <p className="hint">
          Permanently deletes everything in this library: every paper, topic, journal, saved
          folder, collection, and every stored PDF. Your polling and NCBI settings are kept,
          and so are the MeSH and journal reference lists — so the pickers still work when you
          start again.
          {pro && " Your organization pairing and license are kept too."} This cannot be
          undone.
        </p>
        <button
          type="button"
          className="danger-btn"
          onClick={() => setConfirmingReset(true)}
          disabled={!ready || resetting}
        >
          {resetting ? (
            <span className="btn-spinner" aria-hidden="true" />
          ) : (
            <Trash2 size={12} aria-hidden />
          )}
          {resetting ? "Deleting…" : "Delete all data"}
        </button>
        {/* Below the button, where the panels above this one put their banners
            under the heading instead.
            Deliberate, and the reason is the button rather than the banner: a
            message inserted above the hint pushes the control down by its own
            height, out from under the pointer that just pressed it — which for
            the failure case is the pointer about to press it again. Last in the
            panel, it displaces nothing. */}
        {/* The kind is snapshotted alongside the message (see Banner), so the
            fallback here is only ever read on a render where there is nothing
            to draw — it is never the kind of a banner anyone sees. */}
        <Banner
          kind={resetResult?.kind ?? "info"}
          message={resetResult?.message ?? null}
          onDismiss={() => setResetResult(null)}
        />
      </section>

      <TopicDialog
        open={topicDialog != null}
        topic={topicDialog === "new" ? null : topicDialog}
        topics={topics}
        onClose={() => setTopicDialog(null)}
        onSaved={(saved, outcome) => {
          reloadTopics();
          onTopicSaved(saved, outcome);
        }}
      />
      <ConfirmDialog
        open={topicToRemove != null}
        title={topicToRemove ? `Remove "${topicToRemove.topic.name}"?` : ""}
        message={topicToRemove?.message ?? ""}
        confirmLabel="Remove"
        danger
        onConfirm={removeTopic}
        onCancel={() => setTopicToRemove(null)}
      />
      {/* No typed confirmation behind this one, deliberately — see PromptDialog's
          `option`, which makes the argument at length: a forced extra step gets
          pattern-matched and performed within a week, leaving the same mistake
          possible plus a ritual everyone resents. What guards this instead is
          what ConfirmDialog already does — Cancel takes initial focus, so Enter
          on a dialog that appeared unexpectedly cancels — and a message that
          names what goes, in the words the UI already uses for it. See
          RESET_WARNING, which argues that over a row of totals. */}
      <ConfirmDialog
        open={confirmingReset}
        title="Delete all data?"
        message={RESET_WARNING}
        confirmLabel="Delete everything"
        danger
        onConfirm={resetEverything}
        onCancel={() => setConfirmingReset(false)}
      />
    </div>
  );
}
