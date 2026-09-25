# v5.9 deployment verification - 2026-09-25

User requested the insertion retry-cap fix, a Git push, and deployment to Mass subscriptions; release named v5.9 at the user's request.

## Fix and tests

- A videoNotFound insertion failure durably moved to WAITING_100H or ABANDONED no longer stops processing healthy later candidates.
- An early stop without another blocking error now explicitly retains the checkpoint.
- Regression tests reproduced the old failure before the fix. All 118 tests across five suites pass after the fix, including fourth-attempt deferral, final abandonment, and ordinary retry checkpoint retention.

## Saved production code

- Final: full pre-edit source matched repository v5.8.
- Mass subscriptions: full pre-edit source matched the immutable repository v5.7 snapshot.
- Both Code.gs files were saved as v5.9, reloaded, selected and copied in full from the editor, and compared with the deployment source.
- Both saved copies are identical to sheetScript.gs after CRLF normalization: 97,135 characters; FNV-1a-64 over JavaScript code units `115343397c9860bd`.
- Companion files, project properties, triggers, spreadsheet configuration, and timestamps were not edited.

## Validation boundary

No production updater was manually run and no playlists were replayed during this deployment. This verifies regression behavior locally and saved production source, not a completed production execution of v5.9. Existing scheduled triggers will execute the saved Head code.
