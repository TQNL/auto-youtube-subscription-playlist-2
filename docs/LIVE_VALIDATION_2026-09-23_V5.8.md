# V5.8 sequential destination progress — live validation — 2026-09-23

This record covers the live validation of the V5.8 sequential destination-progress
algorithm on the spreadsheet row that had been stuck since 2026-09-07. It proves
that the backlog converged across executions, that previously inserted videos were
recognised as already present, that the destination grew by exactly the number of
reported insertions, and that no duplicates and no unresolved blocking state
remained. It does not prove that new videos arriving between executions can never
extend a backlog indefinitely; the observed runs made no use of that window.

## Tested artifact

- Repository commit under test: `5ca31d3` on `fix/sequential-destination-progress`
  (V5.8 delivered source).
- Deployed `Code.gs` snapshot SHA-256:
  `0f0a11523d1836f2f6797c437d98b0e0bf580b336985bf870f6efb6a1cc1176f`
  (UTF-8 BOM, CRLF, 98,325 characters after the BOM).
- Line-ending-normalized immutable archive
  `versions/v5.8-sequential-progress.gs` SHA-256:
  `7119973dbedae497b88cfc818f04f2c44d93a70100afade21c290fc6b2cd991e`.
  The deployed snapshot and this archive are the same text; they differ only by
  the BOM and CRLF/LF.
- Deployed header line: `// Sequential destination progress v5.8: 2026-09-22`.
- No code, checkpoint or playlist was edited by hand during the test. All three
  runs were started from the spreadsheet menu **Youtube Controls → Update
  Playlists**.

Private destination and source playlist IDs, and the spreadsheet ID, are
deliberately omitted. Public video IDs are retained because exact ID membership,
not titles or playlist positions, is the acceptance oracle.

## Row under test

- Row 8, processed every execution (empty frequency cell), no maintenance
  deletion, no Shorts filter, one explicit source playlist.
- Checkpoint before the run: `2026-09-07T20:16:10+00:00`.
- A pre-run execution while quota was still exhausted acquired 0 videos and
  reported `ERROR [SOURCE]: Cannot read source playlist ... quota ...`, leaving the
  checkpoint unchanged — the expected pre-quota-reset state.

## Runs

| Run | Started (UTC) | Execution stamp | Duration | Row-8 outcome |
| --- | --- | --- | --- | --- |
| 1 | 07:24:14 | Wed Sep 23 07:24:20 UTC 2026 | ~2m50s | stopped at the write-capacity safety limit |
| 2 | 07:38:43 | Wed Sep 23 07:38:47 UTC 2026 | ~2m20s | interval fully resolved, no errors |
| 3 | 07:44:23 | Wed Sep 23 07:44:31 UTC 2026 | ~2m03s | nothing new, checkpoint advanced again |

### Run 1 — row 8 log

```
Row: 8
Acquired 253 unique videos
Strict livestream policy: rejecting upcoming, active, and completed broadcast-like videos; column F is ignored
Strict policy rejected COMPLETED_LIVE: 5JXpNOZWAHM | ... (13 COMPLETED_LIVE rejections)
Strict policy rejected NORMAL_UPLOAD: HfACrKJ_Y2w | title: Calculus 1 - Full College Course | ... | decision: over_10_hour_hard_limit
Filtering finished, left with 239 videos
Target deduplication: stopped at the 2-page scan cap; exact membership checks will resolve unseen candidates.
ERROR [WRITE]: Write safety capacity of 73 insertion attempt(s) was reached after 204 candidate(s); stopped before video vNVorXyTL54. The checkpoint was retained so the next execution can skip completed videos and continue.
Sequential target progress: checked=205, present=131, insert attempts=73, added=73, insert-race skips=0, policy rejected/deferred=0, failed=0, stoppedEarly=true.
Row completed with blocking failures (source=0, filter=0, policy=0, write=1, maintenance=0, unexpected=0). Final checkpoint was not advanced.
```

Row 7 used three write operations in the same execution, which is why row 8's
rollback-safe insert capacity was `floor((150 - 3) / 2) = 73`.

### Run 2 — row 8 log

```
Row: 8
Acquired 253 unique videos
Strict livestream policy: rejecting upcoming, active, and completed broadcast-like videos; column F is ignored
(14 strict policy rejections, the same 14 videos as Run 1)
Filtering finished, left with 239 videos
Target deduplication: stopped at the 2-page scan cap; exact membership checks will resolve unseen candidates.
Sequential target progress: checked=239, present=204, insert attempts=35, added=35, insert-race skips=0, policy rejected/deferred=0, failed=0, stoppedEarly=false.
```

Run 2 contained no `ERROR`, no `WARNING` and no `Row completed with blocking
failures` line. The checkpoint advanced from `2026-09-07T20:16:10+00:00` to
`2026-09-23T07:39:25+00:00`.

### Run 3 — row 8 log

```
Row: 8
Acquired 0 unique videos
Filtering finished, left with 0 videos
No new videos yet.
```

No errors and no blocking line; the checkpoint advanced again from
`2026-09-23T07:39:25+00:00` to `2026-09-23T07:45:17+00:00`.

## Progression

| Metric | Run 1 | Run 2 | Run 3 |
| --- | --- | --- | --- |
| Acquired candidates | 253 | 253 | 0 |
| After filtering | 239 | 239 | 0 |
| Sequentially checked | 205 | 239 | — |
| Already present | 131 | 204 | — |
| Insert attempts | 73 | 35 | 0 |
| Added successfully | 73 | 35 | 0 |
| Failed | 0 | 0 | 0 |
| `stoppedEarly` | true | false | false |
| Stop reason | write safety capacity | interval completed | nothing to do |
| Blocking error | 1 write | none | none |
| Checkpoint after | unchanged | advanced | advanced again |

`present` rises by exactly 73 between the runs, which is exactly what Run 1
added: the previously inserted videos were recognised as already present and
skipped, and the walk continued past the point where Run 1 stopped. That is the
convergence property V5.8 was written for, and it is the opposite of the previous
behaviour, where every retry stopped at the same membership-probe ceiling.

## Destination playlist evidence

| Point in time | Header count | Harvested IDs |
| --- | --- | --- |
| Before Run 1 | 515 videos | 515 unique IDs |
| After Run 1 | 588 videos | top 100 harvested, 100 unique |
| After Run 2 | 623 videos | top 100 harvested, 100 unique |
| After Run 3 | 623 videos | top 100 harvested, 100 unique |

515 + 73 = 588 and 588 + 35 = 623: the destination grew by exactly the number of
insertions the logs reported, and by nothing else. No duplicate insertion was
reported and the item count did not grow beyond the reported additions.

The playlist view is sorted by video publish date while candidates are selected by
when the item was added to the source playlist, so most additions do not appear at
the top of the view. The page's lazy-loading continuation stopped after 100 of 623
items on every attempt, so a full 623-item DOM diff was not possible from the
browser; the header counts and the per-run addition arithmetic are the evidence
used instead.

## Code facts confirmed in the deployed file

- `maxPlaylistWriteOperationsPerRun = 150` and
  `safeInsertCapacity = floor(remaining / 2)`: the rollback reserve is intact.
- `targetMembershipProbesUsed` is still counted but is never compared with a
  limit anywhere in the file. The string `Target membership probe limit of 75`
  does not exist in the deployed code and did not appear in any run.
- The target inventory is capped at two pages by design; every cache miss is
  resolved with an exact `PlaylistItems.list(playlistId, videoId)` read that is
  not charged against the write budget.
- `rowCutoffTimestamp` is created per execution and written to column B only when
  the row has no blocking error, so a capacity stop retains the checkpoint.

## Acceptance criteria

| Criterion | Result |
| --- | --- |
| The retired probe-limit error no longer appears | met (0 occurrences in all runs) |
| The `Sequential target progress: ...` summary appears | met |
| A capacity stop reports the retained checkpoint | met (Run 1) |
| The next execution recognises previous insertions and progresses | met (Run 2: `present` 131 → 204) |
| The destination contains the reported additions | met (515 → 588 → 623) |
| No duplicates are introduced | met (no insert-race skips, exact growth) |
| The row timestamp advances once the interval resolves | met (Run 2, then Run 3) |
| The cutoff is persisted while a backlog is outstanding | not implemented; not needed for this row to converge |

## Residual uncertainties

- The cutoff is still re-frozen on every execution. These runs show convergence
  for a backlog that was fully resolved on the second execution; they do not
  bound the case where new source videos arrive during every retry window.
- Per-candidate pre-insert revalidation costs one `videos.list` call per inserted
  candidate, so a large backlog spends more read quota per execution than V5.7
  did. Run 1's 239 candidates stayed inside the daily quota together with the
  other rows.
- `initializeVideoRetries()` still prints `version: "5.7"` in its
  `RETRY_SETUP_RESULT` line; the value is only logged, never validated.
