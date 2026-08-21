# Version 3: livestream filtering correction

## Why the shown stream was added

Two independent conditions allowed it through:

1. The script only enabled its livestream filter when the row's column F value was exactly `No`. In the supplied screenshot F4 is blank, so the entire live-metadata path was disabled. The `<--` header in F3 has no effect; the code reads F4.
2. Even with the old filter enabled, its documented policy was to reject active broadcasts and completed live-like videos only when they exceeded two hours. The shown archive is `1:56:07`, so the old `passesLiveLikeFilter()` deliberately returned `true`.

The video is already in the playlist. Replacing the script prevents matching future insertions but does not retroactively delete existing playlist items; remove that item manually once.

## Version 3 behavior

Column F is now an explicit policy rather than a fragile exact-value switch:

| F value | Mode | Behavior |
|---|---|---|
| Blank, `Strict`, `No`, `All` | Strict | Preserve `upcoming`; remove active and every completed live-like video, regardless of duration |
| `Long`, `Legacy`, `2h` | Long | Preserve `upcoming`; remove active live broadcasts and completed live-like videos over two hours |
| `Off`, `Yes`, `Keep` | Off | Disable livestream filtering |

Blank defaults to `Strict`, so the current sheet works without adding a new column value. The Debug log now prints the selected mode and a reason whenever it filters or retains a live-like item.

Short-filter parsing is also case-insensitive and whitespace-safe.

## Premiere limitation

The public `videos.list` resource provides:

- `snippet.liveBroadcastContent`: only current `upcoming`, `live`, or `none` state.
- `liveStreamingDetails`: present for upcoming, active, and completed broadcasts.

It does not provide a reliable public field that distinguishes a completed livestream from a completed Premiere. Therefore:

- `Strict` solves the shown archived-stream problem, but can also reject a Premiere first discovered after it completed.
- `Long` is the more Premiere-friendly heuristic, but necessarily keeps short archived streams such as the shown `1:56:07` example.
- `upcoming` remains preserved in both modes, matching the earlier requirement not to blanket-block scheduled Premieres.

The implementation intentionally avoids scraping YouTube's rendered `Streamed`/`Premiered` label because that is undocumented, locale-dependent, and liable to break.

Official references:

- [YouTube video resource](https://developers.google.com/youtube/v3/docs/videos)
- [Videos: list](https://developers.google.com/youtube/v3/docs/videos/list)
- [LiveBroadcasts resource](https://developers.google.com/youtube/v3/live/docs/liveBroadcasts)
- [LiveBroadcasts: list](https://developers.google.com/youtube/v3/live/docs/liveBroadcasts/list)

## Verification

JavaScript syntax validation and eleven regression tests pass. New coverage verifies that:

- blank F defaults to Strict;
- a completed `PT1H56M7S` broadcast is rejected in Strict mode;
- that same broadcast is retained in Long mode, documenting the legacy behavior;
- Off mode makes no metadata request;
- upcoming items remain eligible;
- fifty videos still share one batched metadata request;
- all prior source-error, timestamp, write-budget, and deletion tests continue to pass.
