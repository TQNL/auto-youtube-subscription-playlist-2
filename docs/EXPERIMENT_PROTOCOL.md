# Strict broadcast-policy replay protocol

This protocol turns spreadsheet replays into repeatable evidence for the V5.5
strict-broadcast candidate. It is designed for an isolated test sheet without
storing private target or source IDs in this repository. The retired 90-minute
experiment remains documented separately as historical evidence.

## Invariants

1. Never edit the source cells: column G and every column to its right.
2. Before and after an experiment, compute the SHA-256 source fingerprint exposed
   by `sourceConfigurationFingerprint()` and require an exact match.
3. Record timestamp cells before any deliberate replay-window edit. Restore them
   after read-only candidate replays. After an accepted production validation,
   retain the checkpoint written by production and record its before/after
   values; rewinding it could cause already-processed work to be retried.
4. Run the non-mutating replay first. Do not insert or delete playlist items until
   the candidate classifications and write plan have been reviewed.
5. A metadata read failure is fail-closed: affected videos are not inserted and
   the row checkpoint is retained for retry.
6. Compare candidates by video ID, not by title or playlist position.

## Isolated row under test

- Row 4 is the only configured experiment row. Its unchanged sources and
  historical column-B checkpoint may expose a compact corpus containing ordinary
  uploads, known completed broadcasts, transitional broadcasts, and shorts.
- Row 5 is intentionally blank. It is not a fallback test row and must not be
  populated merely to run this experiment.

## Replay window

For every candidate revision:

1. Capture the row's current timestamp and source fingerprint.
2. If a replay window must be reset before validation, set only B4 to the agreed
   historical ISO timestamp. Never change G4 or any later source cell.
3. Run `replayRow4StrictDryRun()` from the experiment helper.
4. Save the execution log and its structured, compatibility-named
   `PREMIERE_EXPERIMENT_REPLAY_RESULT` line. Require its `policy` field to equal
   `strict-documented-broadcast-markers-v1`.
5. Before a production validation, verify the source fingerprint again. After a
   successful production run, retain the production checkpoint rather than
   rewinding B4.
6. Promote a candidate only when local regression tests, the live dry replay,
   and exact target-membership verification agree with the documented policy.

The replay helpers never update timestamps or playlists. Production execution is
tested separately after the dry-run evidence is accepted. A production run's
checkpoint is evidence and is not reset merely to recreate the historical test
window.

## Classification oracle

A normal upload is kept only when the API returns a valid item, the current
broadcast state is exactly `none`, and `liveStreamingDetails` is absent.

Admission follows this matrix:

- `NORMAL_UPLOAD`: keep it, regardless of duration;
- `UPCOMING`, `ACTIVE`, or `COMPLETED_LIVE`: reject it without blocking the row
  checkpoint;
- `UNKNOWN`, omitted metadata, malformed responses, or failed metadata reads:
  withhold it and retain the checkpoint.

The public API cannot reliably distinguish a completed Premiere from a completed
livestream, so detectable Premieres are intentionally rejected. Duration and
title never override a broadcast marker. Column E's existing shorts filter
remains independent and runs only after strict admission. Column F remains
reserved and ignored.

## Promotion gates

- Syntax validation passes.
- Regression tests pass.
- One `videos.list` request classifies at most 50 candidate IDs.
- Upcoming, active, and completed broadcast-like videos are all rejected without
  blocking checkpoint advancement.
- The known completed Premiere is rejected just like every completed broadcast.
- A long ordinary upload is kept.
- Missing/failed metadata is withheld and blocks the checkpoint.
- One source failure does not erase valid candidates from healthy sources.
- The source fingerprint is unchanged after browser testing.
- After one controlled production run, no known broadcast candidate is newly
  inserted and ordinary eligible candidates behave normally.
- The exact tested commit is pushed and tagged before the next iteration starts.

