# Delivery workflow

For user-requested subscription playlist script fixes:

- Run the local regression suite (`node tests/run-playlist-tests.js`).
- Commit the verified changes to Git. Do not push unless requested.
- Discover and update the relevant spreadsheet-bound projects, preserving
  project configuration and unrelated companion files. Verify installed code
  against the baseline before replacement and read saved code back afterwards.
- Record deployment evidence and clearly report copies not updated or blocked.
- Keep useful bounded diagnostic logs at failure boundaries; do not hide errors
  or log secrets. Preserve source, filter, write and maintenance separation.
- Do not rewind production checkpoints or mutate playlists just to test.
- Only reset triggers when requested; preserve their schedules and settings.
  Do not describe fresh trigger statistics as erased execution history.
