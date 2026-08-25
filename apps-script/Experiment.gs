// Read-only helpers for strict broadcast-policy verification.
//
// These functions intentionally do not call processPlaylistRow(), applyFilters(),
// addVideosToPlaylist(), deletePlaylistItems(), or any Range setter. They read the
// configured row timestamp and source cells, query YouTube, and report what the
// strict admission policy would do without mutating the sheet or a playlist.

var EXPERIMENT_FIRST_DATA_ROW_ = 4;
var EXPERIMENT_FIRST_SOURCE_COLUMN_ = 7; // G (one-based)
var EXPERIMENT_TIMESTAMP_COLUMN_ = 2;    // B (one-based)
var EXPERIMENT_SHORTS_COLUMN_ = 5;       // E (one-based)
var EXPERIMENT_VISIBLE_COLUMN_COUNT_ = 6; // A:F

/**
 * Return a SHA-256 fingerprint of G:lastColumn for rows 4:lastRow.
 *
 * The unhashed source values and formulas never leave this function. Bounds are
 * included in the digest so adding/removing a source row or column is detectable.
 */
function sourceConfigurationFingerprint(optionalSheet) {
  var sheet = experimentConfigurationSheet_(optionalSheet);
  var lastRow = sheet.getLastRow();
  var numRows = Math.max(0, lastRow - EXPERIMENT_FIRST_DATA_ROW_ + 1);
  var payload = experimentSourcePayload_(sheet, EXPERIMENT_FIRST_DATA_ROW_, numRows);
  return experimentSha256_(JSON.stringify(payload));
}

/**
 * Fail if any source cell in G:lastColumn, rows 4:lastRow, has changed.
 */
function assertSourceConfigurationUnchanged(expectedHash, optionalSheet) {
  var expected = String(expectedHash || "").trim();
  if (!/^sha256:[0-9a-f]{64}$/.test(expected)) {
    throw new Error("A valid sha256 source-configuration fingerprint is required.");
  }

  var actual = sourceConfigurationFingerprint(optionalSheet);
  if (actual !== expected) {
    throw new Error(
      "Source configuration changed during the experiment. Expected " +
      expected + " but found " + actual + "."
    );
  }
  return true;
}

/**
 * Log and return the experiment rows without exposing G+ source values.
 *
 * The only cell values returned are A:F for rows 4 and 5. Each row receives a
 * hash of its G:lastColumn source slice, and the full source matrix receives a
 * separate hash. Channel IDs and source-playlist IDs are never logged here.
 */
function snapshotExperimentRows(optionalSheet) {
  var sheet = experimentConfigurationSheet_(optionalSheet);
  var rowNumbers = [4, 5];
  var visible = sheet
    .getRange(rowNumbers[0], 1, rowNumbers.length, EXPERIMENT_VISIBLE_COLUMN_COUNT_)
    .getDisplayValues();

  var rows = rowNumbers.map(function(rowNumber, index) {
    return {
      rowNumber: rowNumber,
      columns: {
        A: visible[index][0],
        B: visible[index][1],
        C: visible[index][2],
        D: visible[index][3],
        E: visible[index][4],
        F: visible[index][5]
      },
      sourceHash: experimentSourceRowFingerprint_(sheet, rowNumber)
    };
  });

  var snapshot = {
    sourceConfigurationHash: sourceConfigurationFingerprint(sheet),
    rows: rows
  };
  Logger.log("EXPERIMENT_ROWS_SNAPSHOT " + JSON.stringify(snapshot));
  return snapshot;
}

function replayRow4StrictDryRun() {
  return replayStrictDryRun(4);
}

function replayRow5StrictDryRun() {
  return replayStrictDryRun(5);
}

function diagnoseRow4TargetAccessReadOnly() {
  return diagnoseTargetAccessReadOnly(4);
}

/**
 * Verify the isolated row-4 target against the three public experiment videos.
 *
 * The target and source IDs remain local. Only the already-public corpus video
 * IDs, exact membership booleans, aggregate target size, and an opaque source
 * fingerprint are returned or logged. The existing complete pagination reader
 * is used, and no sheet or playlist mutation method is called.
 */
function verifyRow4PremiereExperimentTargetReadOnly(optionalSheet) {
  var sheet = experimentConfigurationSheet_(optionalSheet);
  var expectedSourceHash = sourceConfigurationFingerprint(sheet);
  var corpusVideoIds = ["CkmIANn_xZY", "SE7aCzUaUdY", "Knnm5_rG89E"];

  try {
    var targetPlaylistId = experimentNormalize_(
      sheet.getRange(EXPERIMENT_FIRST_DATA_ROW_, 1).getDisplayValue()
    );
    var state = experimentState_();
    var targetRead;
    if (!targetPlaylistId) {
      experimentIssue_(state, "error", "target", "target_playlist_missing");
      targetRead = {ok: false, videoSet: Object.create(null)};
    } else {
      targetRead = experimentReadTargetVideoSet_(targetPlaylistId, state);
    }

    var membershipByVideoId = Object.create(null);
    corpusVideoIds.forEach(function(videoId) {
      membershipByVideoId[videoId] = targetRead.ok
        ? Object.prototype.hasOwnProperty.call(targetRead.videoSet, videoId)
        : null;
    });

    assertSourceConfigurationUnchanged(expectedSourceHash, sheet);
    var report = {
      schemaVersion: 1,
      readOnly: true,
      rowNumber: EXPERIMENT_FIRST_DATA_ROW_,
      sourceConfigurationHash: expectedSourceHash,
      targetReadComplete: targetRead.ok,
      targetUniqueVideoCount: targetRead.ok ? Object.keys(targetRead.videoSet).length : null,
      membershipByVideoId: membershipByVideoId,
      blockingErrorCount: state.blockingErrorCount,
      warningCount: state.warningCount,
      issues: state.issues.map(experimentCompactIssue_),
      mutationPerformed: false
    };
    Logger.log("PREMIERE_EXPERIMENT_TARGET_VERIFICATION " + JSON.stringify(report));
    return report;
  } finally {
    assertSourceConfigurationUnchanged(expectedSourceHash, sheet);
  }
}

/**
 * Identify which YouTube identity the current Apps Script authorization uses.
 *
 * This is deliberately read-only and never logs a channel ID, playlist ID, or
 * source value. Channel titles are retained because they are
 * the user-visible identity needed to diagnose Brand Account/default-channel
 * mismatches.
 */
function diagnoseTargetAccessReadOnly(rowNumber, optionalSheet) {
  rowNumber = Number(rowNumber);
  if (!isFinite(rowNumber) || Math.floor(rowNumber) !== rowNumber ||
      rowNumber < EXPERIMENT_FIRST_DATA_ROW_) {
    throw new Error("Diagnostic row must be an integer at row 4 or later.");
  }

  var sheet = experimentConfigurationSheet_(optionalSheet);
  var expectedSourceHash = sourceConfigurationFingerprint(sheet);

  try {
    var rawTarget = String(sheet.getRange(rowNumber, 1).getDisplayValue() || "");
    var targetPlaylistId = rawTarget.trim();
    if (!targetPlaylistId) throw new Error("Row " + rowNumber + " has no target playlist ID.");

    var authorization = ScriptApp.getAuthorizationInfo(ScriptApp.AuthMode.FULL);
    var channelsResponse = YouTube.Channels.list("id,snippet", {
      mine: true,
      maxResults: 50,
      fields: "items(id,snippet(title))"
    });
    var authenticatedChannels = (channelsResponse && channelsResponse.items || []).map(function(item) {
      return {
        idHash: experimentSha256_("oauth-channel-v1\n" + String(item.id || "")),
        title: item.snippet && item.snippet.title ? item.snippet.title : ""
      };
    });

    var exactLookup = experimentReadOnlyApiProbe_(function() {
      var response = YouTube.Playlists.list("id", {
        id: targetPlaylistId,
        maxResults: 1,
        fields: "items(id)"
      });
      return {itemCount: response && response.items ? response.items.length : 0};
    });

    var targetPresentInMine = false;
    var ownedPlaylistCount = 0;
    var mineLookup = experimentReadOnlyApiProbe_(function() {
      var nextPageToken = null;
      var seenPageTokens = Object.create(null);
      do {
        var options = {
          mine: true,
          maxResults: 50,
          fields: "nextPageToken,items(id)"
        };
        if (nextPageToken) options.pageToken = nextPageToken;
        var page = YouTube.Playlists.list("id", options);
        if (!page || !Array.isArray(page.items)) throw new Error("Owned-playlist lookup returned an invalid items array");
        var items = page.items;
        ownedPlaylistCount += items.length;
        if (items.some(function(item) { return item.id === targetPlaylistId; })) {
          targetPresentInMine = true;
        }
        var returnedToken = page.nextPageToken || null;
        if (returnedToken && seenPageTokens[returnedToken]) throw new Error("Owned-playlist lookup returned a repeated page token");
        if (returnedToken) seenPageTokens[returnedToken] = true;
        nextPageToken = returnedToken;
      } while (nextPageToken !== null && !targetPresentInMine);
      return {
        inspectedPlaylistCount: ownedPlaylistCount,
        targetPresent: targetPresentInMine
      };
    });

    var itemLookup = experimentReadOnlyApiProbe_(function() {
      var response = YouTube.PlaylistItems.list("id", {
        playlistId: targetPlaylistId,
        maxResults: 1,
        fields: "items(id)"
      });
      return {itemCount: response && response.items ? response.items.length : 0};
    });

    var explicitEmptyTokenLookup = experimentReadOnlyApiProbe_(function() {
      var response = YouTube.PlaylistItems.list("id", {
        playlistId: targetPlaylistId,
        maxResults: 1,
        pageToken: "",
        fields: "items(id)"
      });
      return {itemCount: response && response.items ? response.items.length : 0};
    });

    var fullPagination = experimentReadOnlyTargetPaginationProbe_(targetPlaylistId);

    assertSourceConfigurationUnchanged(expectedSourceHash, sheet);
    var report = {
      schemaVersion: 1,
      readOnly: true,
      rowNumber: rowNumber,
      sourceConfigurationHash: expectedSourceHash,
      targetPlaylistHash: experimentSha256_("target-playlist-v1\n" + targetPlaylistId),
      rawTargetLength: rawTarget.length,
      trimmedTargetLength: targetPlaylistId.length,
      hadOuterWhitespace: rawTarget !== targetPlaylistId,
      authorizationStatus: String(authorization.getAuthorizationStatus()),
      authorizedScopes: authorization.getAuthorizedScopes().slice().sort(),
      authenticatedChannels: authenticatedChannels,
      exactTargetLookup: exactLookup,
      targetInAuthenticatedUsersPlaylists: mineLookup,
      targetItemsLookup: itemLookup,
      targetItemsWithExplicitEmptyPageToken: explicitEmptyTokenLookup,
      fullTargetPagination: fullPagination,
      mutationPerformed: false
    };
    Logger.log("TARGET_ACCESS_DIAGNOSTIC " + JSON.stringify(report));
    return report;
  } finally {
    assertSourceConfigurationUnchanged(expectedSourceHash, sheet);
  }
}

function experimentReadOnlyTargetPaginationProbe_(targetPlaylistId) {
  var nextPageToken = null;
  var seenPageTokens = Object.create(null);
  var pagesCompleted = 0;
  var itemCount = 0;

  do {
    var params = {
      playlistId: targetPlaylistId,
      maxResults: 50,
      fields: "nextPageToken,items(id)"
    };
    if (nextPageToken) params.pageToken = nextPageToken;

    try {
      var page = YouTube.PlaylistItems.list("id", params);
      if (!page || !Array.isArray(page.items)) {
        return {
          ok: false,
          reason: "invalid_response",
          pageNumberAttempted: pagesCompleted + 1,
          pagesCompleted: pagesCompleted,
          itemCount: itemCount
        };
      }
      pagesCompleted += 1;
      itemCount += page.items.length;
      var returnedToken = page.nextPageToken || null;
      if (returnedToken && seenPageTokens[returnedToken]) {
        return {
          ok: false,
          reason: "repeated_page_token",
          pageNumberAttempted: pagesCompleted + 1,
          pagesCompleted: pagesCompleted,
          itemCount: itemCount
        };
      }
      if (returnedToken) seenPageTokens[returnedToken] = true;
      nextPageToken = returnedToken;
    } catch (error) {
      return {
        ok: false,
        reason: "api_error",
        pageNumberAttempted: pagesCompleted + 1,
        pagesCompleted: pagesCompleted,
        itemCount: itemCount,
        apiCode: experimentApiErrorCode_(error),
        apiReason: experimentApiErrorReason_(error)
      };
    }
  } while (nextPageToken !== null);

  return {
    ok: true,
    pagesCompleted: pagesCompleted,
    itemCount: itemCount
  };
}

function experimentReadOnlyApiProbe_(callback) {
  try {
    var value = callback() || {};
    value.ok = true;
    return value;
  } catch (error) {
    return {
      ok: false,
      apiCode: experimentApiErrorCode_(error),
      apiReason: experimentApiErrorReason_(error)
    };
  }
}

/**
 * Read-only replay of one configured playlist row under the strict policy.
 *
 * Every known broadcast state is rejected without blocking the row checkpoint.
 * Missing or unknown metadata remains retry-blocking and fail-closed. Column F
 * is intentionally ignored because duration is not part of strict admission.
 */
function replayStrictDryRun(rowNumber, optionalSheet) {
  rowNumber = Number(rowNumber);
  if (!isFinite(rowNumber) || Math.floor(rowNumber) !== rowNumber ||
      rowNumber < EXPERIMENT_FIRST_DATA_ROW_) {
    throw new Error("Replay row must be an integer at or below the table header (row 4 or later).");
  }

  var sheet = experimentConfigurationSheet_(optionalSheet);
  var expectedSourceHash = sourceConfigurationFingerprint(sheet);

  try {
    var width = Math.max(EXPERIMENT_VISIBLE_COLUMN_COUNT_, sheet.getLastColumn());
    var rowValues = sheet.getRange(rowNumber, 1, 1, width).getValues()[0];
    var timestamp = experimentTimestampIso_(rowValues[EXPERIMENT_TIMESTAMP_COLUMN_ - 1], rowNumber);
    var targetPlaylistId = experimentNormalize_(rowValues[0]);
    var filterShorts = experimentNormalize_(
      rowValues[EXPERIMENT_SHORTS_COLUMN_ - 1]
    ).toLowerCase() === "no";
    var sources = experimentSourcesFromRow_(rowValues);
    var state = experimentState_();

    var candidateIds = experimentAcquireCandidates_(sources, timestamp, state);
    candidateIds = experimentDedupe_(candidateIds);
    var classification = experimentClassifyStrict_(candidateIds, filterShorts, state);
    var targetRead = targetPlaylistId
      ? experimentReadTargetVideoSet_(targetPlaylistId, state)
      : {ok: false, videoSet: {}};

    if (!targetPlaylistId) {
      experimentIssue_(state, "error", "target", "target_playlist_missing");
    }

    var alreadyPresent = [];
    var wouldInsert = null;
    if (targetRead.ok) {
      wouldInsert = [];
      classification.kept.forEach(function(videoId) {
        if (targetRead.videoSet[videoId]) alreadyPresent.push(videoId);
        else wouldInsert.push(videoId);
      });
    }

    // Verify the invariant before emitting evidence. The finally block repeats
    // the check so unexpected failures cannot bypass it.
    assertSourceConfigurationUnchanged(expectedSourceHash, sheet);

    var result = {
      schemaVersion: 2,
      policy: "strict-documented-broadcast-markers-v1",
      dryRun: true,
      rowNumber: rowNumber,
      timestampReadFromColumnB: timestamp,
      sourceConfigurationHash: expectedSourceHash,
      rowSourceHash: experimentSourceRowFingerprint_(sheet, rowNumber),
      sourceCount: sources.length,
      sourceHashes: sources.map(function(source) { return source.hash; }),
      filterShorts: filterShorts,
      columnFIgnoredByStrictPolicy: true,
      // Retained as a compatibility field for older report consumers. Strict
      // admission has no duration exception.
      completedBroadcastMaxSeconds: null,
      acquiredCandidateIds: candidateIds,
      keptCandidateIds: classification.kept,
      admittedHeuristicCandidates: classification.admittedHeuristicCandidates,
      rejectedCandidates: classification.rejected,
      withheldCandidates: classification.withheld,
      alreadyPresentIds: targetRead.ok ? alreadyPresent : null,
      wouldInsertIds: wouldInsert,
      targetReadComplete: targetRead.ok,
      blockingErrorCount: state.blockingErrorCount,
      warningCount: state.warningCount,
      checkpointWouldAdvance: state.blockingErrorCount === 0,
      issues: state.issues
    };

    // Apps Script truncates an individual Logger line at roughly 8 KiB. Large
    // subscription rows can contain hundreds of source hashes, so emit the
    // decision evidence first in a compact line that remains independently
    // readable even when the full forensic payload below is truncated.
    var summary = experimentReplaySummary_(result);
    Logger.log("PREMIERE_EXPERIMENT_REPLAY_SUMMARY " + JSON.stringify(summary));

    // The structured line contains video IDs for comparison, but no channel IDs
    // or source-playlist IDs. Raw sources remain local variables only.
    Logger.log("PREMIERE_EXPERIMENT_REPLAY_RESULT " + JSON.stringify(result));
    return result;
  } finally {
    assertSourceConfigurationUnchanged(expectedSourceHash, sheet);
  }
}

function experimentReplaySummary_(result) {
  var rejectionCounts = Object.create(null);
  (result.rejectedCandidates || []).forEach(function(candidate) {
    var key = candidate.classification || candidate.reason || "UNKNOWN";
    rejectionCounts[key] = (rejectionCounts[key] || 0) + 1;
  });

  var withheldCounts = Object.create(null);
  (result.withheldCandidates || []).forEach(function(candidate) {
    var key = candidate.reason || "UNKNOWN";
    withheldCounts[key] = (withheldCounts[key] || 0) + 1;
  });

  return {
    schemaVersion: result.schemaVersion,
    policy: result.policy,
    dryRun: result.dryRun,
    rowNumber: result.rowNumber,
    timestampReadFromColumnB: result.timestampReadFromColumnB,
    sourceConfigurationHash: result.sourceConfigurationHash,
    rowSourceHash: result.rowSourceHash,
    sourceCount: result.sourceCount,
    filterShorts: result.filterShorts,
    columnFIgnoredByStrictPolicy: result.columnFIgnoredByStrictPolicy,
    completedBroadcastMaxSeconds: result.completedBroadcastMaxSeconds,
    acquiredCandidateCount: (result.acquiredCandidateIds || []).length,
    keptCandidateCount: (result.keptCandidateIds || []).length,
    rejectedCandidateCount: (result.rejectedCandidates || []).length,
    withheldCandidateCount: (result.withheldCandidates || []).length,
    admittedHeuristicCandidateCount: (result.admittedHeuristicCandidates || []).length,
    rejectionCounts: rejectionCounts,
    withheldCounts: withheldCounts,
    rejectedCandidateSamples: (result.rejectedCandidates || []).slice(0, 25),
    issueCount: (result.issues || []).length,
    issueSamples: (result.issues || []).slice(0, 10).map(experimentCompactIssue_),
    targetReadComplete: result.targetReadComplete,
    blockingErrorCount: result.blockingErrorCount,
    warningCount: result.warningCount,
    checkpointWouldAdvance: result.checkpointWouldAdvance
  };
}

function experimentCompactIssue_(issue) {
  return {
    severity: issue.severity,
    stage: issue.stage,
    reason: issue.reason,
    sourceColumn: issue.sourceColumn,
    videoId: issue.videoId,
    apiCode: issue.apiCode,
    apiReason: issue.apiReason
  };
}

function experimentConfigurationSheet_(optionalSheet) {
  if (optionalSheet && typeof optionalSheet.getRange === "function") {
    return optionalSheet;
  }

  var spreadsheet = null;
  var sheetId = PropertiesService.getScriptProperties().getProperty("sheetID");
  if (sheetId) spreadsheet = SpreadsheetApp.openById(sheetId);
  if (!spreadsheet) spreadsheet = SpreadsheetApp.getActiveSpreadsheet();
  if (!spreadsheet) {
    throw new Error(
      "Cannot locate the configuration spreadsheet. Open the bound sheet once " +
      "or set the existing sheetID script property."
    );
  }

  var sheet = spreadsheet.getSheets()[0];
  if (!sheet || experimentNormalize_(sheet.getRange("A3").getValue()) !== "Playlist ID") {
    throw new Error("The first worksheet is not the playlist configuration sheet (A3 must be 'Playlist ID').");
  }
  return sheet;
}

function experimentSourcePayload_(sheet, startRow, numRows) {
  var lastColumn = sheet.getLastColumn();
  var numColumns = Math.max(0, lastColumn - EXPERIMENT_FIRST_SOURCE_COLUMN_ + 1);
  var payload = {
    startRow: startRow,
    startColumn: EXPERIMENT_FIRST_SOURCE_COLUMN_,
    numRows: numRows,
    numColumns: numColumns,
    displayValues: [],
    formulas: []
  };

  if (numRows === 0 || numColumns === 0) return payload;
  var range = sheet.getRange(startRow, EXPERIMENT_FIRST_SOURCE_COLUMN_, numRows, numColumns);
  payload.displayValues = range.getDisplayValues();
  payload.formulas = typeof range.getFormulas === "function" ? range.getFormulas() : [];
  return payload;
}

function experimentSourceRowFingerprint_(sheet, rowNumber) {
  return experimentSha256_(JSON.stringify(experimentSourcePayload_(sheet, rowNumber, 1)));
}

function experimentSha256_(text) {
  var bytes = Utilities.computeDigest(
    Utilities.DigestAlgorithm.SHA_256,
    String(text),
    Utilities.Charset.UTF_8
  );
  var hex = bytes.map(function(value) {
    var unsigned = value < 0 ? value + 256 : value;
    return (unsigned < 16 ? "0" : "") + unsigned.toString(16);
  }).join("");
  return "sha256:" + hex;
}

function experimentTimestampIso_(value, rowNumber) {
  if (value === null || value === undefined || String(value).trim() === "") {
    throw new Error("Row " + rowNumber + " has no timestamp in column B; dry-run refuses to invent one.");
  }
  var date = value instanceof Date ? value : new Date(value);
  if (isNaN(date.getTime())) {
    throw new Error("Row " + rowNumber + " has an invalid timestamp in column B.");
  }
  return date.toISOString();
}

function experimentSourcesFromRow_(rowValues) {
  var sources = [];
  for (var index = EXPERIMENT_FIRST_SOURCE_COLUMN_ - 1; index < rowValues.length; index++) {
    var value = experimentNormalize_(rowValues[index]);
    if (!value) continue;
    sources.push({
      value: value,
      column: index + 1,
      hash: experimentSha256_("source-cell-v1\n" + (index + 1) + "\n" + value)
    });
  }
  return sources;
}

function experimentAcquireCandidates_(sources, timestamp, state) {
  var candidateIds = [];
  var checkpointMillis = new Date(timestamp).getTime();

  sources.forEach(function(source) {
    if (source.value === "ALL") {
      var subscriptionIds = experimentReadSubscriptionIds_(source, state);
      subscriptionIds.forEach(function(channelId) {
        Array.prototype.push.apply(
          candidateIds,
          experimentReadChannelVideos_(channelId, checkpointMillis, source, state)
        );
      });
      return;
    }

    if (source.value.substring(0, 2) === "PL" && source.value.length > 10) {
      Array.prototype.push.apply(
        candidateIds,
        experimentReadSourcePlaylistVideos_(source.value, checkpointMillis, source, state)
      );
      return;
    }

    var channelId = source.value;
    if (!(source.value.substring(0, 2) === "UC" && source.value.length > 10)) {
      channelId = experimentResolveUsername_(source, state);
    }
    if (!channelId) return;

    Array.prototype.push.apply(
      candidateIds,
      experimentReadChannelVideos_(channelId, checkpointMillis, source, state)
    );
  });

  return candidateIds;
}

function experimentReadSubscriptionIds_(source, state) {
  var channelIds = [];
  var nextPageToken = null;
  var seenPageTokens = Object.create(null);
  var readCompleted = false;
  try {
    do {
      var options = {
        mine: true,
        maxResults: 50,
        order: "alphabetical",
        fields: "nextPageToken,items(snippet(resourceId(channelId)))"
      };
      if (nextPageToken) options.pageToken = nextPageToken;
      var response = YouTube.Subscriptions.list("snippet", options);
      if (!response || !Array.isArray(response.items)) {
        experimentIssue_(state, "error", "source", "subscriptions_response_invalid", source);
        return channelIds;
      }
      response.items.forEach(function(item) {
        var channelId = item && item.snippet && item.snippet.resourceId &&
          item.snippet.resourceId.channelId;
        if (!channelId) {
          experimentIssue_(state, "error", "source", "subscription_item_metadata_invalid", source);
          return;
        }
        channelIds.push(channelId);
      });
      var returnedToken = response.nextPageToken || null;
      if (returnedToken && seenPageTokens[returnedToken]) {
        experimentIssue_(state, "error", "source", "subscriptions_page_token_repeated", source);
        return channelIds;
      }
      if (returnedToken) seenPageTokens[returnedToken] = true;
      nextPageToken = returnedToken;
    } while (nextPageToken);
    readCompleted = true;
  } catch (error) {
    // ALL is not a configured channel/playlist that can be safely treated as
    // permanently absent. Any subscription-list failure leaves the ALL source
    // incomplete, even when the API happens to report a 404-like reason.
    experimentIssue_(state, "error", "source", "subscriptions_read_failed", source, error);
  }
  if (readCompleted && channelIds.length === 0) {
    experimentIssue_(state, "warning", "source", "subscriptions_empty", source);
  }
  return channelIds;
}

function experimentResolveUsername_(source, state) {
  try {
    var response = YouTube.Channels.list("id", {
      forUsername: source.value,
      maxResults: 1,
      fields: "items(id)"
    });
    if (!response || !Array.isArray(response.items)) {
      experimentIssue_(state, "error", "source", "username_response_invalid", source);
      return null;
    }
    if (response.items.length !== 1 || !response.items[0].id) {
      experimentIssue_(state, "warning", "source", "username_not_uniquely_resolved", source);
      return null;
    }
    return response.items[0].id;
  } catch (error) {
    experimentApiIssue_(state, "source", "username_resolution_failed", source, error);
    return null;
  }
}

function experimentReadChannelVideos_(channelId, checkpointMillis, source, state) {
  var videoIds = [];
  var uploadsPlaylistId = null;
  try {
    var channelResponse = YouTube.Channels.list("contentDetails", {
      id: channelId,
      maxResults: 1,
      fields: "items(contentDetails(relatedPlaylists(uploads)))"
    });
    if (!channelResponse || !Array.isArray(channelResponse.items)) {
      experimentIssue_(state, "error", "source", "channel_response_invalid", source);
      return videoIds;
    }
    if (channelResponse.items.length === 0) {
      experimentIssue_(state, "warning", "source", "channel_not_found", source);
      return videoIds;
    }
    uploadsPlaylistId = channelResponse.items[0].contentDetails &&
      channelResponse.items[0].contentDetails.relatedPlaylists &&
      channelResponse.items[0].contentDetails.relatedPlaylists.uploads;
    if (!uploadsPlaylistId) {
      experimentIssue_(state, "error", "source", "uploads_playlist_missing", source);
      return videoIds;
    }
  } catch (error) {
    experimentApiIssue_(state, "source", "channel_read_failed", source, error);
    return videoIds;
  }

  var nextPageToken = null;
  var seenPageTokens = Object.create(null);
  var pagesRead = 0;
  do {
    try {
      var options = {
        playlistId: uploadsPlaylistId,
        maxResults: 50,
        fields: "nextPageToken,items(contentDetails(videoId,videoPublishedAt))"
      };
      if (nextPageToken) options.pageToken = nextPageToken;
      var response = YouTube.PlaylistItems.list("contentDetails", options);
      if (!response || !Array.isArray(response.items)) {
        experimentIssue_(state, "error", "source", "uploads_response_invalid", source);
        return videoIds.reverse();
      }
      pagesRead += 1;

      var pageHasCandidate = false;
      var pageHasUnknown = false;
      response.items.forEach(function(item) {
        var details = item && item.contentDetails;
        var publishedMillis = details && new Date(details.videoPublishedAt).getTime();
        if (!details || !details.videoId || isNaN(publishedMillis)) {
          pageHasUnknown = true;
          experimentIssue_(state, "error", "source", "uploads_item_metadata_invalid", source);
          return;
        }
        if (publishedMillis >= checkpointMillis) {
          pageHasCandidate = true;
          videoIds.push(details.videoId);
        }
      });

      // Uploads playlists are newest-first. Continue if the page had unknown
      // entries; otherwise a wholly old page proves all later pages are older.
      if (response.items.length > 0 && !pageHasCandidate && !pageHasUnknown) break;
      var returnedToken = response.nextPageToken || null;
      if (returnedToken && seenPageTokens[returnedToken]) {
        experimentIssue_(state, "error", "source", "uploads_page_token_repeated", source);
        return videoIds.reverse();
      }
      if (returnedToken) seenPageTokens[returnedToken] = true;
      nextPageToken = returnedToken;
    } catch (error) {
      experimentSourcePageApiIssue_(
        state,
        "uploads_playlist_read_failed",
        source,
        error,
        pagesRead
      );
      return videoIds.reverse();
    }
  } while (nextPageToken);

  return videoIds.reverse();
}

function experimentReadSourcePlaylistVideos_(playlistId, checkpointMillis, source, state) {
  var videoIds = [];
  var nextPageToken = null;
  var seenPageTokens = Object.create(null);
  var pagesRead = 0;
  do {
    try {
      var options = {
        playlistId: playlistId,
        maxResults: 50,
        fields: "nextPageToken,items(snippet(publishedAt,resourceId(videoId)))"
      };
      if (nextPageToken) options.pageToken = nextPageToken;
      var response = YouTube.PlaylistItems.list("snippet", options);
      if (!response || !Array.isArray(response.items)) {
        experimentIssue_(state, "error", "source", "source_playlist_response_invalid", source);
        return videoIds;
      }
      pagesRead += 1;
      response.items.forEach(function(item) {
        var snippet = item && item.snippet;
        var videoId = snippet && snippet.resourceId && snippet.resourceId.videoId;
        var publishedMillis = snippet && new Date(snippet.publishedAt).getTime();
        if (!videoId || isNaN(publishedMillis)) {
          experimentIssue_(state, "error", "source", "source_playlist_item_metadata_invalid", source);
          return;
        }
        if (publishedMillis >= checkpointMillis) videoIds.push(videoId);
      });
      var returnedToken = response.nextPageToken || null;
      if (returnedToken && seenPageTokens[returnedToken]) {
        experimentIssue_(state, "error", "source", "source_playlist_page_token_repeated", source);
        return videoIds;
      }
      if (returnedToken) seenPageTokens[returnedToken] = true;
      nextPageToken = returnedToken;
    } catch (error) {
      experimentSourcePageApiIssue_(
        state,
        "source_playlist_read_failed",
        source,
        error,
        pagesRead
      );
      return videoIds;
    }
  } while (nextPageToken);
  return videoIds;
}

function experimentClassifyStrict_(videoIds, filterShorts, state) {
  // admittedHeuristicCandidates is retained as an always-empty compatibility
  // field for consumers of the former Premiere experiment report schema.
  var result = {kept: [], rejected: [], withheld: [], admittedHeuristicCandidates: []};

  for (var start = 0; start < videoIds.length; start += 50) {
    var batch = videoIds.slice(start, start + 50);
    var response;
    try {
      response = YouTube.Videos.list("snippet,contentDetails,liveStreamingDetails", {
        id: batch.join(","),
        fields: "items(id,snippet(liveBroadcastContent),contentDetails(duration),liveStreamingDetails)"
      });
    } catch (error) {
      experimentApiIssue_(state, "filter", "video_metadata_batch_failed", null, error);
      batch.forEach(function(videoId) {
        result.withheld.push({videoId: videoId, reason: "metadata_batch_failed"});
      });
      continue;
    }

    if (!response || !Array.isArray(response.items)) {
      experimentIssue_(state, "error", "filter", "video_metadata_response_invalid");
      batch.forEach(function(videoId) {
        result.withheld.push({videoId: videoId, reason: "metadata_response_invalid"});
      });
      continue;
    }

    var byId = Object.create(null);
    response.items.forEach(function(item) {
      if (item && item.id) byId[item.id] = item;
    });

    batch.forEach(function(videoId) {
      var item = byId[videoId];
      if (!item) {
        experimentIssue_(state, "error", "filter", "video_metadata_missing", null, null, videoId);
        result.withheld.push({videoId: videoId, reason: "metadata_missing"});
        return;
      }

      var liveState = item.snippet && item.snippet.liveBroadcastContent;
      var hasLiveStreamingDetails = item.liveStreamingDetails !== undefined &&
        item.liveStreamingDetails !== null;
      var admission = experimentAdmissionDecision_(item);

      if (admission.blocking) {
        experimentIssue_(state, "error", "filter", admission.reason, null, null, videoId);
        result.withheld.push({
          videoId: videoId,
          reason: admission.reason,
          classification: admission.classification
        });
        return;
      }

      if (!admission.allowed) {
        result.rejected.push({
          videoId: videoId,
          reason: admission.reason,
          classification: admission.classification,
          liveBroadcastContent: liveState || null,
          hasLiveStreamingDetails: hasLiveStreamingDetails,
          effectiveDurationSeconds: admission.effectiveDurationSeconds === undefined
            ? null : admission.effectiveDurationSeconds
        });
        return;
      }

      var duration = item.contentDetails && item.contentDetails.duration;
      if (filterShorts && !duration) {
        experimentIssue_(state, "error", "filter", "duration_metadata_missing", null, null, videoId);
        result.withheld.push({videoId: videoId, reason: "duration_metadata_missing"});
        return;
      }
      if (filterShorts && experimentIsShort_(duration)) {
        result.rejected.push({videoId: videoId, reason: "short"});
        return;
      }

      result.kept.push(videoId);
    });
  }

  return result;
}

function experimentAdmissionDecision_(item) {
  // Delegate to the production decision helper whenever both files are loaded.
  // The fallback is intentionally equivalent so this read-only file is still
  // safe when copied into an Apps Script project independently.
  if (typeof evaluateVideoAdmissionPolicy === "function") {
    return evaluateVideoAdmissionPolicy(item);
  }

  var classification = experimentStrictClassification_(item);
  var decision = {
    allowed: false,
    blocking: false,
    classification: classification,
    admissionClass: classification,
    reason: ""
  };
  if (classification === "NORMAL_UPLOAD") {
    decision.allowed = true;
    decision.reason = "normal_upload";
    return decision;
  }
  if (classification === "UPCOMING") {
    decision.reason = "upcoming_broadcast_rejected_by_strict_policy";
    return decision;
  }
  if (classification === "ACTIVE") {
    decision.reason = "active_broadcast_rejected_by_strict_policy";
    return decision;
  }
  if (classification === "COMPLETED_LIVE") {
    decision.reason = "completed_broadcast_rejected_by_strict_policy";
    return decision;
  }
  if (classification !== "NORMAL_UPLOAD") {
    decision.blocking = true;
    decision.reason = "live_state_missing_or_unknown";
    return decision;
  }
  return decision;
}

function experimentStrictClassification_(item) {
  // V5 exposes this pure classifier. Delegating when it exists prevents the
  // experiment oracle and production oracle from drifting apart.
  if (typeof classifyVideoStrict === "function") return classifyVideoStrict(item);
  if (!item || !item.snippet) return "UNKNOWN";

  var liveState = experimentNormalize_(item.snippet.liveBroadcastContent).toLowerCase();
  if (liveState === "upcoming") return "UPCOMING";
  if (liveState === "live") return "ACTIVE";
  if (liveState !== "none") return "UNKNOWN";
  if (item.liveStreamingDetails !== undefined && item.liveStreamingDetails !== null) {
    return "COMPLETED_LIVE";
  }
  return "NORMAL_UPLOAD";
}

function experimentReadTargetVideoSet_(playlistId, state) {
  var videoSet = Object.create(null);
  var nextPageToken = null;
  var seenPageTokens = Object.create(null);
  var readComplete = true;
  do {
    try {
      var options = {
        playlistId: playlistId,
        maxResults: 50,
        fields: "nextPageToken,items(contentDetails(videoId))"
      };
      if (nextPageToken) options.pageToken = nextPageToken;
      var response = YouTube.PlaylistItems.list("contentDetails", options);
      if (!response || !Array.isArray(response.items)) {
        experimentIssue_(state, "error", "target", "target_playlist_response_invalid");
        return {ok: false, videoSet: videoSet};
      }
      response.items.forEach(function(item) {
        var videoId = item && item.contentDetails && item.contentDetails.videoId;
        if (!videoId) {
          readComplete = false;
          experimentIssue_(state, "error", "target", "target_playlist_item_metadata_invalid");
          return;
        }
        videoSet[videoId] = true;
      });
      var returnedToken = response.nextPageToken || null;
      if (returnedToken && seenPageTokens[returnedToken]) {
        experimentIssue_(state, "error", "target", "target_playlist_page_token_repeated");
        return {ok: false, videoSet: videoSet};
      }
      if (returnedToken) seenPageTokens[returnedToken] = true;
      nextPageToken = returnedToken;
    } catch (error) {
      // A target read is never an optional missing-source condition. The
      // replay cannot safely predict de-duplication or checkpoint advancement.
      experimentIssue_(state, "error", "target", "target_playlist_read_failed", null, error);
      return {ok: false, videoSet: videoSet};
    }
  } while (nextPageToken);
  return {ok: readComplete, videoSet: videoSet};
}

function experimentIsShort_(duration) {
  // Keep the replay aligned with V4 when loaded beside sheetScript.gs.
  if (typeof isLessThanThreeMinutes === "function") {
    return isLessThanThreeMinutes(duration);
  }
  var seconds = experimentIsoDurationSeconds_(duration);
  return seconds !== null && seconds <= 181;
}

function experimentIsoDurationSeconds_(duration) {
  if (typeof parseIso8601DurationSeconds === "function") {
    return parseIso8601DurationSeconds(duration);
  }
  var text = experimentNormalize_(duration);
  var match = text.match(
    /^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?)?$/
  );
  if (!match || text.slice(-1) === "T" ||
      !match.slice(1).some(function(value) { return value !== undefined; })) {
    return null;
  }
  var total = (((Number(match[1] || 0) * 24 + Number(match[2] || 0)) * 60 +
    Number(match[3] || 0)) * 60 + Number(match[4] || 0));
  return isFinite(total) && total >= 0 ? total : null;
}

function experimentTimestampMillis_(value) {
  if (typeof parseApiTimestampMillis === "function") {
    return parseApiTimestampMillis(value);
  }
  var text = experimentNormalize_(value);
  if (!text) return null;

  var match = text.match(
    /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?(Z|([+-])(\d{2}):(\d{2}))$/
  );
  if (!match) return null;

  var year = Number(match[1]);
  var month = Number(match[2]);
  var day = Number(match[3]);
  var hour = Number(match[4]);
  var minute = Number(match[5]);
  var second = Number(match[6]);
  var fractionDigits = match[7] || "";
  var timezoneSign = match[9] || "";
  var timezoneHours = Number(match[10] || 0);
  var timezoneMinutes = Number(match[11] || 0);

  if (month < 1 || month > 12 || hour > 23 || minute > 59 || second > 59) return null;
  if (timezoneHours > 14 || timezoneMinutes > 59 ||
      (timezoneHours == 14 && timezoneMinutes !== 0)) return null;
  if (timezoneSign == "-" && timezoneHours === 0 && timezoneMinutes === 0) return null;

  var leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  var daysInMonth = [31, leapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (day < 1 || day > daysInMonth[month - 1]) return null;

  var date = new Date(0);
  date.setUTCFullYear(year, month - 1, day);
  date.setUTCHours(hour, minute, second, 0);
  var millis = date.getTime();
  if (!isFinite(millis)) return null;

  var fractionalMillis = fractionDigits
    ? Number("0." + fractionDigits) * 1000
    : 0;
  if (!isFinite(fractionalMillis)) return null;

  var offsetMinutes = timezoneHours * 60 + timezoneMinutes;
  if (timezoneSign == "-") offsetMinutes *= -1;
  millis += fractionalMillis - offsetMinutes * 60 * 1000;
  return isFinite(millis) ? millis : null;
}

function experimentState_() {
  return {issues: [], blockingErrorCount: 0, warningCount: 0};
}

function experimentIssue_(state, severity, stage, reason, source, error, videoId) {
  var issue = {severity: severity, stage: stage, reason: reason};
  if (source) {
    issue.sourceColumn = source.column;
    issue.sourceHash = source.hash;
  }
  if (videoId) issue.videoId = videoId;

  var code = experimentApiErrorCode_(error);
  var apiReason = experimentApiErrorReason_(error);
  if (code !== null) issue.apiCode = code;
  if (apiReason) issue.apiReason = apiReason;

  state.issues.push(issue);
  if (severity === "error") state.blockingErrorCount += 1;
  else state.warningCount += 1;
}

function experimentApiIssue_(state, stage, reason, source, error) {
  var code = experimentApiErrorCode_(error);
  var apiReason = experimentApiErrorReason_(error).toLowerCase();
  var permanentMissing = stage === "source" && (
    typeof isMissingSourceConfigurationError === "function"
      ? isMissingSourceConfigurationError(error)
      : code === 404 || apiReason.indexOf("notfound") >= 0 ||
        apiReason === "invalidchannelid" || apiReason === "invalidplaylist"
  );
  experimentIssue_(
    state,
    permanentMissing ? "warning" : "error",
    stage,
    reason,
    source,
    error
  );
}

function experimentSourcePageApiIssue_(state, reason, source, error, pagesRead) {
  if (pagesRead === 0) {
    experimentApiIssue_(state, "source", reason, source, error);
    return;
  }
  experimentIssue_(state, "error", "source", reason, source, error);
}

function experimentApiErrorCode_(error) {
  var value = error && error.details && error.details.code;
  if (value === undefined || value === null || isNaN(Number(value))) return null;
  return Number(value);
}

function experimentApiErrorReason_(error) {
  var errors = error && error.details && error.details.errors;
  var reason = errors && errors.length && errors[0].reason;
  // Only accept the documented enum-like token. Never propagate an API message,
  // because it may echo a private channel or playlist identifier.
  return reason && /^[A-Za-z0-9_.-]{1,80}$/.test(String(reason)) ? String(reason) : "";
}

function experimentDedupe_(values) {
  var seen = Object.create(null);
  return values.filter(function(value) {
    if (!value || Object.prototype.hasOwnProperty.call(seen, value)) return false;
    seen[value] = true;
    return true;
  });
}

function experimentNormalize_(value) {
  return value === null || value === undefined ? "" : String(value).trim();
}
