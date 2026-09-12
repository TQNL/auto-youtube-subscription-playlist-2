# V5.6 bounded video retries

Each spreadsheet has its own visible `VideoRetries` sheet. Records are keyed by
destination playlist ID and video ID, not by row number. Rows can be moved without
losing their retry history. The existing livestream and Shorts policies remain in
force; retries never bypass the admission checks.

## Lifecycle

1. An individual candidate may fail four times: the initial attempt plus three
   retries on eligible scheduled executions. Multiple failures for the same
   destination/video in one execution count only once.
2. The first three failures remain `RETRYING` and retain the existing conservative
   checkpoint behavior. Healthy candidates can still be processed.
3. The fourth failure is durably saved as `WAITING_100H`. That video stops holding
   the row checkpoint back. Its due time is exactly 100 hours after this failure.
4. On the first eligible scheduled execution at or after that time, the saved ID
   is added back to the candidates even if its publication date is now outside the
   source's discovery window. This is one final attempt, not another retry cycle.
5. A successful insertion and validation (or confirmed existing membership) marks
   the record `RESOLVED`. Another individual failure marks it `ABANDONED`.
   A deterministic policy rejection on the final attempt also marks it
   `ABANDONED` with the reason. Abandoned IDs are never automatically attempted
   again for that destination.

The scheduled trigger must still run, and the destination must still be configured
and eligible. This is not a new precisely timed 100-hour trigger. Stored dates are
displayed in the spreadsheet's timezone; elapsed-time calculations use timestamps.

## Which failures count?

The cap covers candidate-specific problems such as an omitted video in an otherwise
successful metadata response, unusable metadata/duration, and insertion
`videoNotFound`. Post-insert validation failures count only after successful rollback.

Quota exhaustion, authorization problems, whole metadata-request failures,
unreadable destinations, failed rollback, and retry-storage failures are not evidence
that a particular video is bad. They retain blocking/error handling and do not use
up its allowance or abandon it. Thus a final attempt interrupted by infrastructure
failure remains pending for a later eligible execution.

## Stored evidence and manual review

The sheet records destination, video ID, status, failed-attempt count, first/last
failure times, due time, last reason, source row, title when available, and video URL.
`Review notes (user)` belongs to the user and is never overwritten by the script.
Successful and rejected records are retained, too. `REJECTED` means a tracked
candidate was conclusively rejected before its final delayed attempt.

Review `ABANDONED` records manually using the video URL and last reason. Keep these
records: deleting them would remove the persistent suppression. No automatic replay
or deletion is performed on abandoned IDs. Notes can record a manual decision.
Do not edit machine-managed IDs, status, counters, or timestamps casually; malformed
or duplicate records fail closed rather than silently losing retry state.

Every queue update is written and flushed before the script treats the candidate
as safely deferred. If storage fails, its checkpoint is not released.

## Ten-hour safety limit

All candidates must have a valid positive duration. Ordinary uploads longer than
36,000 seconds are rejected; exactly 10 hours is allowed. This check is shared by
initial filtering, pre-insert validation, and post-insert validation/rollback.
Unknown or zero duration is not interpreted as a short video and follows the
bounded retry mechanism. Broadcast rejection remains strict regardless of duration.
Existing playlist items are not retroactively deleted by this update.

## Deployment and verification

Replace `Code.gs` with `sheetScript.gs`; keep the existing companion files and
triggers. `initializeVideoRetries()` is an optional setup-only check: it creates or
validates the ledger and reports the bound spreadsheet ID and policy constants.
It makes no YouTube calls, changes no playlist timestamps, and does not execute the
playlist updater. Normal scheduled execution also initializes the ledger as needed.

The automated tests use a controlled clock to verify the 100-hour boundary, saved
state across executions, final abandonment, quota/storage exceptions, rollback,
batching, and duration boundaries. This is simulated elapsed-time verification,
not a claim that a real 100-hour production cycle has already completed.

References: [YouTube duration metadata](https://developers.google.com/youtube/v3/docs/videos#contentDetails.duration),
[Apps Script spreadsheet flush](https://developers.google.com/apps-script/reference/spreadsheet/spreadsheet-app#flush()).
