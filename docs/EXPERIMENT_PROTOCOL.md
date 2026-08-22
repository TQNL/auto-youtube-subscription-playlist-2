# Strict-filter experiment protocol

This protocol turns spreadsheet replays into repeatable evidence. It is designed
for the `subscriptionPlaylists_mass_subs` sheet without storing its private source
IDs in this repository.

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

## Rows under test

- Row 4 is the broad subscription/source corpus and exercises mixed uploads,
  source playlists, active/upcoming broadcasts, and completed archives.
- Row 5 is the controlled Premiere case: its unchanged source channel published
  a known Premiere in the replay window. Strict behavior is expected to reject it
  if YouTube exposes a broadcast marker. This is an intentional false positive,
  not a claim that the API can distinguish Premieres.

## Replay window

For every candidate revision:

1. Capture the row's current timestamp and source fingerprint.
2. Set only column B of the selected row to the agreed historical ISO timestamp.
3. Run `replayRow4StrictDryRun` or `replayRow5StrictDryRun`.
4. Save the execution log and its structured `STRICT_REPLAY_RESULT` line.
5. Restore column B and verify the source fingerprint.
6. Promote a candidate only when the local regression suite and both live replays
   agree with the documented policy.

The replay helpers never update timestamps or playlists. Production execution is
tested separately after the dry-run evidence is accepted. A production run's
checkpoint is evidence and is not reset merely to recreate the historical test
window.

## Classification oracle

A candidate is rejected as broadcast-like when any of these is true:

- `snippet.liveBroadcastContent` is `upcoming` or `live`;
- `liveStreamingDetails` exists, including completed broadcasts.

A candidate is kept only when the API returned a valid item, the current broadcast
state is exactly `none`, and `liveStreamingDetails` is absent. Duration never
determines whether something is a livestream.

This oracle deliberately favors zero livestream leakage. The public video schema
does not expose a reliable completed-Premiere discriminator, so strict filtering
can reject Premieres.

## Promotion gates

- Syntax validation passes.
- Regression tests pass.
- One `videos.list` request classifies at most 50 candidate IDs.
- Upcoming, active, and completed broadcast fixtures are rejected.
- A long ordinary upload is kept.
- Missing/failed metadata is withheld and blocks the checkpoint.
- One source failure does not erase valid candidates from healthy sources.
- The source fingerprint is unchanged after browser testing.
- The exact tested commit is pushed and tagged before the next iteration starts.

