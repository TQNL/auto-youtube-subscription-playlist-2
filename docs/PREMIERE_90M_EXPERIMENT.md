# Completed-Premiere heuristic experiment

Branch: `experiment/premiere-under-90m`

This branch deliberately relaxes V5.3's strict completed-broadcast rejection so
the known completed Premiere can enter the isolated test playlist. It does not
claim that YouTube's public API can identify a completed Premiere: no documented
`isPremiere` field exists.

## Admission rule

`classifyVideoStrict()` remains a factual five-state classifier. The separate
`evaluateVideoAdmissionPolicy()` helper applies this decision:

- `NORMAL_UPLOAD`: allow, regardless of duration.
- `UPCOMING` or `ACTIVE`: reject, regardless of duration, and retain the row
  checkpoint so the item can be reconsidered after it completes.
- `UNKNOWN`: withhold and retain the row checkpoint.
- `COMPLETED_LIVE`: require a positive, valid `contentDetails.duration`, valid
  `liveStreamingDetails.actualStartTime`, and valid
  `liveStreamingDetails.actualEndTime`. Define:

  `effectiveDuration = max(playbackDuration, actualEndTime - actualStartTime)`

  Allow the item as `HEURISTIC_PREMIERE_CANDIDATE` only when
  `effectiveDuration <= 5,400 seconds`. The boundary is inclusive and is not
  rounded. Missing, zero, malformed, or contradictory evidence is withheld and
  checkpoint-blocking.

Using the larger duration prevents a long broadcast whose archived playback was
trimmed below 90 minutes from passing the experiment. It adds no YouTube request:
the existing batched `videos.list` response already contains all required fields.

## Consistency boundary

The same evaluator is used during:

1. initial filtering;
2. immediate pre-insert revalidation;
3. post-insert revalidation and rollback;
4. recovery when an insert response lacks a usable playlist-item ID; and
5. the read-only target audit.

`apps-script/Experiment.gs` delegates to the production evaluator and contains an
equivalent standalone fallback. The dry-run and production paths therefore make
the same decision. Source acquisition, target de-duplication, mutation budgeting,
rollback reservation, and error isolation remain inherited from V5.3. This
experiment deliberately strengthens checkpoint behavior for transitional
`UPCOMING` and `ACTIVE` states.

## Unrelated behavior deliberately unchanged

- Column E's independent short-duration filter still runs after admission.
- Column F remains reserved for sheet compatibility and is ignored; 90 minutes
  is hardcoded in the script.
- Normal uploads longer than 90 minutes remain eligible.
- Upcoming and active broadcasts cannot pass based on duration and retain the
  checkpoint for completion retry.
- Metadata continues to be fetched in batches of at most 50 IDs.
- Column G and all source columns to its right are never edited by experiment
  helpers or the production updater.

## Feasibility corpus

The prepared source window is separable by the requested heuristic:

| Video | Observed role | Playback | Actual interval | Decision |
| --- | --- | ---: | ---: | --- |
| `CkmIANn_xZY` | known completed Premiere | 4,081 s | 4,140 s | allow |
| `SE7aCzUaUdY` | completed livestream | 25,303 s | 25,908 s | reject |
| `Knnm5_rG89E` | completed livestream | 32,112 s | 32,552 s | reject |

These observations prove the isolated corpus is passable; they do not turn the
heuristic into a general Premiere classifier.

## Known limitation

A genuine completed livestream whose effective duration is at most 90 minutes
will also be admitted. Titles, descriptions, tags, publish-time coincidence, and
undocumented watch-page fields are not used because they are uploader-controlled
or unsupported. This branch is an experiment, not a replacement for V5.3's
zero-known-broadcast admission invariant.

The sheet has one checkpoint for the entire row, not a durable per-video retry
queue. Consequently, an `UPCOMING` or `ACTIVE` item holds that row checkpoint
until a later run observes a terminal state. This is loss-resistant for
Premiering videos but can enlarge repeated source windows and quota use when a
source schedules far-future or continuously live broadcasts. A production
promotion should replace that coarse retry behavior with bounded persistent
per-video state before using this branch on large mixed-source rows.

Official API references:

- https://developers.google.com/youtube/v3/docs/videos
- https://developers.google.com/youtube/v3/docs/videos/list
- https://support.google.com/youtube/answer/9080341

## Promotion gate

The isolated live validation passed on 2026-08-22 for audited deployed commit
`962b91da048706e7a6407e4df28d9121826a9ddd`. The read-only replay kept only the
known Premiere, production inserted it, and the exact read-only target verifier
confirmed that neither prepared over-limit livestream was present. The full
source-configuration and row-4 source fingerprints were unchanged. See the
[live-validation record](./LIVE_VALIDATION_2026-08-22_PREMIERE_EXPERIMENT.md)
for the complete evidence.

The validation satisfied all of the experiment gates:

1. the read-only replay acquires the known Premiere and at least one over-limit
   completed livestream;
2. the replay plans to insert the Premiere and rejects the livestream;
3. the production run inserts the Premiere but not the livestream;
4. the row checkpoint advances without a blocking error;
5. the full source-configuration fingerprint is unchanged; and
6. the resulting target membership is verified by exact video ID.

Passing this gate validates the prepared experiment corpus; it does not remove
the documented false-positive risk for completed livestreams of 90 minutes or
less. The branch remains unpromoted pending an explicit decision to accept that
tradeoff and the coarse row-checkpoint retry behavior.
