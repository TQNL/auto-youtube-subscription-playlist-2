# Strict-ingestion live validation — 2026-08-21 to 2026-08-22

This report begins with the production test of the snapshot archived as
`versions/v5.1-target-pagination-resilience.gs`, then records the V5.2 diagnosis
and quota-limited V5.3 `sheetScript.gs` replay. No channel/source cell in column G or
later was edited, and no existing playlist item was deleted.

## Protected baseline

- Rows tested: 4 (broad mixed-source corpus) and 5 (known Premiere case).
- Historical checkpoint used for both rows: `2026-08-19T10:25:04+00:00`.
- Source-configuration fingerprint before testing:
  `sha256:4072f670ccd0e95f684efbf69cf792780e6348f3cbc11bc1619d07cdd141aff5`.
- Column F contained `1.5` but was deliberately ignored by the strict policy.
- The target UI showed 3,240 existing items before the production replay.

## First production replay

Row 4:

- Acquired 94 unique candidates.
- Kept 41 ordinary uploads.
- Rejected 37 videos under the independent short-duration rule.
- Rejected 11 completed broadcasts, 4 active broadcasts, and 1 upcoming
  broadcast.
- Two inaccessible source upload playlists returned 404 and were isolated as
  non-blocking source warnings.
- The target returned 64 valid pages and then a 404 for the next page token.
  V5.1 retained the partial inventory and checked unresolved candidates through
  exact `playlistId` + `videoId` membership probes.
- Added 41, skipped 0, failed 0.
- Row 4 checkpoint advanced to `2026-08-21T21:41:47+00:00`.

Row 5:

- Acquired one known Premiere, video `CkmIANn_xZY`.
- YouTube returned `liveBroadcastContent: none` with
  `liveStreamingDetails` present and duration `PT1H8M1S`.
- Strict classification rejected it as `COMPLETED_LIVE`; nothing was inserted.
- Row 5 checkpoint advanced to `2026-08-21T21:42:26+00:00`.

## Identical duplicate replay

Both checkpoint cells were reset to the same historical value and production was
run again without changing source configuration.

- Row 4 reproduced the same 94 candidates and 41 admissible uploads.
- The target returned 65 valid pages before the next deep-page 404.
- Added 0 and skipped all 41 because they were already present.
- Row 4 checkpoint advanced to `2026-08-21T21:49:48+00:00`.
- Row 5 again rejected the same completed Premiere and advanced to
  `2026-08-21T21:50:31+00:00`.

The final source-configuration fingerprint exactly matched the protected
baseline. At this stage the local suite passed 25 of 25 regression tests, both
Apps Script files passed syntax parsing, and `git diff --check` passed.

## V5.2 scheduled-run evidence — 2026-08-22

The scheduled V5.2 run began at approximately 00:21 local time. It again proved
the strict classifier itself was working:

- Row 4 rejected 11 completed broadcasts, 4 active broadcasts, and 1 upcoming
  broadcast, kept 41 normal uploads, and skipped all 41 because they were
  already present.
- Two channel-derived uploads playlists returned `playlistNotFound` before
  yielding a first page. V5.2 treated every such read failure as blocking, so
  row 4 unnecessarily retained its historical checkpoint.
- The outer row loop continued. Row 5 acquired `CkmIANn_xZY`, rejected it as
  `COMPLETED_LIVE`, and advanced to `2026-08-21T22:25:54+00:00` even though row 4
  was blocked.

This separated two concerns: no forbidden broadcast reached insertion, but the
source-error policy still harmed checkpoint liveness.

## V5.3 quota-limited replay — 2026-08-22

V5.3 classifies source failures by page boundary. A permanently missing playlist
before the first source page is a warning. Any later-page source failure is
blocking and preserves candidates already read. Target and metadata-filter 404s
remain blocking; they are not covered by the source exception.

Row 4:

- Acquired 94 unique candidates.
- Rejected 37 shorts, 11 completed broadcasts, 4 active broadcasts, and 1
  upcoming broadcast; kept 41 ordinary uploads.
- Logged the two first-page missing uploads playlists as source warnings.
- Read 28 target pages before a quota error. The partial inventory already
  contained all 41 admissible candidates, so it skipped 41 and inserted 0.
- Advanced the checkpoint to `2026-08-21T22:43:52+00:00`.

Row 5 then encountered a metadata quota error. It failed closed and retained the
historical checkpoint; no unverified candidate was inserted.

The protected hashes after the replay were unchanged:

- Full G+ configuration:
  `sha256:4072f670ccd0e95f684efbf69cf792780e6348f3cbc11bc1619d07cdd141aff5`.
- Row 4 sources:
  `sha256:c62dd82232754daa9b93d3da71510f2cd894c3c7687de7e0de1a1697fa9e4877`.
- Row 5 sources:
  `sha256:52c27ee2aa3ced4d154ef50327b290fd6474cc74d0b9113b9afaa3f18a07d2d0`.

After this live run, quota-independent audits hardened Logger isolation,
execution-wide membership-probe limits, blank-checkpoint retry floors, and
malformed insert-response reconciliation. Those changes pass 60 of 60 current
tests plus 14 of 14 legacy regressions, but they have not been replayed live
against row 5 because quota remained exhausted. No deletion was performed during
any validation run, so livestreams inserted by older versions remain in the
target playlist.

## Source-liveness boundary

A first-page `playlistNotFound` response does not prove that the source is empty.
Treating that specific condition as a warning prevents one permanently broken
source from freezing every healthy source in the row, but it may advance past
content that was temporarily inaccessible. Fully lossless behavior needs a
checkpoint per source or a persistent disabled-source state; a single row-wide
timestamp cannot represent both outcomes.

## Conclusion and boundary

The evidence validates future ingestion and retry behavior: detectable upcoming,
active, and completed broadcasts are rejected; first-page permanently missing
sources no longer cancel healthy candidates; later-page source failures remain
blocking; and a partial target read does not create duplicates when existing
membership is already proven. Metadata quota failures remain fail-closed.

V5.3 does not remove livestreams that older versions already inserted.
Historical cleanup remains a separate, explicitly authorized operation.
