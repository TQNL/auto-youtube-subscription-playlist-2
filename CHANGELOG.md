# Version history

The active production candidate is always `sheetScript.gs`. Immutable historical
snapshots live in `versions/`, and promoted revisions receive signed-off Git tags.

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

- `v5-strict-ingestion.gs` — planned fail-closed candidate classification and
  non-mutating replay/audit tooling.
- `v6-strict-repair.gs` — planned target-playlist revalidation and repair after
  the v5 dry-run evidence is reviewed.

