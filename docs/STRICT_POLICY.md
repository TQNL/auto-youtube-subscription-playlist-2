# Strict livestream policy

The duration cutoff was an experiment, not a reliable type classifier. A two-hour
upload and a two-hour livestream have the same duration shape. The strict policy
therefore ignores column F when deciding whether a video is a livestream.

The YouTube video resource documents `snippet.liveBroadcastContent` as a current
state (`upcoming`, `live`, or `none`) and `liveStreamingDetails` as present for an
upcoming, active, or completed live broadcast. The public schema has no documented
Premiere boolean. Consequently, no implementation using `videos.list` alone can
guarantee both zero livestreams and preservation of every Premiere.

This fork chooses the testable invariant: no item carrying a documented broadcast
marker may be inserted. Candidate metadata failures are fail-closed and retried.
Historical target entries are audited separately before any repair action.

V5.6 additionally rejects ordinary uploads longer than ten hours. This is a hard
safety limit, not a livestream classifier. Unresolved candidate-specific failures
now use a bounded persistent queue: four failures, a 100-hour wait, then one final
attempt and permanent manual-review storage if it still fails. Infrastructure
failures do not consume that allowance. See [bounded retries](RETRY_QUEUE.md).

Official references:

- https://developers.google.com/youtube/v3/docs/videos
- https://developers.google.com/youtube/v3/docs/videos/list
- https://developers.google.com/youtube/v3/docs/playlistItems/list
- https://developers.google.com/youtube/v3/docs/playlistItems/delete
- https://developers.google.com/youtube/v3/determine_quota_cost

