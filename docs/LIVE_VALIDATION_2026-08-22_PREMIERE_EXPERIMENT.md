# Completed-Premiere heuristic live validation — 2026-08-22

This record covers the isolated real-playlist validation of branch
`experiment/premiere-under-90m`. It proves the requested experiment outcome for
the prepared corpus: the known completed Premiere was admitted and inserted,
while both prepared over-limit completed livestreams were rejected. It does not
claim that the YouTube Data API can distinguish every completed Premiere from a
completed livestream.

## Tested artifact and protected baseline

- Audited deployed commit:
  `962b91da048706e7a6407e4df28d9121826a9ddd`.
- Deployed `sheetScript.gs` SHA-256:
  `3765d8c6061f56ac19eade76b3b0d55c4d7d4d9be39be72d54ee2f61dc07bf28`.
- Line-ending-normalized immutable archive
  `versions/v5.4-exp1-premiere-under-90m.gs` SHA-256:
  `e9161e9bd6fad124d66dc1c8c4d651f56cc1b9aca7f6f8fff0fd334bfe790bb3`.
- Row 4 checkpoint before the controlled run:
  `2026-08-19T10:15:32.000Z`.
- Row 5 remained intentionally blank.
- Full protected source-configuration fingerprint before testing:
  `sha256:7ce09f2de24d3eb4378fdac7c614be4412d729fffed894d18d8b4cf218afa7c8`.
- Row-4 source fingerprint before testing:
  `sha256:60cb132b070d1372ecdaf2725e97d44eccc21a5afb1c774175cdc81a0b374824`.

Private target and source playlist IDs are deliberately omitted. The public
video IDs in the prepared test corpus are retained because exact ID membership,
not titles or playlist positions, is the acceptance oracle.

## Read-only dry replay

The row-4 experiment replay acquired four unique candidates and kept only
`CkmIANn_xZY`, the known completed Premiere:

| Video | Observed test role | Replay decision |
| --- | --- | --- |
| `CkmIANn_xZY` | known completed Premiere | admit; planned insertion |
| `Knnm5_rG89E` | completed livestream | reject; effective duration 32,552 s exceeds 5,400 s |
| `SE7aCzUaUdY` | completed livestream | reject; effective duration 25,908 s exceeds 5,400 s |
| `x_FOJJ97suA` | unrelated short | reject by the unchanged column-E shorts filter |

The structured replay result also reported:

- acquired 4 and kept 1;
- withheld 0;
- complete target read;
- 0 warnings and 0 blocking errors;
- checkpoint eligible to advance; and
- one planned insertion: `CkmIANn_xZY`.

No sheet timestamp, source cell, or playlist item was mutated by this replay.

## Controlled production update

After the read-only plan matched the expected oracle, the production
`updatePlaylists` path was run once against the isolated row. Its row summary
reported:

- acquired 4 candidates;
- inserted 1;
- skipped 0;
- failed 0; and
- completed normally.

The inserted item was `CkmIANn_xZY`. The two over-limit completed livestreams
were not inserted. Row 4's checkpoint advanced to
`2026-08-22T11:28:26+00:00`; row 5 remained blank.

## Post-run integrity and exact target proof

The post-run source snapshot matched the protected baseline exactly:

- Full source-configuration fingerprint:
  `sha256:7ce09f2de24d3eb4378fdac7c614be4412d729fffed894d18d8b4cf218afa7c8`.
- Row-4 source fingerprint:
  `sha256:60cb132b070d1372ecdaf2725e97d44eccc21a5afb1c774175cdc81a0b374824`.

The independent exact target verifier then performed a complete, read-only
target scan. It reported three unique target videos and proved exact membership:

- `CkmIANn_xZY`: present;
- `Knnm5_rG89E`: absent; and
- `SE7aCzUaUdY`: absent.

Other target entries were outside the experiment oracle and are deliberately
not enumerated here. The verifier did not modify them.

The verifier reported 0 warnings, 0 errors, and `mutationPerformed: false`.

## Conclusion and boundary

All six isolated promotion gates in
[`PREMIERE_90M_EXPERIMENT.md`](./PREMIERE_90M_EXPERIMENT.md) passed for the
audited deployed commit. The live run also preserved the unrelated short filter,
advanced the production checkpoint only after successful processing, and left
the protected source configuration unchanged.

This validates the experiment goal, not a general Premiere classifier. A genuine
completed livestream with valid evidence and an effective duration of at most
90 minutes remains an accepted false positive by design. The branch therefore
remains an unpromoted experiment unless that product tradeoff and the documented
checkpoint-retry cost are separately accepted for broader use.
