# Playlist testing and NOS incident trace — 12 September 2026

## Reusable harness

`apps-script/PlaylistDiagnostics.gs` is installed as a separate file in the
final production project, without modifying Code.gs or Test.gs. It provides:

- `diagnoseNosPlaylistReadOnly`: metadata, actual production admission decision,
  source page counts/positions/duplicate item IDs/malformed items, source-added
  and video-published times, configured source row/checkpoint, and exact target
  membership. Maximum 20 list requests and 120 seconds checked between calls;
  an in-flight Apps Script API call cannot be forcibly interrupted by this guard.
- `diagnoseNosRetryReadOnly`: exact durable retry status/deadline; zero YouTube
  calls. Uses the production read-only ledger parser, including validation.

Neither function updates spreadsheets, inserts/deletes playlist entries, changes
triggers, releases checkpoints, or consumes the per-video retry allowance. They
run manually only. The core accepts an injected API for deterministic fault tests.

Local command: `node tests/run-playlist-tests.js`. It runs the current production
regressions, retry lifecycle tests, hybrid-dedup tests and diagnostic/replay tests.
Coverage includes source failures and pagination, malformed/omitted metadata,
filters and broadcast transitions, deep duplicates, quota/probe/write limits,
insertion failures and rollback, checkpoint retention, queue persistence errors,
100-hour deferral/final abandonment, and diagnostic call limits. It does not prove
every possible external failure or the absence of races between separate writers.

## Live result

At 17:58:42–17:58:47 UTC, the diagnostic completed with 12 YouTube reads, no
mutations, and no API errors. Source `PLcz8MliLAY0d14lip6PaioP3aXSEOAXyC`
(NOS op 3 / Explainers) returned 462 items over ten pages (nine times 50, then
12), positions 0–461, no duplicate item IDs, no malformed items, no repeated
page token. The previous pagination failure was NOT reproduced; this result
does not prove its historical cause or that it cannot recur.

The screenshot's first video link resolves to `ozBfToKlFLw`, title
“Dus jij denkt dat je dit lichaamsdeel kent?”. Current API evidence:

- Added to source: 2026-09-11 14:59:18 UTC.
- Video published: 2026-09-12 08:00:09 UTC.
- Duration 608 seconds, public, processed, liveBroadcastContent=none, no
  liveStreamingDetails; production admission result NORMAL_UPLOAD / allowed.
- Priority row 6 checkpoint: 2026-09-12 16:06:36 UTC.
- Exact priority-target membership: absent at the time of this check.

The zero-quota ledger check at 18:00:48 UTC confirmed WAITING_100H, four failures,
first attempt 2026-09-11 16:06:55.098 UTC, last attempt 22:07:28.634 UTC,
due 2026-09-16 02:07:28.634 UTC (04:07:28 Netherlands time). The saved reason is
omission from a successful metadata response. These failures all preceded the
reported public publication time. That supports pre-publication unavailability
as the explanation, but historical privacy/processing state is not recoverable
from today's response and is not claimed as proven.

## Diagnosis and patch decision

This is not presently a bad-duration/broadcast filter or deduplication bug. The
requested 100-hour quarantine intentionally suppresses this now-available video.
It is preserved in VideoRetries and reintroduced independently of the source
checkpoint when due, on the first applicable scheduled run at/after that time.
A local replay test uses the exact ID/deadline and confirms both pre-deadline
suppression and due-time rediscovery with an empty source candidate list.

No speculative production patch, early retry, manual insertion, or timestamp
rewind was applied. Shortening/rechecking the 100-hour quarantine would be a
policy change, not a repair of the implemented policy. The historical pagination
guard remains fail-closed; ignoring a repeated token could permanently lose
unread candidates. The harness now provides page-level evidence for recurrence.

Google documents the distinction between playlist-item added time and the
video's publication time in the [playlistItems resource reference](https://developers.google.com/youtube/v3/docs/playlistItems).
