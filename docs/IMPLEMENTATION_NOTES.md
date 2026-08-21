# Version 4: per-row livestream duration cutoff

## Why the 2:33:33 and 3:33:15 streams were added

The previous reliability-fixed script still treated column F as an exact switch:

```js
var filterLongLiveLike = F4 == "No";
```

In the supplied sheet, F4 is blank. Therefore `filterLongLiveLike` was false. Since E4 is `No`, the shared filtering function still ran, but it requested only `contentDetails`; it did not request `snippet` or `liveStreamingDetails`, and it never called the live-like filter. The two videos were longer than the shorts threshold, so they survived. Their being 2.5 or 3.5 hours long made no difference because the duration cutoff branch was completely disabled.

## Column F behavior

Column F now directly holds the cutoff for completed live-like videos:

- `2` means two hours.
- `1.5` means one hour and thirty minutes.
- `02:30` or `02:30:00` means two hours and thirty minutes.
- A blank cell safely defaults to two hours.
- `0` rejects every completed live-like item with a positive observed duration.

Only completed live-like videos strictly over the cutoff are removed. A video exactly equal to the cutoff is kept. Active livestreams are always removed. Upcoming items are always preserved so scheduled Premieres are not blanket-blocked.

Old keywords such as `Strict`, `Long`, `Off`, `Yes`, or `No` are no longer accepted in column F. An invalid F value creates a blocking filter error, uses the two-hour fallback for that execution, and withholds the row timestamp so the configuration can be corrected without silently losing retry candidates.

For a Google Sheets duration cell, the code reads the displayed `HH:MM[:SS]` value instead of mistakenly treating the underlying day fraction as hours.

## Filtering details

The script always requests `snippet,contentDetails,liveStreamingDetails` in one `videos.list` call for each batch of up to 50 IDs. It identifies completed live-like items through `liveStreamingDetails`, because `snippet.liveBroadcastContent` changes to `none` after completion.

For a completed live-like video, the cutoff uses the greater of:

- the encoded `contentDetails.duration`; and
- the `actualStartTime` to `actualEndTime` live window.

This prevents a stream from slipping through when one duration field is slightly shorter or stale. If YouTube marks an item as completed/live-like but supplies no usable duration yet, the video is withheld and the timestamp is retained for retry instead of letting it through.

The public API still does not expose a reliable completed-livestream-versus-completed-Premiere discriminator. A completed Premiere longer than the selected cutoff can therefore also be removed. Upcoming items remain preserved.

Replacing the code does not delete streams already present in a playlist; remove the shown existing entries manually.

Official references:

- [YouTube video resource](https://developers.google.com/youtube/v3/docs/videos)
- [Videos: list](https://developers.google.com/youtube/v3/docs/videos/list)
- [LiveBroadcasts resource](https://developers.google.com/youtube/v3/live/docs/liveBroadcasts)

## Verification

Fourteen regression tests pass. They cover the shown 2:33:33 and 3:33:15 archives, blank/default and numeric cutoffs, Google Sheets duration values, upcoming items, active streams, exact-cutoff behavior, long normal uploads, unresolved live metadata, one metadata request per 50 IDs, source/read isolation, timestamp safety, write-budget safety, and deletion pagination.
