# `data/` — the dataset

This directory is the output of the simulation and the only thing in the
repository that the daily workflow writes to. It is committed on purpose: the
dataset *is* the project's result, and a research claim you cannot replay is
not a result.

```
events.jsonl              the append-only ledger; the only source of truth
state.json                a cache of replaying it, rebuildable at any time
briefs/YYYY-MM-DD.json    what every portfolio read that day, hashed
prices/YYYY-MM-DD.json    the point-in-time price snapshot behind the brief
decisions/YYYY-MM-DD/     one record per portfolio per day, rationale included
```

Two rules govern everything here.

**`events.jsonl` is append-only.** Nothing edits a line, and nothing rewrites
the file. Every balance in `state.json` is derived by replaying it, so deleting
`state.json` and running `pnpm rebuild-state` reproduces it byte for byte. If
the two ever disagree, the log is right.

**Briefs and price snapshots are written once.** They are the record of what
was knowable on a given day, and every decision record cites the hash of the
brief it read. Re-fetching a day's prices later would rewrite the past — Yahoo
revises its history, and the whole no-look-ahead argument rests on these files
not moving.

Run `pnpm verify` to replay the log and check every invariant, including that
no fill used a price that appeared in the brief that caused it.
