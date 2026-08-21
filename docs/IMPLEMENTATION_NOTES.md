# Version 5 candidate: strict ingestion

## Hypothesis

Duration is not a video-type classifier. V5 should prevent livestream leakage by
admitting only videos whose API metadata positively proves they are ordinary
uploads. It intentionally accepts false rejection of Premieres rather than false
acceptance of livestreams.

## Classification

`classifyVideoStrict()` returns one of five states:

- `NORMAL_UPLOAD`: `liveBroadcastContent` is exactly `none` and
  `liveStreamingDetails` is absent. This is the only admissible state.
- `UPCOMING`: current broadcast state is `upcoming`.
- `ACTIVE`: current broadcast state is `live`.
- `COMPLETED_LIVE`: current state is `none`, but historical
  `liveStreamingDetails` exists.
- `UNKNOWN`: required metadata is missing or not recognized.

`UPCOMING`, `ACTIVE`, and `COMPLETED_LIVE` are successful strict-policy
rejections. `UNKNOWN`, malformed responses, omitted requested IDs, and metadata
request failures are fail-closed blocking errors: the affected candidates are not
inserted and the spreadsheet checkpoint is retained.

Column F remains physically reserved so the channel/source columns do not move,
but it has no effect on livestream classification.

## Race containment

Candidate metadata is checked during filtering, immediately before insertion, and
again after insertion. The write budget reserves one rollback operation per insert
attempt. If the final check is forbidden or unverifiable, the returned playlist
item ID is used to remove that insertion.

When a row has more candidates than the safe capacity, V5 inserts a bounded subset
and retains the checkpoint. A retry reads the target first, de-duplicates successful
earlier insertions, and continues instead of deadlocking forever.

## Existing target contents

`inspectTargetPlaylistStrict()` is deliberately non-mutating in V5. It paginates
the whole target, classifies video IDs in batches of 50, logs each non-normal item,
and emits a structured `STRICT_TARGET_AUDIT_RESULT` summary. Repair is deferred to
the next version until the real target audit and Premiere replay have been reviewed.

## Live experiment gates

- Row 4: mixed-source replay from a past timestamp.
- Row 5: known completed Premiere replay from the same window.
- Source configuration fingerprint must be identical before and after.
- Both replays run in dry-run mode first; no timestamp or playlist mutation.
- The target audit is report-only in this version.

## Known limitation

The public `videos.list` schema has no documented discriminator that guarantees a
completed broadcast was a Premiere rather than an encoder livestream. Strict V5
therefore rejects a Premiere whenever YouTube exposes a broadcast marker. This is
the intended safety tradeoff.
