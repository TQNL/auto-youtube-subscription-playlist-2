# Version 2: timestamp and error-severity correction

The row-7 source playlist failure was not breaking the outer row loop. The script continued, acquired two healthy candidates, and processed later rows. The actual freeze was this condition: every recorded issue incremented the same `errorCount`, and that counter controlled both the row timestamp and the final execution throw.

Version 2 separates blocking errors from non-blocking warnings.

| Situation | Classification | Row timestamp |
|---|---|---|
| Missing/deleted source playlist (404 or “cannot be found”) | Source warning | Advances |
| Missing channel/username or `ALL` with no subscriptions | Source warning | Advances |
| Cleanup read/delete failure or insufficient cleanup budget | Maintenance warning | Advances |
| Transient source error, such as quota/backend/network failure | Source error | Held for retry |
| Metadata/filter batch failure | Filter error | Held for retry |
| Target-playlist read or insertion failure | Write error | Held for retry |
| Unexpected row exception | Unexpected error | Held for retry |

Warnings are still clearly written to the Debug sheet, but they no longer make the whole execution throw an error. Healthy candidates from the row are still inserted before its timestamp advances.

## Expected row-7 result

The missing playlist will now produce a log resembling:

```text
WARNING [SOURCE]: Cannot read source playlist ... Source skipped; fix or remove its sheet entry.
Acquired 2 unique videos
...
Row completed with non-blocking warnings (...). Timestamp was updated.
```

## Important tradeoff

The spreadsheet has one timestamp for the entire row, not one timestamp per source. Advancing it means a missing source will not accumulate a retry backlog. If you later repair or replace that source and want older videos from its outage window, manually move the row timestamp backward once before running the script. Transient source failures remain blocking specifically to avoid this loss.

## Verification

Eight regression tests pass, including:

- The exact message-only “playlist ... cannot be found” form from Apps Script is recognized without relying on `e.details.code`.
- A missing source does not cancel a healthy insertion and the row timestamp advances.
- A transient 503 source failure still holds the timestamp.
- Cleanup failure becomes a warning and does not freeze ingestion.
- Metadata batching, upcoming-premiere behavior, write-budget safety, and deletion pagination remain unchanged.

JavaScript syntax validation also passes.