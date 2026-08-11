# SciLuminate — working notes

## Line endings: match the file, never reformat it

Neither repo (this one or the nested private `pro/`) has a `.gitattributes`, and
both set `core.autocrlf=false`. Git does no translation in either direction, so
**the bytes written to disk are the bytes committed.** An editor or tool that
rewrites a file wholesale in "its" convention therefore lands as a real diff.

Current state — verified 2026-08-10:

| Area | Convention |
|---|---|
| `server/`, `client/`, `shared/` | LF, uniformly |
| `pro/` | **mixed at HEAD.** `routes.ts`, `sync.ts`, `sync.test.ts`, `push.ts`, `push.test.ts` are CRLF; the rest are LF |

**The rule: match whatever the file you are editing already uses.** Do not
normalize a file's endings as a side effect of an unrelated change, and do not
convert `pro/` to one convention without deciding to do that on purpose. Appending
LF lines to a CRLF file is the same mistake in miniature — it leaves one file with
mixed terminators.

Why it is worth the care: a whole-file rewrite turns a 30-line change into a
~2,200-line diff, makes `git blame` attribute every line to that commit, and
conflicts with any concurrent branch touching the file. It also hides the real
change from review.

Check before committing — these two should report the **same** totals:

```bash
git diff --stat
git diff --ignore-all-space --stat
```

If they disagree, whitespace churn crept in. To find which files are affected:

```bash
# lists files whose endings differ from the rest of their directory
git diff --numstat && git diff --ignore-all-space --numstat
```

To repair a file in place, rewrite it with the endings its HEAD version uses
(drop the CR of each CRLF for LF; insert CR before each LF for CRLF) rather than
re-saving it from an editor, which may re-apply the wrong convention.
