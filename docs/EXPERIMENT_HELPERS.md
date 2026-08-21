# Experiment helper integration

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
  timestamp, discovers candidates, classifies them, reads the target for a write
  plan, and emits one `STRICT_REPLAY_RESULT` JSON log line.

The structured replay result contains video IDs because the experiment protocol
compares candidates by ID. It contains source hashes and source column numbers,
but never channel IDs or source-playlist IDs.

## Main-code assumptions

- The existing `sheetID` script property identifies the production spreadsheet;
  a bound active spreadsheet is the fallback. The first worksheet must have
  `Playlist ID` in A3.
- Rows start at 4, the timestamp is in B, the shorts switch is in E, and sources
  begin in G. These are the same reserved positions used by the current script.
- The Advanced YouTube Data API service is enabled.
- When the main script's pure `classifyVideoStrict()` and
  `isLessThanThreeMinutes()` functions exist, the replay calls them so the live
  oracle and short-video behavior stay identical. Local fallbacks make the
  experiment file independently testable.
- Strict broadcast classification is intentionally independent of V4's
  duration-based `passesLiveLikeFilter()`: column F is read by neither the strict
  classifier nor the source reader.
- `videos.list` is batched at 50 IDs and explicitly requests `maxResults: 50`.
  Missing, malformed, or failed metadata is withheld and makes
  `checkpointWouldAdvance` false.
- A permanent missing source is a warning, matching V4's error isolation. Other
  source failures are blocking, but candidates obtained from healthy sources are
  still classified.

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
`alreadyPresentIds` and `wouldInsertIds`.

Run `snapshotExperimentRows()` before testing, retain its
`sourceConfigurationHash`, and call
`assertSourceConfigurationUnchanged(savedHash)` after testing. The replay also
checks that invariant before returning and again in a `finally` block.
