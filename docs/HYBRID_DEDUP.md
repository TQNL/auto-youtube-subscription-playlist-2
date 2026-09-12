# V5.7: bounded hybrid destination deduplication

## Decision

Read at most two destination pages (50 entries each), reuse that positive
membership set for this execution, then query exact membership for each unseen
candidate. Stop naturally sooner for small playlists. Reaching the cap does not
prove absence and is not an error. A failed exact check withholds that video and
retains the row checkpoint; healthy candidates can still proceed.

This deliberately uses a small, fixed head scan rather than a persistent cache
of absence or a scan sized to the whole playlist. Playlist order is not assumed
to be newest-first. Old retries, manual reordering, and another writer can place
an existing candidate beyond the scanned region; exact checks still find it.

## Official API research (12 September 2026)

[playlistItems.list](https://developers.google.com/youtube/v3/docs/playlistItems/list)
documents a one-unit quota cost per request, maxResults up to 50, opaque pageToken
pagination, and the optional singular videoId filter with playlistId. Its id
parameter accepts playlist ITEM IDs, not a batch of video IDs. Consequently we
do not send unsupported comma-separated video IDs or rely on insertion errors
as duplicate detection. Small fields projections reduce response payload, not
the method's published quota cost.

## Cost model and boundaries

For a 3,300-item destination, the old inventory needed 66 reads. With no cached
inventory, v5.7 uses at most 2 + U reads, where U is the number of unresolved
candidates actually probed (bounded by the existing shared probe budget).

| Candidates not found in first 100 entries | New reads | Reduction from 66 |
| --- | ---: | ---: |
| 2 | 4 | 94% |
| 5 | 7 | 89% |
| 10 | 12 | 82% |

These are deterministic request-count examples, not measured production savings
or a reduction in total YouTube usage. Large catch-up batches can cost more than
a full scan (75 misses plus two pages costs 77). Small destinations complete in
one or two pages and require no exact checks. Source reads, metadata checks,
insertions, rollbacks, and explicitly requested full audits/cleanup are separate
and unchanged. No claim is made that every workload gets cheaper.

Exact probes retain the execution-wide budget of half the write-operation ceiling
(normally 75), further restricted by remaining rollback-safe insertion capacity.
Unknown candidates are deferred, never treated as absent to save a request.
The two-page cap applies per uncached destination inventory. Positive membership
is reused within a run; there is no persistent stale-absence cache.

## Remaining concurrency limitation

Membership-check then insert is not atomic. Two separate script projects can
still both observe absence and then insert. This pre-existing race requires
coordinating writers to eliminate; the hybrid patch does not claim to solve it.

## Verification

Run node tests/current.test.js, node tests/retry-queue.test.js, and
node tests/hybrid-dedup.test.js. The latter covers a 3,300-item cost fixture, a
deep duplicate, positive-cache reuse, small/empty destinations, failed probes,
probe budget exhaustion, and the quota latch. No live playlist mutation is
required by these tests. Deployment evidence is recorded separately.
