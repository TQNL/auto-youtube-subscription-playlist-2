# Completed-Premiere heuristic experiment protocol

This protocol turns spreadsheet replays into repeatable evidence for the
`experiment/premiere-under-90m` branch. It is designed for the isolated
`subscriptionPlaylists_test_env` sheet without storing its private target or
source IDs in this repository. The promoted strict V5.3 protocol remains
documented by the V5.3 archive and `STRICT_POLICY.md`.

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

- Row 4 is the only configured experiment row. Its two unchanged sources and
  historical column-B checkpoint expose a compact corpus containing a known
  completed Premiere, completed long streams, and an unrelated short.
- Row 5 is intentionally blank. It is not a fallback test row and must not be
  populated merely to run this experiment.

## Replay window

For every candidate revision:

1. Capture the row's current timestamp and source fingerprint.
2. If a replay window must be reset before validation, set only B4 to the agreed
   historical ISO timestamp. Never change G4 or any later source cell.
3. Run `replayRow4StrictDryRun()` from the experiment helper.
4. Save the execution log and its structured
   `PREMIERE_EXPERIMENT_REPLAY_RESULT` line.
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

A completed broadcast-like item is admitted as a heuristic Premiere candidate
only when all of these are true:

- `snippet.liveBroadcastContent` is `none`;
- `liveStreamingDetails.actualStartTime` and `actualEndTime` are strict, valid
  ISO-8601 instants and the end is after the start;
- `contentDetails.duration` is a valid positive ISO-8601 duration;
- the greater of playback duration and actual elapsed broadcast time is at most
  the hardcoded 5,400-second cutoff.

A candidate is rejected or withheld when any of these is true:

- `snippet.liveBroadcastContent` is `upcoming` or `live`: reject it now and retain
  the checkpoint so a Premiere can be reconsidered after completion;
- a completed broadcast exceeds 5,400 seconds: reject it;
- required classification or duration/timestamp evidence is missing or invalid:
  withhold it and retain the checkpoint.

Column E's existing shorts filter remains independent and runs after this
admission decision. Column F remains reserved and ignored. The heuristic cannot
prove that an admitted short completed broadcast was a Premiere; it deliberately
accepts that residual false-positive risk to recover completed Premieres.

## Promotion gates

- Syntax validation passes.
- Regression tests pass.
- One `videos.list` request classifies at most 50 candidate IDs.
- Upcoming and active broadcasts are rejected and block checkpoint advancement.
- The known completed Premiere is the only broadcast-like item planned for
  insertion in the isolated replay.
- Both known long completed streams are rejected by the greater-of-two-durations
  rule.
- A long ordinary upload is kept.
- Missing/failed metadata is withheld and blocks the checkpoint.
- One source failure does not erase valid candidates from healthy sources.
- The source fingerprint is unchanged after browser testing.
- After one controlled production run, the target contains the known Premiere
  and does not contain either known long stream.
- The exact tested commit is pushed and tagged before the next iteration starts.

