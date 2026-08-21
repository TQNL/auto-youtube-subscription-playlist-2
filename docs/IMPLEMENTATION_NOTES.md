# Reliability-fixed Google Apps Script

`sheetScript-fixed.gs` is a complete replacement for the modified script supplied with this task.

## What changed

- Source reads, metadata/filter reads, target writes, cleanup writes, and unexpected row failures now have separate counters. A failed source no longer cancels IDs returned by healthy sources.
- A row with any failure keeps its old timestamp. Successful candidates may still be inserted; on the retry, a target-playlist preload skips videos already present.
- Insertions are iterative rather than recursive. The old `maxVideos = 8000` guard is replaced by an execution-wide ceiling of 150 playlist mutations. Insertion and deletion both consume that budget. If a row cannot fit, the operation is rejected before making a partial set of writes.
- Both filters share one `Videos.list` metadata request per batch of up to 50 IDs. A 50-video run therefore uses one metadata request, not roughly 80–100 per-video requests.
- Explicit source playlists are read using only supported `playlistItems.list` parameters: `playlistId`, `maxResults`, `pageToken`, and `fields`. Every page is traversed and `snippet.publishedAt` is compared locally.
- Cleanup uses the same supported pagination approach and reads every page before deleting anything, preventing page shifts from skipping items.
- The `ALL` source now follows the API's returned `nextPageToken` instead of relying on hard-coded historical tokens.
- Upcoming behavior is intentionally preserved: `upcoming` alone is not rejected. Active `live` items and live-like items exceeding the existing two-hour rules are still filtered.
- Error logging no longer assumes every exception has `details.code`, and debug-log parsing tolerates messages without Apps Script's usual ` INFO: ` prefix.
- A script lock prevents overlapping trigger/menu executions from racing against the same playlists and timestamps.

## Why the playlist fix works

`playlistItems.list` does not support `order`, `publishedAfter`, or `publishedBefore`. Explicit playlists can be manually ordered, so there is no safe early-stop-by-date optimization. The script now follows `nextPageToken` through the complete playlist and filters locally using `snippet.publishedAt`, which the API defines as the time the item was added to the playlist. Channel upload playlists still use `contentDetails.videoPublishedAt`, the video's publication time.

Official references:

- [PlaylistItems: list](https://developers.google.com/youtube/v3/docs/playlistItems/list)
- [PlaylistItem resource fields](https://developers.google.com/youtube/v3/docs/playlistItems)
- [Videos: list](https://developers.google.com/youtube/v3/docs/videos/list)
- [YouTube Data API quota costs](https://developers.google.com/youtube/v3/determine_quota_cost)
- [Subscriptions: list](https://developers.google.com/youtube/v3/docs/subscriptions/list)

## Safety-budget note

The default cap is `maxPlaylistWriteOperationsPerRun = 150`. Each `playlistItems.insert` or `playlistItems.delete` currently costs 50 YouTube quota units, so the cap limits one execution to at most 7,500 mutation units. It is a circuit breaker; the API does not expose this project's remaining daily quota to the script. Lower the value if several executions run each day or other tools share the same Google Cloud project.

## Verification performed

- JavaScript syntax check passed.
- A broken source playlist did not cancel a healthy source's insertion, and the timestamp stayed unchanged.
- Explicit playlist pagination used no unsupported date/order parameters.
- 50 filter candidates caused one metadata request; an upcoming premiere-like item stayed eligible.
- A failed metadata batch did not cancel a later healthy batch.
- The mutation cap refused a partial row before any insertion.
- Cleanup read all pages before issuing deletes and used no unsupported date/order parameters.

## Installation

Keep a backup, then replace the existing Apps Script source with `sheetScript-fixed.gs`. The spreadsheet layout and existing filter semantics are unchanged. The Apps Script project still needs the YouTube Data API advanced service enabled, as before.