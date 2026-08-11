# SciLuminate — working notes

## Never reformat a file as a side effect

Line endings used to be the whole of this section, and are now settled by
machine. Both repos — this one and the nested private `pro/` — carry a
`.gitattributes` saying `* text=auto eol=lf`. Git normalises text to LF in the
object store on commit and checks it back out as LF on every platform, so a tool
that saves CRLF can no longer land it as a diff. `core.autocrlf=false` is still
set in both, and no longer matters: the attribute wins.

Verified 2026-08-11: no tracked text file in either repo contains a CR byte, in
the working tree or at HEAD. The only CRs anywhere are inside
`electron/build/icon.{png,ico,icns}`, which are declared `binary`. `pro/`'s five
CRLF sources were normalised in its `d8c2a36` "Normalize pro sources to LF"; this
repo's rule arrived in `c32176c`. There is no longer a mixed area to be careful
around, and nothing to match by hand.

**What is not automated is the rest of it.** Git normalises line terminators and
nothing else, so every other kind of wholesale rewrite still lands as a real
diff: re-indenting, rewrapping prose or JSX, changing quote style, reordering
imports, stripping or adding trailing whitespace across a file. The rule that
matters is therefore the general one:

**Change the lines the task requires and leave every other line byte-identical.**
Match the file's existing indentation, wrapping and quoting rather than your
tool's defaults. If a formatter wants to reformat a file you are editing for an
unrelated reason, that is a separate, deliberate commit.

Why it is worth the care: a whole-file rewrite turns a 30-line change into a
~2,200-line diff, makes `git blame` attribute every line to that commit, and
conflicts with any concurrent branch touching the file. It also hides the real
change from review.

Check before committing — these two should report the **same** totals:

```bash
git diff --stat
git diff --ignore-all-space --stat
```

A gap between them is whitespace churn, and `--numstat` in place of `--stat`
names the files it is in:

```bash
git diff --numstat && git diff --ignore-all-space --numstat
```

Read the gap before acting on it: a re-indent that the change genuinely required
— wrapping four existing lines in a new conditional, say — shows up here too and
is not churn. What you are looking for is a file whose gap is larger than the
edit you made.

Run both in `pro/` as well. It is a separate repository, so a `git diff` at the
top level says nothing about it.
