// Read-only experiment helpers for strict livestream-filter replays.
//
// These functions intentionally do not call processPlaylistRow(), applyFilters(),
// addVideosToPlaylist(), deletePlaylistItems(), or any Range setter. They read the
// configured row timestamp and source cells, query YouTube, and report what a
// strict ingestion policy would do without mutating the sheet or a playlist.

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

/**
 * Read-only replay of one configured playlist row under the strict policy.
 *
 * Strict means that any documented broadcast marker is rejected. A video is
 * eligible only when snippet.liveBroadcastContent is exactly "none" and
 * liveStreamingDetails is absent. Column F is intentionally ignored because a
 * duration threshold cannot determine whether an item is a livestream.
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
      schemaVersion: 1,
      policy: "strict-documented-broadcast-markers",
      dryRun: true,
      rowNumber: rowNumber,
      timestampReadFromColumnB: timestamp,
      sourceConfigurationHash: expectedSourceHash,
      rowSourceHash: experimentSourceRowFingerprint_(sheet, rowNumber),
      sourceCount: sources.length,
      sourceHashes: sources.map(function(source) { return source.hash; }),
      filterShorts: filterShorts,
      columnFIgnoredByStrictPolicy: true,
      acquiredCandidateIds: candidateIds,
      keptCandidateIds: classification.kept,
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

    // The structured line contains video IDs for comparison, but no channel IDs
    // or source-playlist IDs. Raw sources remain local variables only.
    Logger.log("STRICT_REPLAY_RESULT " + JSON.stringify(result));
    return result;
  } finally {
    assertSourceConfigurationUnchanged(expectedSourceHash, sheet);
  }
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
      if (!response || !response.items) {
        experimentIssue_(state, "error", "source", "subscriptions_response_invalid", source);
        return channelIds;
      }
      response.items.forEach(function(item) {
        var channelId = item && item.snippet && item.snippet.resourceId &&
          item.snippet.resourceId.channelId;
        if (channelId) channelIds.push(channelId);
      });
      nextPageToken = response.nextPageToken || null;
    } while (nextPageToken);
    readCompleted = true;
  } catch (error) {
    experimentApiIssue_(state, "source", "subscriptions_read_failed", source, error);
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
    if (!response || !response.items) {
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
    if (!channelResponse || !channelResponse.items) {
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
  do {
    try {
      var options = {
        playlistId: uploadsPlaylistId,
        maxResults: 50,
        fields: "nextPageToken,items(contentDetails(videoId,videoPublishedAt))"
      };
      if (nextPageToken) options.pageToken = nextPageToken;
      var response = YouTube.PlaylistItems.list("contentDetails", options);
      if (!response || !response.items) {
        experimentIssue_(state, "error", "source", "uploads_response_invalid", source);
        return videoIds.reverse();
      }

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
      nextPageToken = response.nextPageToken || null;
    } catch (error) {
      experimentApiIssue_(state, "source", "uploads_playlist_read_failed", source, error);
      return videoIds.reverse();
    }
  } while (nextPageToken);

  return videoIds.reverse();
}

function experimentReadSourcePlaylistVideos_(playlistId, checkpointMillis, source, state) {
  var videoIds = [];
  var nextPageToken = null;
  do {
    try {
      var options = {
        playlistId: playlistId,
        maxResults: 50,
        fields: "nextPageToken,items(snippet(publishedAt,resourceId(videoId)))"
      };
      if (nextPageToken) options.pageToken = nextPageToken;
      var response = YouTube.PlaylistItems.list("snippet", options);
      if (!response || !response.items) {
        experimentIssue_(state, "error", "source", "source_playlist_response_invalid", source);
        return videoIds;
      }
      response.items.forEach(function(item) {
        var snippet = item && item.snippet;
        var videoId = snippet && snippet.resourceId && snippet.resourceId.videoId;
        var publishedMillis = snippet && new Date(snippet.publishedAt).getTime();
        if (!videoId || isNaN(publishedMillis)) {
          experimentIssue_(state, "error", "source", "source_playlist_item_metadata_invalid", source);
          return;
        }
        if (publishedMillis > checkpointMillis) videoIds.push(videoId);
      });
      nextPageToken = response.nextPageToken || null;
    } catch (error) {
      experimentApiIssue_(state, "source", "source_playlist_read_failed", source, error);
      return videoIds;
    }
  } while (nextPageToken);
  return videoIds;
}

function experimentClassifyStrict_(videoIds, filterShorts, state) {
  var result = {kept: [], rejected: [], withheld: []};

  for (var start = 0; start < videoIds.length; start += 50) {
    var batch = videoIds.slice(start, start + 50);
    var response;
    try {
      response = YouTube.Videos.list("snippet,contentDetails,liveStreamingDetails", {
        id: batch.join(","),
        maxResults: 50,
        fields: "items(id,snippet(liveBroadcastContent),contentDetails(duration),liveStreamingDetails)"
      });
    } catch (error) {
      experimentApiIssue_(state, "filter", "video_metadata_batch_failed", null, error);
      batch.forEach(function(videoId) {
        result.withheld.push({videoId: videoId, reason: "metadata_batch_failed"});
      });
      continue;
    }

    if (!response || !response.items) {
      experimentIssue_(state, "error", "filter", "video_metadata_response_invalid");
      batch.forEach(function(videoId) {
        result.withheld.push({videoId: videoId, reason: "metadata_response_invalid"});
      });
      continue;
    }

    var byId = {};
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
      var strictClassification = experimentStrictClassification_(item);

      if (strictClassification === "UPCOMING" || strictClassification === "ACTIVE" ||
          strictClassification === "COMPLETED_LIVE") {
        result.rejected.push({
          videoId: videoId,
          reason: "broadcast_marker",
          classification: strictClassification,
          liveBroadcastContent: liveState || null,
          hasLiveStreamingDetails: hasLiveStreamingDetails
        });
        return;
      }

      // Fail closed: the documented ordinary-video state must be explicit.
      if (strictClassification !== "NORMAL_UPLOAD") {
        experimentIssue_(state, "error", "filter", "live_state_missing_or_unknown", null, null, videoId);
        result.withheld.push({videoId: videoId, reason: "live_state_missing_or_unknown"});
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
  var videoSet = {};
  var nextPageToken = null;
  do {
    try {
      var options = {
        playlistId: playlistId,
        maxResults: 50,
        fields: "nextPageToken,items(contentDetails(videoId))"
      };
      if (nextPageToken) options.pageToken = nextPageToken;
      var response = YouTube.PlaylistItems.list("contentDetails", options);
      if (!response || !response.items) {
        experimentIssue_(state, "error", "target", "target_playlist_response_invalid");
        return {ok: false, videoSet: videoSet};
      }
      response.items.forEach(function(item) {
        var videoId = item && item.contentDetails && item.contentDetails.videoId;
        if (videoId) videoSet[videoId] = true;
      });
      nextPageToken = response.nextPageToken || null;
    } catch (error) {
      experimentApiIssue_(state, "target", "target_playlist_read_failed", null, error);
      return {ok: false, videoSet: videoSet};
    }
  } while (nextPageToken);
  return {ok: true, videoSet: videoSet};
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
  var match = String(duration || "").match(
    /^P(?:(\d+)D)?T?(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/
  );
  if (!match) return null;
  return (((Number(match[1] || 0) * 24 + Number(match[2] || 0)) * 60 +
    Number(match[3] || 0)) * 60 + Number(match[4] || 0));
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
  var permanentMissing = code === 404 || apiReason.indexOf("notfound") >= 0 ||
    apiReason === "invalidchannelid" || apiReason === "invalidplaylist";
  experimentIssue_(
    state,
    permanentMissing ? "warning" : "error",
    stage,
    reason,
    source,
    error
  );
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
  var seen = {};
  return values.filter(function(value) {
    if (!value || seen[value]) return false;
    seen[value] = true;
    return true;
  });
}

function experimentNormalize_(value) {
  return value === null || value === undefined ? "" : String(value).trim();
}
