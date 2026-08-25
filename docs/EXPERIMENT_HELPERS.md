# V5.5 strict-policy helper integration

`apps-script/Experiment.gs` is designed to be added to the same Apps Script
project as `sheetScript.gs`. It provides read-only evidence helpers; it is not a
second production updater.

## Public helpers

- `sourceConfigurationFingerprint()` hashes exactly G:lastColumn for
  rows 4:lastRow. Source values and formulas are never returned or logged.
- `snapshotExperimentRows()` logs and returns A:F for rows 4 and 5, one source
  hash per row, and the full source-configuration hash. It never returns G+.
- `assertSourceConfigurationUnchanged(expectedHash)` throws when any source
  value, formula, row bound, or column bound changed.
- `replayRow4StrictDryRun()` and `replayRow5StrictDryRun()` call
  `replayStrictDryRun(rowNumber)`. The generic replay reads the existing column-B
  timestamp, discovers candidates, applies strict broadcast rejection, reads the
  target for a write plan, and emits one compatibility-named
  `PREMIERE_EXPERIMENT_REPLAY_RESULT` JSON log line.
- `diagnoseRow4TargetAccessReadOnly()` and `diagnoseTargetAccessReadOnly()` verify
  the authorized YouTube identity, exact target lookup, ownership visibility,
  first-item access, and full pagination without mutating the playlist or sheet.
  IDs are hashed before logging.
- `verifyRow4PremiereExperimentTargetReadOnly()` is retained as a historical,
  read-only corpus helper. It fully paginates row 4's target and reports exact
  membership booleans for the three public experiment videos. It does not define
  current admission policy.

The structured replay result contains video IDs because the experiment protocol
compares candidates by ID. It contains source hashes and source column numbers,
but never channel IDs or source-playlist IDs.

Large forensic payloads can exceed Apps Script's per-line log display. For
backward compatibility, the helper still emits a compact
`PREMIERE_EXPERIMENT_REPLAY_SUMMARY` first, followed by the complete
`PREMIERE_EXPERIMENT_REPLAY_RESULT` payload. The result's `policy` field is
`strict-documented-broadcast-markers-v1`.

## Main-code assumptions

- The existing `sheetID` script property identifies the production spreadsheet;
  a bound active spreadsheet is the fallback. The first worksheet must have
  `Playlist ID` in A3.
- Rows start at 4, the timestamp is in B, the shorts switch is in E, and sources
  begin in G. These are the same reserved positions used by the current script.
- The Advanced YouTube Data API service is enabled.
- When the main script's pure `classifyVideoStrict()`, shared
  `evaluateVideoAdmissionPolicy()`, and `isLessThanThreeMinutes()` functions
  exist, the replay delegates to them. Equivalent local fallbacks make the
  experiment file independently testable and are covered by parity tests.
- Factual broadcast classification and admission are independent of duration.
  `NORMAL_UPLOAD` is allowed; `UPCOMING`, `ACTIVE`, and `COMPLETED_LIVE` are
  non-blocking rejections; `UNKNOWN` is withheld and blocking. Column F is read
  by neither the evaluator nor the source reader.
- `videos.list` is batched at 50 IDs. Its `id` requests deliberately omit
  `maxResults`, which the API does not support together with `id`. Missing,
  malformed, omitted, or failed metadata is withheld and makes
  `checkpointWouldAdvance` false.
- Source reads track how many complete pages were received. A permanently
  missing playlist before the first source page is a warning. Any failure after
  at least one page is blocking, while candidates from completed pages and
  healthy sources are preserved and still classified.
- The first-page warning is limited to permanent missing-playlist errors. Quota,
  transient, malformed-response, and other failures are blocking. Target-read
  and metadata-filter 404s are also blocking; they are not reclassified as
  source warnings.
- The special `ALL` subscription source has no independently disposable
  playlist ID. Every subscription-page failure and every subscription item
  without a channel ID is therefore blocking, even when valid channel IDs from
  completed items remain available for diagnosis.
- A target item without a video ID makes the replay's target inventory
  incomplete and blocks `checkpointWouldAdvance`; it is never treated as proof
  that a candidate is absent.
- A first-page 404 does not prove that a source is empty. This behavior chooses
  row liveness under the sheet's single row-wide checkpoint. Fully lossless
  handling would require per-source checkpoints or persistent disabled-source
  state.

## Mutation boundary

The helpers do not call `processPlaylistRow()`, `applyFilters()`,
`addVideosToPlaylist()`, or `deletePlaylistItems()`. They also do not toggle the
main script's `experimentDryRun`, replace `currentRowStatus`, or populate
`targetPlaylistVideoCache`. This is deliberate: the replay must read an existing
column-B timestamp and must remain safe even if the production pipeline changes.
`inspectTargetPlaylistStrict()` returns aggregate audit counts rather than the
per-ID write plan needed here, so the helper performs its own read-only target
scan. It contains no `setValue`, `setValues`, `insert`, or `delete` operation.
Target access is only `playlistItems.list`, used to calculate
`alreadyPresentIds`, `wouldInsertIds`, and the explicit read-only experiment
membership proof.

Run `snapshotExperimentRows()` before testing, retain its
`sourceConfigurationHash`, and call
`assertSourceConfigurationUnchanged(savedHash)` after testing. The replay also
checks that invariant before returning and again in a `finally` block.
