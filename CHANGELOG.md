# Version history

The active production candidate is always `sheetScript.gs`. Immutable historical
snapshots live in `versions/`, and promoted revisions receive signed-off Git tags.

## V5.8.1 retry-cap tail safety

- Continue processing remaining candidates when insertion `videoNotFound` is durably deferred for 100 hours or abandoned after its final attempt.
- Guard checkpoint advancement whenever sequential processing stops without a recorded blocking error.
- Add regression coverage for fourth-failure deferral and final abandonment with healthy tail candidates, plus ordinary pre-cap failures. All 118 tests pass.
- Admission filters, retry timing, mutation budgets and project configuration are unchanged.

## V5.8 sequential destination progress

- Candidates are now resolved one at a time against the destination. Each one is
  first proven present or absent — by the two-page inventory when it covers the
  candidate, otherwise by an exact `playlistItems.list(playlistId, videoId)`
  read — and only a proven-absent candidate is revalidated and inserted.
- The membership-probe ceiling that tied read-only checks to the rollback-safe
  write budget is removed. Writes remain bounded by
  `maxPlaylistWriteOperationsPerRun`, with half the remaining operations still
  reserved for rollback. This removes the previous failure mode in which a large
  backlog was rediscovered on every retry and stopped after a fixed number of
  exact checks with `Target membership probe limit of N was reached`.
- An undecidable membership result, a blocking pre-insert revalidation failure, a
  failed insertion, or exhausted insert capacity stops the walk at that candidate
  and retains the row checkpoint. Everything resolved earlier in the same pass is
  kept and is recognised as already present on the next execution, so repeated
  runs move monotonically farther through the same backlog.
- Pre-insert admission revalidation now runs per candidate instead of once per
  row batch. The strict policy is unchanged, but each inserted candidate costs its
  own `videos.list` call, so a large backlog spends more read quota per
  execution than V5.7 did.
- Source discovery is frozen to the `[checkpoint, cutoff]` interval: uploads and
  explicit-playlist reads now receive the row cutoff, and pagination no longer
  stops on a page that merely added no in-window videos. A newest-first page
  containing only post-cutoff videos is skipped rather than treated as the end of
  the interval.
- Replaces the per-row `Added N video(s); skipped N; failed N.` line with one
  `Sequential target progress: checked=…, present=…, insert attempts=…, added=…,
  insert-race skips=…, policy rejected/deferred=…, failed=…, stoppedEarly=…`
  summary.
- Adds five deterministic sequential-progress tests and rewrites the hybrid
  deduplication tests against the new membership API (116 tests across five
  suites). See `docs/SEQUENTIAL_PROGRESS.md`.
- Live-validated on 2026-09-23 against the stuck row. Run 1 exhausted the
  rollback-safe insert capacity (`checked=205, present=131, added=73,
  stoppedEarly=true`) and retained the checkpoint; Run 2 resolved the interval
  (`checked=239, present=204, added=35, stoppedEarly=false`) with no error and
  advanced the checkpoint for the first time since 2026-09-07; Run 3 found
  nothing new and advanced it again. The destination grew 515 → 588 → 623, exactly
  the reported insertions. The retired probe-limit error did not appear. See the
  [validation record](./docs/LIVE_VALIDATION_2026-09-23_V5.8.md).

## V5.7 bounded hybrid destination deduplication

- Destination inventory reads stop after two pages (100 entries). A capped
  inventory remains incomplete; unseen candidates receive exact membership
  checks using the documented playlistId + videoId filter before insertion.
- Reuses positive membership and inventory results within an execution; keeps
  existing exact-probe and rollback-safe write budgets, and fails closed on
  uncertain membership. Known quota exhaustion suppresses further head scans.
- Logs page/probe counts and resolution totals. Source acquisition, retry
  ledgers, strict broadcast rejection, timestamps and cleanup are unchanged.
- Adds seven deterministic cost/safety tests; see docs/HYBRID_DEDUP.md.

## V5.6 bounded video retries

- Adds a persistent, visible `VideoRetries` ledger for each spreadsheet. Four
  candidate-specific failures defer the ID for 100 hours without holding the row
  checkpoint; a final failure permanently abandons it for manual review.
- Reintroduces due IDs independently of the source publication window. Preserves
  user review notes, destination-specific state, and fail-closed storage handling.
- Excludes quota/authentication, whole-request, destination, and failed-rollback
  problems from the per-video failure allowance.
- Rejects ordinary videos over ten hours at initial, pre-insert, and post-insert
  checks. Strict broadcast rejection and the unrelated filters remain in force.
- Adds setup-only `initializeVideoRetries()` and deterministic retry lifecycle
  tests. See `docs/RETRY_QUEUE.md` for exact timing and manual review behavior.

## V5.5 strict broadcast rejection (candidate)

- Retires the 90-minute completed-broadcast exception. Duration no longer
  influences broadcast admission; ordinary long uploads remain eligible.
- Allows only factual `NORMAL_UPLOAD` resources. `UPCOMING`, `ACTIVE`, and
  `COMPLETED_LIVE` are deterministic, non-blocking rejections. This intentionally
  rejects detectable completed Premieres because the public API cannot reliably
  distinguish them from completed livestreams.
- Keeps `UNKNOWN`, missing, malformed, omitted, and failed metadata blocking and
  fail-closed so an unresolved candidate retains the row checkpoint.
- Applies the same decision at the initial batch filter, pre-insert validation,
  post-insert rollback, untracked-insert review, target audit, and read-only
  replay helper.
- Retains V5.4 reliability hardening: per-source error isolation, 50-ID metadata
  batching, exact target-membership probes, malformed-target handling, write
  budgets, and reserved rollback capacity.
- Trigger objects are operational deployment state, not repository state. Live
  trigger replacement and cadence verification are recorded separately from the
  source snapshot.

## Completed-Premiere heuristic experiment (retired, live-validated, unpromoted)

- `v5.4-exp1-premiere-under-90m.gs` is the immutable, line-ending-normalized
  snapshot of the live-validated `sheetScript.gs` source from deployed commit
  `962b91da048706e7a6407e4df28d9121826a9ddd`.
- Branch `experiment/premiere-under-90m` derives from the signed-off V5.3
  candidate and keeps its source, checkpoint, target-read, write-budget, and
  rollback safeguards.
- `classifyVideoStrict()` remains factual. A separate shared admission evaluator
  allows a `COMPLETED_LIVE` item only as a `HEURISTIC_PREMIERE_CANDIDATE` when
  both documented duration sources are valid and
  `max(playback duration, actual end - actual start) <= 5,400 seconds`.
- Upcoming and active broadcasts remain rejected but are checkpoint-blocking so
  they can be reconsidered after completion. Missing, zero, malformed, or
  contradictory completed-broadcast timing is also withheld and blocking.
- The hardcoded boundary is applied identically during initial filtering,
  pre-insert validation, post-insert validation/rollback, untracked-insert
  recovery, target audit, and the independent read-only replay helper.
- Column E's Shorts filter remains independent; column F remains ignored. See
  [the experiment policy and promotion gate](./docs/PREMIERE_90M_EXPERIMENT.md).
- Isolated live validation passed on 2026-08-22 for deployed commit
  `962b91da048706e7a6407e4df28d9121826a9ddd`: the known completed Premiere was
  the only planned and actual insertion, both prepared over-limit completed
  livestreams remained absent, the production checkpoint advanced, and the
  protected source fingerprints were unchanged. See the
  [experiment live-validation record](./docs/LIVE_VALIDATION_2026-08-22_PREMIERE_EXPERIMENT.md).
- The branch remains unpromoted because a genuine completed livestream of at
  most 90 minutes can still pass and transitional broadcasts can retain a
  row-wide checkpoint. Live validation proves the prepared corpus, not a general
  Premiere discriminator.

## Upstream baseline

- `v0-upstream.gs` — the upstream project state at commit `8e0b064`.

## Reliability iterations

- `v1-reliability.gs` — first recovery from the observed source/read failure.
- `v2-error-isolation.gs` — separates source, filter, insert, and maintenance state;
  fixes supported playlist pagination, batching, timestamp safety, and write limits.
- `v3-livestream-modes.gs` — experimental strict/long/off policy. Retained only as
  evidence; keyword modes were too easy to configure incorrectly.
- `v4-duration-cutoff.gs` — per-row duration heuristic. This fixed the blank-cell
  bypass but did not solve type classification or previously inserted broadcasts.

## Strict iterations

Strict versions reject every documented broadcast marker. Duration is used only
for the independent short-video rule.

- `v5-strict-ingestion.gs` — fail-closed candidate classification, pre/post
  insertion revalidation with reserved rollback capacity, and non-mutating
  replay/target-audit tooling. The first production attempt exposed a separate
  deep target-pagination failure, so this snapshot was not promoted by itself.
- `v5.1-target-pagination-resilience.gs` — retains the strict classifier and adds
  partial target inventory plus exact per-candidate membership probes. It never
  treats a generic HTTP 409 as proof of a duplicate. Live production replay added
  41 normal uploads; an identical replay added 0 and skipped all 41. Both rows
  advanced their checkpoints without changing source configuration. See the
  [live-validation record](./docs/LIVE_VALIDATION_2026-08-21.md).
- V5.2 made every channel-derived uploads-playlist read failure blocking. Its
  2026-08-22 live run proved that strict classification still rejected upcoming,
  active, and completed broadcasts, but two first-page `playlistNotFound` errors
  unnecessarily froze row 4's checkpoint. Row 5 still ran and rejected the known
  Premiere, confirming that a failed row does not break the outer row loop. V5.2
  was a transient diagnostic revision and was superseded directly by the archived
  V5.3 candidate rather than retained as a separate source snapshot.
- `v5.3-source-page-liveness.gs` — the current `sheetScript.gs` candidate. Source
  failures are page-aware: a permanently missing playlist on the first source
  page is a warning, while every later-page source failure is blocking and keeps
  candidates already read. Target and metadata-filter 404s are never downgraded
  by this rule. A first-page 404 does not prove a source is empty, so this is an
  explicit liveness tradeoff; lossless handling would require per-source
  checkpoints or persistent disabled-source state.
- Per-row processing and error accounting no longer depend on the auxiliary
  `DebugData` sheet. Row-log, execution-summary, or debug-viewer persistence
  failures are logged best-effort and cannot stop later playlist rows or replace
  the real aggregate result. Failed row logs are re-emitted in bounded execution-
  log chunks so a later `Logger.clear()` cannot erase the only useful evidence.
- Logging itself is non-throwing and backed by an in-memory row buffer, so a
  Logger failure cannot interrupt post-insert validation or mandatory rollback.
- Partial-target membership probes now have an execution-wide ceiling tied to
  rollback-safe write capacity. Quota exhaustion is latched so later rows do not
  repeat the same exact probes; resolved candidates may continue, while every
  unresolved candidate retains its checkpoint.
- Blank rows persist an exact 24-hour retry-floor seed before normal source
  reads and bypass the first frequency gate. Dry runs remain non-mutating, while
  timestamp-suppressed mutation mode with no real checkpoint fails before API or
  playlist work.
- A successful insert response without a usable playlist-item ID is blocking.
  Further inserts stop, one exact recovered handle is rolled back, and ambiguous
  recovery is reported for manual review rather than treated as success.
- The read-only experiment helper now matches production's fail-closed boundary
  for `ALL` subscription reads and malformed target items, and omits the
  unsupported `maxResults` parameter from `videos.list(id=...)` requests.

## Future work

- A possible v6 may revalidate and repair historical target contents. It is not
  part of v5.3 and requires separate authorization because it deletes playlist
  items.
- A durable write-ahead mutation journal would preserve ambiguous insert state
  across Apps Script hard termination or transport-timeout windows. V5.3 retains
  the current checkpoint and requests manual review when immediate exact
  reconciliation cannot identify one rollback handle, but that condition is not
  yet persisted across executions.
