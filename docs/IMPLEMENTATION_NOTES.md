# Version 5.3: strict ingestion with page-aware source liveness

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

Observability is outside that control path: row state is recorded before a
non-throwing log call, and an in-memory row buffer preserves evidence if the Apps
Script Logger fails. A missing or malformed insert response ID stops later
inserts and forces exact target reconciliation. One recovered item is rolled
back immediately; zero or multiple matches remain blocking and require manual
review.

When a row has more candidates than the safe capacity, V5 inserts a bounded subset
and retains the checkpoint. A retry reads the target first, de-duplicates successful
earlier insertions, and continues instead of deadlocking forever.

## Target reads and duplicate prevention

The live target returned valid pages and then a `playlistNotFound` error on the
next deep page token. A first-page target failure remains blocking because the
target cannot be verified. A later-page failure is recoverable: V5.1 keeps the
partial inventory and calls `playlistItems.list` with both `playlistId` and
`videoId` for every unresolved candidate.

Ordinary YouTube playlists can contain the same video more than once, so
`playlistItems.insert` is not an idempotency check. A candidate is inserted only
after the target scan or an exact membership probe proves it absent. A failed
probe withholds only that candidate and retains the row checkpoint. Only the
specific legacy reason `videoAlreadyInPlaylist` may be treated as already
present; a generic HTTP 409 remains blocking.

Exact probes after partial target pagination are bounded by both the remaining
rollback-safe insert capacity and an execution-wide ceiling. A quota failure is
latched for later rows. Already resolved candidates may continue, but unprobed or
failed candidates remain unresolved and therefore retain the row checkpoint.

## Source-read checkpoint policy

V5.2 made every channel-derived uploads-playlist error blocking. The live run on
2026-08-22 showed why that was too coarse: strict classification and target
de-duplication succeeded, but two first-page `playlistNotFound` responses froze
row 4's single row-wide checkpoint. Row 5 still ran, rejected its known Premiere
as `COMPLETED_LIVE`, and advanced, proving the outer row loop was already
isolated.

V5.3 records how many pages a source read completed. A permanently missing
playlist before the first source page is a warning, so healthy sources may still
complete and the row checkpoint may advance. Once any source page has been read,
every subsequent failure is blocking and candidates already acquired are
preserved for evaluation. Transient, quota, malformed-response, and other
first-page failures also remain blocking.

This downgrade applies only to source reads. Target reads and metadata-filter
404s remain blocking for any unresolved candidate. A late target scan may still
be recoverable when the partial inventory already proves that every candidate is
present, or when exact membership probes resolve the remainder.

A first-page `playlistNotFound` response does not prove that a derived uploads
playlist is empty. Advancing the row checkpoint is therefore an explicit
liveness tradeoff. Fully lossless semantics require independent per-source
checkpoints or persistent disabled-source state; the current sheet has only one
checkpoint for the whole row.

## Existing target contents

`inspectTargetPlaylistStrict()` is deliberately non-mutating in V5. It paginates
the whole target, classifies video IDs in batches of 50, logs each non-normal item,
and emits a structured `STRICT_TARGET_AUDIT_RESULT` summary. Repair is deferred to
the next version until the real target audit and Premiere replay have been reviewed.

## Live validation

On 2026-08-21, row 4 acquired 94 candidates from the historical checkpoint,
kept 41 normal uploads, and rejected 53 short or broadcast-like videos. Two dead
sources remained non-blocking warnings. The production run added all 41 normal
uploads despite the late target-page failure. Row 5 rejected its one known
Premiere because YouTube exposed completed broadcast metadata.

The same historical checkpoints were then replayed. Row 4 added 0 and skipped
all 41 existing videos; row 5 again rejected the Premiere. Both checkpoints
advanced on both runs, and the source-configuration SHA-256 fingerprint remained
unchanged. See `LIVE_VALIDATION_2026-08-21.md` for the full evidence.

The V5.2 scheduled run on 2026-08-22 again kept the same 41 normal uploads and
rejected 11 completed, 4 active, and 1 upcoming broadcast. It skipped all 41 as
already present. Its two first-page derived-uploads 404s blocked row 4's
checkpoint, while row 5 still rejected `CkmIANn_xZY` as `COMPLETED_LIVE` and
advanced to `2026-08-21T22:25:54+00:00`.

The quota-limited V5.3 replay acquired the same 94 row-4 candidates, rejected 37 shorts,
11 completed broadcasts, 4 active broadcasts, and 1 upcoming broadcast, and
kept 41. The two first-page missing sources were warnings. A target quota error
arrived after 28 pages, but that partial inventory already contained all 41
candidates, so V5.3 inserted 0, skipped 41, and advanced row 4 to
`2026-08-21T22:43:52+00:00`. Row 5 then encountered a metadata quota error,
failed closed, and retained its historical checkpoint. No playlist item was
deleted. Subsequent quota-independent hardening was validated locally but has
not received an exact final row-5 production replay. The regression suite passes
60 of 60 current tests plus 14 of 14 legacy regressions. It forces DebugData
creation, scanning, per-row writes, viewer initialization, summary writes, and
the Apps Script Logger itself to fail, proving that observability cannot stop a
later row, alter accounting, mask the aggregate error, or preempt rollback. When
DebugData is unavailable, substantive row evidence is retained in bounded
execution-log entries across later `Logger.clear()` calls.

## Known limitation

The public `videos.list` schema has no documented discriminator that guarantees a
completed broadcast was a Premiere rather than an encoder livestream. Strict V5
therefore rejects a Premiere whenever YouTube exposes a broadcast marker. This is
the intended safety tradeoff.

V5.3 also has no durable write-ahead mutation journal. When an insert response
omits its item ID, immediate exact reconciliation either rolls back one uniquely
recoverable item or blocks with manual-review evidence. A hard termination,
ambiguous response, or transport timeout can outlive that in-memory evidence.
Persisting and reconciling mutation intent across executions is separate future
work and a promotion boundary, not a condition the current script silently calls
successful.
