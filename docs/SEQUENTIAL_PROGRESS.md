# V5.8 sequential destination progress

Status: **live-validated on 2026-09-23** against the row whose checkpoint had been
stuck since 2026-09-07. This document records the algorithm and its deterministic
test coverage; the production run evidence is in
[`LIVE_VALIDATION_2026-09-23_V5.8.md`](./LIVE_VALIDATION_2026-09-23_V5.8.md).

Immutable source: [`versions/v5.8-sequential-progress.gs`](../versions/v5.8-sequential-progress.gs).

## Problem this version addresses

V5.7 resolved destination membership in two phases: a capped two-page inventory,
then exact `playlistItems.list(playlistId, videoId)` checks for unresolved
candidates. The number of exact checks was tied to the rollback-safe write
budget, so a row whose backlog exceeded that budget stopped with:

```
Target membership probe limit of N was reached; M unresolved candidate(s) were withheld and the checkpoint will be retried
```

Because the checkpoint was retained, every retry rediscovered the same interval
and stopped at the same point. Progress depended on candidates happening to
resolve within the capped prefix, which a large backlog did not guarantee.

## Algorithm

For each destination row:

1. Freeze `cutoff` near the start of the execution and read the row checkpoint.
2. Discover and filter source videos inside `checkpoint <= video <= cutoff`.
3. Walk the candidates in order and resolve each one:
   - **present** — the inventory contains it, or an exact read proves membership.
     The candidate is resolved and the walk continues.
   - **absent** — revalidate the strict admission policy, then attempt one insert.
   - **unknown** — membership could not be determined. Stop and retain the
     checkpoint.
4. Stop and retain the checkpoint when a pre-insert revalidation blocks, an
   insertion fails, or the rollback-safe insert capacity is exhausted.
5. Advance column B only when every candidate in the frozen interval was
   resolved without a blocking error.

The write safety limit is deliberately retained: at most half of the remaining
mutation operations in an execution may be insert attempts, so every successful
insert still has a reserved rollback operation available.

### What changed relative to V5.7

| Area | V5.7 | V5.8 |
| --- | --- | --- |
| Membership reads | capped by the rollback-safe write budget | uncapped; each miss is resolved exactly |
| Unresolved candidate | withheld individually, walk continued | stops the walk at that candidate |
| Pre-insert revalidation | one batched call per row | one call per inserted candidate |
| Source reads | filtered by checkpoint only | filtered by `[checkpoint, cutoff]` |
| Pagination stop | page added no in-window videos | page holds no item at or after the checkpoint |
| Row summary log | `Added N video(s); skipped N; failed N.` | `Sequential target progress: …` |

## Expected multi-run behaviour

With a backlog larger than one execution may write:

- **Run 1** inserts up to capacity, stops, and retains the checkpoint.
- **Run 2** rediscovers the same interval, recognises run 1's insertions as
  present, and continues farther into the backlog.
- Eventually every candidate in the interval resolves with no blocking error and
  column B advances to that execution's cutoff.

`tests/sequential-progress.test.js` asserts exactly this: across four runs of a
12-video backlog with a capacity of three inserts per run, the examined prefix
grows `4 → 7 → 10 → 12`, insertions are never repeated, and the destination ends
up containing each video exactly once.

## Known limitations and things to watch

- **The cutoff is re-frozen, not persisted.** Each execution freezes its own
  cutoff, so videos published between executions join the interval. Convergence
  relies on previously inserted videos being recognised as present. The
  2026-09-23 validation showed that property holding in production (`present`
  131 → 204 after a run that added 73 videos), but it does not bound the case
  where new source videos keep arriving during every retry window.
- **One extra read per run.** Membership is proved before the capacity check, so
  the candidate that trips the capacity stop has already been read. This is one
  additional quota unit per destination per execution.
- **Higher read cost for large backlogs.** Per-candidate pre-insert revalidation
  costs one `videos.list` call each, where V5.7 batched up to 50 IDs per call.
  Read quota headroom, not the write budget, becomes the limiting factor for very
  large rows.
- **Row-wide checkpoint granularity is unchanged.** A blocking condition anywhere
  in the interval still retains the whole row checkpoint; the version makes that
  retention convergent rather than terminal.
- **Stale setup marker.** `initializeVideoRetries()` still reports
  `version: "5.7"` in its `RETRY_SETUP_RESULT` line. V5.6 and V5.7 both bumped
  that literal, so this is an oversight in the delivered source rather than an
  intentional schema marker (the value is only logged, never validated).
  `versions/v5.8-sequential-progress.gs` and `sheetScript.gs` were committed
  exactly as delivered, with line endings normalized to LF and nothing else
  changed, so the snapshot still matches the code that was live-validated on
  2026-09-23. The marker should be corrected in the next revision.

## Test coverage

`node tests/run-playlist-tests.js` — 116 tests across five suites:

- 76 current-behaviour tests (`tests/current.test.js`), including the rewritten
  capacity and membership-semantics cases;
- 21 retry-lifecycle tests (`tests/retry-queue.test.js`);
- 7 hybrid deduplication tests (`tests/hybrid-dedup.test.js`), rewritten against
  the `checkTargetVideoMembership()` contract;
- 5 sequential-progress tests (`tests/sequential-progress.test.js`);
- 7 playlist diagnostics tests (`tests/playlist-diagnostics.test.js`).

The retired `Target membership probe limit of N was reached` string is asserted
absent in both the current-behaviour and sequential-progress suites.
