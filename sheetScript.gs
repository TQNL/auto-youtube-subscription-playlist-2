// Reliability-fixed version: 2026-08-04
// Source/read, filter, insertion, and maintenance failures are isolated per row.
// Permanent missing sources and independent cleanup failures are non-blocking warnings.
// Auto Youtube Subscription Playlist (2)
// This is a Google Apps Script that automatically adds new Youtube videos to playlists (a replacement for Youtube Collections feature).
// Code: https://github.com/Elijas/auto-youtube-subscription-playlist-2/
// Copy Spreadsheet: 
// https://docs.google.com/spreadsheets/d/1sZ9U52iuws6ijWPQTmQkXvaZSV3dZ3W9JzhnhNTX9GU/copy

// Safety budget for expensive playlist mutations. YouTube currently charges
// 50 quota units for playlistItems.insert and playlistItems.delete. Keeping the
// per-execution ceiling at 150 leaves headroom under a normal 10,000-unit daily
// allocation for reads, filters, and other executions. This is not a guarantee
// of remaining daily quota; it is a conservative circuit breaker.
var maxPlaylistWriteOperationsPerRun = 150;
var playlistWriteOperationsUsed = 0;

// Livestream filtering policy used when column F is blank.
//   strict: keep upcoming items, remove active broadcasts and every completed
//           live-like item. This guarantees that archived livestreams such as
//           a 1h56 stream are rejected, but may also reject a Premiere first
//           discovered after it has completed because the public API exposes
//           no reliable completed-stream-versus-Premiere discriminator.
//   long:   legacy behavior; remove active broadcasts and completed live-like
//           items only when their duration/live window is over two hours.
//   off:    do not apply a livestream filter.
var defaultLivestreamFilterMode = "strict";

// Per-execution and per-row state. Source, filter, write, and maintenance
// failures are tracked separately so one broken source cannot cancel videos
// obtained from healthy sources.
var totalErrorCount = 0;
var totalWarningCount = 0;
var currentRowStatus = null;
var targetPlaylistVideoCache = {};
var debugFlag_dontUpdateTimestamp = false;
var debugFlag_dontUpdatePlaylists = false;
var debugFlag_logWhenNoNewVideosFound = false;


// Reserved Row and Column indices (zero-based)
// If you use getRange remember those indices are one-based, so add + 1 in that call i.e.
// sheet.getRange(iRow + 1, reservedColumnTimestamp + 1).setValue(isodate);
var reservedTableRows = 3;          // Start of the range of the PlaylistID+ChannelID data
var reservedTableColumns = 6;       // Start of the range of the ChannelID data (0: A, 1: B, 2: C, 3: D, 4: E, 5: F, ...)
var reservedColumnPlaylist = 0;     // Column containing playlist to add to
var reservedColumnTimestamp = 1;    // Column containing last timestamp
var reservedColumnFrequency = 2;    // Column containing number of hours until new check
var reservedColumnDeleteDays = 3;   // Column containing number of days before today until videos get deleted
var reservedColumnShortsFilter = 4; // Column containing switch for using shorts filter
var reservedColumnLongVideosFilter = 5; // Livestream mode: Strict, Long, or Off (blank uses the default above)
// Reserved lengths
var reservedDebugNumRows = 900;   // Number of rows to use in a column before moving on to the next column in debug sheet
var reservedDebugNumColumns = 26; // Number of columns to use in debug sheet, must be at least 4 to allow infinite cycle

// Extend Date with Iso String with timzone support (Youtube needs IsoDates)
// https://stackoverflow.com/questions/17415579/how-to-iso-8601-format-a-date-with-timezone-offset-in-javascript
Date.prototype.toIsoString = function() {
    var tzo = -this.getTimezoneOffset(),
        dif = tzo >= 0 ? '+' : '-',
        pad = function(num) {
            var norm = Math.floor(Math.abs(num));
            return (norm < 10 ? '0' : '') + norm;
        };
    return this.getFullYear() +
        '-' + pad(this.getMonth() + 1) +
        '-' + pad(this.getDate()) +
        'T' + pad(this.getHours()) +
        ':' + pad(this.getMinutes()) +
        ':' + pad(this.getSeconds()) +
        dif + pad(tzo / 60) +
        ':' + pad(tzo % 60);
}

//
// Main Function to update all Playlists
//

function updatePlaylists(sheet) {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(10000)) {
    throw new Error("Another playlist update is already running. Try again after it finishes.");
  }

  try {
    totalErrorCount = 0;
    totalWarningCount = 0;
    playlistWriteOperationsUsed = 0;
    targetPlaylistVideoCache = {};
    return updatePlaylistsLocked(sheet);
  } finally {
    lock.releaseLock();
  }
}

function updatePlaylistsLocked(sheet) {
  var sheetID = PropertiesService.getScriptProperties().getProperty("sheetID");
  if (!sheetID) {
    onOpen();
    sheetID = PropertiesService.getScriptProperties().getProperty("sheetID");
  }
  if (!sheetID) throw new Error("Cannot determine spreadsheet ID. Open the sheet once and try again.");

  var spreadsheet = SpreadsheetApp.openById(sheetID);
  if (!sheet || !sheet.toString || sheet.toString() != 'Sheet') sheet = spreadsheet.getSheets()[0];
  if (!sheet || sheet.getRange("A3").getValue() !== "Playlist ID") {
    var additional = sheet ? ", instead found sheet with name " + sheet.getName() : "";
    throw new Error("Cannot find playlist sheet, make sure the sheet with playlist IDs and channels is the first sheet (leftmost)" + additional);
  }

  var data = sheet.getDataRange().getValues();
  var debugSheet = spreadsheet.getSheetByName("DebugData");
  if (!debugSheet) debugSheet = spreadsheet.insertSheet("DebugData").hideSheet();
  var nextDebugCol = getNextDebugCol(debugSheet);
  var nextDebugRow = getNextDebugRow(debugSheet, nextDebugCol);
  var debugViewerSheet = spreadsheet.getSheetByName("Debug");
  initDebugEntry(debugViewerSheet, nextDebugCol, nextDebugRow);

  for (var iRow = reservedTableRows; iRow < sheet.getLastRow(); iRow++) {
    var playlistId = normalizeCellValue(data[iRow][reservedColumnPlaylist]);
    if (!playlistId) continue;

    Logger.clear();
    Logger.log("Row: " + (iRow + 1));
    currentRowStatus = createRowStatus();

    try {
      processPlaylistRow(sheet, data, iRow, playlistId);
    } catch (e) {
      recordRowError("unexpected", "Unexpected row failure: " + describeError(e));
    } finally {
      if (currentRowStatus.errorCount > 0) {
        Logger.log(
          "Row completed with blocking failures (source=" + currentRowStatus.sourceErrors +
          ", filter=" + currentRowStatus.filterErrors +
          ", write=" + currentRowStatus.writeErrors +
          ", maintenance=" + currentRowStatus.maintenanceErrors +
          ", unexpected=" + currentRowStatus.unexpectedErrors +
          "). Timestamp was not updated."
        );
      } else if (currentRowStatus.warningCount > 0) {
        Logger.log(
          "Row completed with non-blocking warnings (source=" + currentRowStatus.sourceWarnings +
          ", filter=" + currentRowStatus.filterWarnings +
          ", write=" + currentRowStatus.writeWarnings +
          ", maintenance=" + currentRowStatus.maintenanceWarnings +
          ", unexpected=" + currentRowStatus.unexpectedWarnings +
          "). Timestamp " + (currentRowStatus.timestampUpdated ? "was updated." : "was not updated.")
        );
      }

      var newLogs = formatLogsForDebugSheet(Logger.getLog());
      if (newLogs.length > 0) {
        debugSheet.getRange(nextDebugRow + 1, nextDebugCol + 1, newLogs.length, 2).setValues(newLogs);
      }
      nextDebugRow += newLogs.length;
      totalErrorCount += currentRowStatus.errorCount;
      totalWarningCount += currentRowStatus.warningCount;
      currentRowStatus = null;
    }
  }

  if (totalErrorCount == 0 && totalWarningCount == 0) {
    debugSheet.getRange(nextDebugRow + 1, nextDebugCol + 2).setValue("Updated all rows, script successfully finished");
  } else if (totalErrorCount == 0) {
    debugSheet.getRange(nextDebugRow + 1, nextDebugCol + 2).setValue("Updated all rows with " + totalWarningCount + " non-blocking warning(s)");
  } else {
    debugSheet.getRange(nextDebugRow + 1, nextDebugCol + 2).setValue("Script finished with partial failures");
  }
  nextDebugRow += 1;

  if (nextDebugRow > reservedDebugNumRows - 1) {
    var colIndex = 0;
    if (nextDebugCol < reservedDebugNumColumns - 2) colIndex = nextDebugCol + 2;
    clearDebugCol(debugSheet, colIndex);
  }

  loadLastDebugLog(debugViewerSheet);
  if (totalErrorCount > 0) {
    throw new Error(totalErrorCount + " error(s) occurred. Healthy sources were still processed; affected row timestamps were not updated. Check the Debug sheet.");
  }
}

function processPlaylistRow(sheet, data, iRow, playlistId) {
  var MILLIS_PER_HOUR = 1000 * 60 * 60;
  var MILLIS_PER_DAY = MILLIS_PER_HOUR * 24;
  var lastTimestamp = data[iRow][reservedColumnTimestamp];

  if (!lastTimestamp) {
    var date = new Date();
    date.setHours(date.getHours() - 24);
    lastTimestamp = date.toIsoString();
    sheet.getRange(iRow + 1, reservedColumnTimestamp + 1).setValue(lastTimestamp);
  }

  var freqDate = new Date(lastTimestamp);
  var dateDiff = Date.now() - freqDate.getTime();
  var nextTime = data[iRow][reservedColumnFrequency] * MILLIS_PER_HOUR;
  if (nextTime && dateDiff <= nextTime) {
    Logger.log("Skipped: Not time yet");
    return;
  }

  var channelIds = [];
  var playlistIds = [];
  for (var iColumn = reservedTableColumns; iColumn < sheet.getLastColumn(); iColumn++) {
    var source = normalizeCellValue(data[iRow][iColumn]);
    if (!source) continue;

    if (source == "ALL") {
      var sourceErrorsBefore = currentRowStatus.sourceErrors;
      var newChannelIds = getAllChannelIds();
      if (newChannelIds.length === 0 && currentRowStatus.sourceErrors === sourceErrorsBefore) {
        recordRowWarning("source", "The ALL source returned no subscriptions");
      } else {
        [].push.apply(channelIds, newChannelIds);
      }
    } else if (source.substring(0, 2) == "PL" && source.length > 10) {
      playlistIds.push(source);
    } else if (!(source.substring(0, 2) == "UC" && source.length > 10)) {
      try {
        var user = YouTube.Channels.list('id', {forUsername: source, maxResults: 1});
        if (!user || !user.items) recordRowError("source", "Cannot query for user " + source);
        else if (user.items.length === 0) recordRowWarning("source", "No user with name " + source + "; source skipped");
        else if (user.items.length !== 1) recordRowWarning("source", "Ambiguous user name " + source + "; source skipped");
        else if (!user.items[0].id) recordRowError("source", "Cannot get id from user " + source);
        else channelIds.push(user.items[0].id);
      } catch (e) {
        recordSourceReadFailure("Cannot search for channel with name " + source, e);
      }
    } else {
      channelIds.push(source);
    }
  }

  var newVideoIds = [];
  for (var channelIndex = 0; channelIndex < channelIds.length; channelIndex++) {
    var channelVideos = getVideoIdsWithLessQueries(channelIds[channelIndex], lastTimestamp);
    if (debugFlag_logWhenNoNewVideosFound && channelVideos.length === 0) {
      Logger.log("Channel with id " + channelIds[channelIndex] + " has no new videos");
    }
    [].push.apply(newVideoIds, channelVideos);
  }

  for (var playlistIndex = 0; playlistIndex < playlistIds.length; playlistIndex++) {
    var playlistVideos = getPlaylistVideoIds(playlistIds[playlistIndex], lastTimestamp);
    if (debugFlag_logWhenNoNewVideosFound && playlistVideos.length === 0) {
      Logger.log("Playlist with id " + playlistIds[playlistIndex] + " has no new videos");
    }
    [].push.apply(newVideoIds, playlistVideos);
  }

  newVideoIds = dedupeVideoIds(newVideoIds);
  Logger.log("Acquired " + newVideoIds.length + " unique videos");
  newVideoIds = applyFilters(newVideoIds, sheet, iRow);
  Logger.log("Filtering finished, left with " + newVideoIds.length + " videos");

  // Issues do not cancel candidates from healthy sources. Only failures that
  // could lose retryable candidates (transient source/filter/write/unexpected)
  // block the timestamp. Permanent bad-source and cleanup issues are warnings.
  if (!debugFlag_dontUpdatePlaylists) {
    addVideosToPlaylist(playlistId, newVideoIds);
  } else {
    recordRowError("write", "Don't Update Playlists debug flag is set");
  }

  var daysBack = data[iRow][reservedColumnDeleteDays];
  if (daysBack && daysBack > 0) {
    var deleteBeforeTimestamp = new Date((new Date()).getTime() - daysBack * MILLIS_PER_DAY).toIsoString();
    Logger.log("Delete before: " + deleteBeforeTimestamp);
    deletePlaylistItems(playlistId, deleteBeforeTimestamp);
  }

  if (currentRowStatus.errorCount === 0 && !debugFlag_dontUpdateTimestamp) {
    sheet.getRange(iRow + 1, reservedColumnTimestamp + 1).setValue(new Date().toIsoString());
    currentRowStatus.timestampUpdated = true;
  } else if (debugFlag_dontUpdateTimestamp) {
    Logger.log("Timestamp update disabled by debug flag");
  }
}

function createRowStatus() {
  return {
    sourceErrors: 0,
    sourceWarnings: 0,
    filterErrors: 0,
    filterWarnings: 0,
    writeErrors: 0,
    writeWarnings: 0,
    maintenanceErrors: 0,
    maintenanceWarnings: 0,
    unexpectedErrors: 0,
    unexpectedWarnings: 0,
    errorCount: 0,
    warningCount: 0,
    timestampUpdated: false
  };
}

function recordRowError(category, message) {
  recordRowIssue(category, message, true);
}

function recordRowWarning(category, message) {
  recordRowIssue(category, message, false);
}

function recordRowIssue(category, message, blocksTimestamp) {
  var severity = blocksTimestamp ? "ERROR" : "WARNING";
  Logger.log(severity + " [" + category.toUpperCase() + "]: " + message);
  if (!currentRowStatus) return;

  var suffix = blocksTimestamp ? "Errors" : "Warnings";
  var field = category + suffix;
  if (typeof currentRowStatus[field] !== "number") field = "unexpected" + suffix;
  currentRowStatus[field] += 1;
  if (blocksTimestamp) currentRowStatus.errorCount += 1;
  else currentRowStatus.warningCount += 1;
}

function isMissingSourceConfigurationError(e) {
  var code = getErrorCode(e);
  var reason = String(getErrorReason(e) || "").toLowerCase();
  var message = String(e && e.message ? e.message : e || "").toLowerCase();
  return code === 404 ||
    reason.indexOf("notfound") >= 0 ||
    reason === "invalidchannelid" ||
    reason === "invalidplaylist" ||
    message.indexOf("cannot be found") >= 0 ||
    message.indexOf("not found") >= 0 ||
    message.indexOf("does not exist") >= 0;
}

function recordSourceReadFailure(context, e) {
  var message = context + ": " + describeError(e);
  if (isMissingSourceConfigurationError(e)) {
    recordRowWarning("source", message + ". Source skipped; fix or remove its sheet entry.");
  } else {
    recordRowError("source", message);
  }
}
function normalizeCellValue(value) {
  return value === null || value === undefined ? "" : String(value).trim();
}

function dedupeVideoIds(videoIds) {
  var seen = {};
  return videoIds.filter(function(videoId) {
    if (!videoId || seen[videoId]) return false;
    seen[videoId] = true;
    return true;
  });
}

function describeError(e) {
  if (!e) return "Unknown error";
  var message = e.message || String(e);
  var details = e.details === undefined ? "" : " Details: " + safeJson(e.details);
  return "Message: [" + message + "]" + details;
}

function safeJson(value) {
  try {
    return JSON.stringify(value);
  } catch (ignored) {
    return String(value);
  }
}

function getErrorCode(e) {
  return e && e.details && e.details.code !== undefined ? Number(e.details.code) : null;
}

function getErrorReason(e) {
  var errors = e && e.details && e.details.errors;
  return errors && errors.length && errors[0].reason ? errors[0].reason : "";
}

function formatLogsForDebugSheet(logText) {
  if (!logText) return [];
  var fallbackTimestamp = new Date();
  return logText.split(/\r?\n/).filter(function(line) {
    return line !== "";
  }).map(function(line) {
    var marker = " INFO: ";
    var markerIndex = line.indexOf(marker);
    if (markerIndex >= 0) {
      return [line.substring(0, markerIndex), line.substring(markerIndex + marker.length)];
    }
    return [fallbackTimestamp, line];
  });
}
//
// Functions to obtain channel IDs to check
//

// Display dialog to get channel ID from channel name
function getChannelId() {
  var ui = SpreadsheetApp.getUi();

  var result = ui.prompt(
    'Get Channel ID',
    'Please input a channel name:',
    ui.ButtonSet.OK_CANCEL);
  var button = result.getSelectedButton();
  var text = result.getResponseText();

  if (button == ui.Button.OK) {
    var results = YouTube.Search.list('id', {
      q: text,
      type: "channel",
      maxResults: 50,
    });

    for (var i = 0; i < results.items.length; i++) {
      var result = ui.alert(
        'Please confirm',
        'Is this the link to the channel you want?\n\nhttps://youtube.com/channel/' + results.items[i].id.channelId + '',
        ui.ButtonSet.YES_NO);
      if (result == ui.Button.YES) {
        ui.alert('The channel ID is ' + results.items[i].id.channelId);
        return;
      } else if (result == ui.Button.NO) {
        continue;
      } else {
        return;
      }
    }

    ui.alert('No results found for ' + text + '.');
  } else if (button == ui.Button.CANCEL) {
    return;
  } else if (button == ui.Button.CLOSE) {
    return;
  }
}

// Get Channel IDs from Subscriptions (ALL keyword)
function getAllChannelIds() { // Get the authenticated user's subscriptions.
  var channelIds = [];
  var nextPageToken = '';

  try {
    do {
      var response = YouTube.Subscriptions.list('snippet', {
        mine: true,
        maxResults: 50,
        order: 'alphabetical',
        pageToken: nextPageToken,
        fields: 'nextPageToken,items(snippet(resourceId(channelId)))'
      });

      if (!response || !response.items) {
        recordRowError("source", "YouTube subscriptions search returned an invalid response");
        return channelIds;
      }

      response.items.forEach(function(item) {
        var channelId = item && item.snippet && item.snippet.resourceId && item.snippet.resourceId.channelId;
        if (channelId) channelIds.push(channelId);
      });
      nextPageToken = response.nextPageToken || null;
    } while (nextPageToken !== null);
  } catch (e) {
    recordRowError("source", "Could not get subscribed channels: " + describeError(e));
  }

  Logger.log('Acquired subscriptions ' + channelIds.length);
  return channelIds;
}

function getVideoIds(channelId, lastTimestamp) {
  var videoIds = [];
  var nextPageToken = '';

  do {
    try {
      var results = YouTube.Search.list('id', {
        channelId: channelId,
        maxResults: 50,
        order: "date",
        publishedAfter: lastTimestamp,
        pageToken: nextPageToken,
        type: "video"
      });
      if (!results || !results.items) {
        recordRowError("source", "YouTube video search returned an invalid response for channel " + channelId);
        return videoIds;
      }
    } catch (e) {
      recordSourceReadFailure("Cannot search YouTube with channel id " + channelId, e);
      return videoIds;
    }

    results.items.forEach(function(item) {
      if (item && item.id && item.id.videoId) videoIds.push(item.id.videoId);
    });
    nextPageToken = results.nextPageToken || null;
  } while (nextPageToken !== null);

  if (videoIds.length === 0) {
    try {
      var channelResults = YouTube.Channels.list('id', {id: channelId});
      if (!channelResults || !channelResults.items) {
        recordRowError("source", "YouTube channel search returned an invalid response for channel " + channelId);
      } else if (channelResults.items.length === 0) {
        recordRowWarning("source", "Cannot find channel with id " + channelId + "; source skipped");
      }
    } catch (e) {
      recordSourceReadFailure("Cannot validate channel " + channelId, e);
    }
  }

  return videoIds;
}

// Get videos from a channel's uploads playlist with low quota use.

function getVideoIdsWithLessQueries(channelId, lastTimestamp) {
  var videoIds = [];
  var uploadsPlaylistId;

  try {
    var channelResults = YouTube.Channels.list('contentDetails', {id: channelId});
    if (!channelResults || !channelResults.items) {
      recordRowError("source", "YouTube channel search returned an invalid response for channel " + channelId);
      return videoIds;
    }
    if (channelResults.items.length === 0) {
      recordRowWarning("source", "Cannot find channel with id " + channelId + "; source skipped");
      return videoIds;
    }
    uploadsPlaylistId = channelResults.items[0].contentDetails.relatedPlaylists.uploads;
  } catch (e) {
    recordSourceReadFailure("Cannot search YouTube for channel " + channelId, e);
    return videoIds;
  }

  var nextPageToken = '';
  do {
    try {
      var results = YouTube.PlaylistItems.list('contentDetails', {
        playlistId: uploadsPlaylistId,
        maxResults: 50,
        pageToken: nextPageToken,
        fields: 'nextPageToken,items(contentDetails(videoId,videoPublishedAt))'
      });
      if (!results || !results.items) {
        recordRowError("source", "Uploads playlist returned an invalid response for channel " + channelId);
        return videoIds;
      }

      var videosToBeAdded = results.items.filter(function(item) {
        return item && item.contentDetails && item.contentDetails.videoId &&
          new Date(lastTimestamp) <= new Date(item.contentDetails.videoPublishedAt);
      });
      [].push.apply(videoIds, videosToBeAdded.map(function(item) {
        return item.contentDetails.videoId;
      }));

      // Uploads playlists are newest-first. Once a whole page predates the
      // checkpoint there is no reason to request older pages.
      if (results.items.length > 0 && videosToBeAdded.length === 0) break;
      nextPageToken = results.nextPageToken || null;
    } catch (e) {
      recordSourceReadFailure("Cannot search uploads playlist " + uploadsPlaylistId + " for channel " + channelId, e);
      return videoIds.reverse();
    }
  } while (nextPageToken !== null);

  return videoIds.reverse(); // Ascending publication order for insertion.
}

// Get video IDs from an explicit source playlist.

function getPlaylistVideoIds(playlistId, lastTimestamp) {
  var videoIds = [];
  var nextPageToken = '';
  var checkpoint = new Date(lastTimestamp);

  // playlistItems.list has no order or publishedAfter parameters. Explicit
  // playlists can also be manually ordered, so every page must be fetched and
  // snippet.publishedAt (the time the item was added) must be filtered locally.
  do {
    try {
      var results = YouTube.PlaylistItems.list('snippet', {
        playlistId: playlistId,
        maxResults: 50,
        pageToken: nextPageToken,
        fields: 'nextPageToken,items(snippet(publishedAt,resourceId(videoId)))'
      });
      if (!results || !results.items) {
        recordRowError("source", "YouTube playlist search returned an invalid response for playlist " + playlistId);
        return videoIds;
      }

      results.items.forEach(function(item) {
        var snippet = item && item.snippet;
        var videoId = snippet && snippet.resourceId && snippet.resourceId.videoId;
        if (videoId && new Date(snippet.publishedAt) > checkpoint) videoIds.push(videoId);
      });
      nextPageToken = results.nextPageToken || null;
    } catch (e) {
      recordSourceReadFailure("Cannot read source playlist " + playlistId, e);
      return videoIds;
    }
  } while (nextPageToken !== null);

  return videoIds;
}

// Read the target once so retries and partially successful prior runs do not
// waste insert quota on videos that are already present.
function getTargetPlaylistVideoSet(playlistId) {
  if (targetPlaylistVideoCache[playlistId]) return targetPlaylistVideoCache[playlistId];

  var videoSet = {};
  var nextPageToken = '';
  do {
    try {
      var results = YouTube.PlaylistItems.list('contentDetails', {
        playlistId: playlistId,
        maxResults: 50,
        pageToken: nextPageToken,
        fields: 'nextPageToken,items(contentDetails(videoId))'
      });
      if (!results || !results.items) {
        recordRowError("write", "Target playlist returned an invalid response for playlist " + playlistId);
        return null;
      }

      results.items.forEach(function(item) {
        var videoId = item && item.contentDetails && item.contentDetails.videoId;
        if (videoId) videoSet[videoId] = true;
      });
      nextPageToken = results.nextPageToken || null;
    } catch (e) {
      recordRowError("write", "Cannot read target playlist " + playlistId + " before insertion: " + describeError(e));
      return null;
    }
  } while (nextPageToken !== null);

  targetPlaylistVideoCache[playlistId] = videoSet;
  return videoSet;
}

// Add videos using an iterative, execution-wide mutation budget. If all
// candidates cannot fit in the remaining budget, none from this row are added.
function addVideosToPlaylist(playlistId, videoIds) {
  if (!videoIds.length) {
    Logger.log("No new videos yet.");
    return;
  }

  var existingVideos = getTargetPlaylistVideoSet(playlistId);
  if (existingVideos === null) return;

  var pendingVideoIds = videoIds.filter(function(videoId) {
    return !existingVideos[videoId];
  });
  var alreadyPresentCount = videoIds.length - pendingVideoIds.length;
  if (alreadyPresentCount > 0) {
    Logger.log("Skipped " + alreadyPresentCount + " video(s) already present in the target playlist.");
  }
  if (!pendingVideoIds.length) {
    Logger.log("No new videos to insert after target-playlist de-duplication.");
    return;
  }

  var remainingOperations = maxPlaylistWriteOperationsPerRun - playlistWriteOperationsUsed;
  if (pendingVideoIds.length > remainingOperations) {
    recordRowError(
      "write",
      "Refusing a partial insert: " + pendingVideoIds.length + " videos need playlist writes, but only " +
      Math.max(0, remainingOperations) + " of the per-run safety budget remain. No videos from this row were inserted."
    );
    return;
  }

  var successCount = 0;
  var skippedCount = 0;
  var errorCount = 0;
  for (var i = 0; i < pendingVideoIds.length; i++) {
    var videoId = pendingVideoIds[i];
    playlistWriteOperationsUsed += 1;
    try {
      YouTube.PlaylistItems.insert({
        snippet: {
          playlistId: playlistId,
          resourceId: {videoId: videoId, kind: 'youtube#video'}
        }
      }, 'snippet');
      existingVideos[videoId] = true;
      successCount += 1;
    } catch (e) {
      var code = getErrorCode(e);
      var reason = getErrorReason(e);
      if (code === 409) {
        existingVideos[videoId] = true;
        skippedCount += 1;
        Logger.log("Skipped video already present in playlist: " + videoId);
      } else if (reason === "videoNotFound") {
        skippedCount += 1;
        Logger.log("Skipped unavailable/private video: " + videoId);
      } else if (reason === "playlistOperationUnsupported") {
        errorCount += 1;
        recordRowError("write", "The target is a playlist that the API cannot modify (for example Watch Later or Watch History): " + playlistId);
        break;
      } else {
        errorCount += 1;
        recordRowError("write", "Could not insert video " + videoId + " into playlist " + playlistId + ": " + describeError(e));
      }
    }
  }

  Logger.log("Added " + successCount + " video(s); skipped " + skippedCount + "; failed " + errorCount + ".");
}

// Delete old and duplicate items only after all pages have been read. Mutating
// a playlist while paging through it can otherwise skip entries.
function deletePlaylistItems(playlistId, deleteBeforeTimestamp) {
  var allItems = [];
  var nextPageToken = '';

  do {
    try {
      var results = YouTube.PlaylistItems.list('id,contentDetails', {
        playlistId: playlistId,
        maxResults: 50,
        pageToken: nextPageToken,
        fields: 'nextPageToken,items(id,contentDetails(videoId,videoPublishedAt))'
      });
      if (!results || !results.items) {
        recordRowWarning("maintenance", "Target playlist returned an invalid response while preparing deletion: " + playlistId);
        return;
      }
      [].push.apply(allItems, results.items);
      nextPageToken = results.nextPageToken || null;
    } catch (e) {
      recordRowWarning("maintenance", "Cannot read target playlist " + playlistId + " before deletion: " + describeError(e));
      return;
    }
  } while (nextPageToken !== null);

  var deleteBefore = new Date(deleteBeforeTimestamp);
  var seenVideoIds = {};
  var itemIdsToDelete = [];
  allItems.forEach(function(item) {
    var details = item && item.contentDetails;
    var videoId = details && details.videoId;
    var publishedAt = details && details.videoPublishedAt;
    var isOld = publishedAt && new Date(publishedAt) < deleteBefore;

    if (isOld) {
      itemIdsToDelete.push(item.id);
    } else if (videoId && seenVideoIds[videoId]) {
      itemIdsToDelete.push(item.id);
    } else if (videoId) {
      seenVideoIds[videoId] = true;
    }
  });

  itemIdsToDelete = itemIdsToDelete.filter(function(itemId, index, ids) {
    return itemId && ids.indexOf(itemId) === index;
  });
  if (!itemIdsToDelete.length) return;

  var remainingOperations = maxPlaylistWriteOperationsPerRun - playlistWriteOperationsUsed;
  if (itemIdsToDelete.length > remainingOperations) {
    recordRowWarning(
      "maintenance",
      "Refusing a partial deletion: " + itemIdsToDelete.length + " playlist items need removal, but only " +
      Math.max(0, remainingOperations) + " of the per-run safety budget remain. Nothing was deleted."
    );
    return;
  }

  var removedCount = 0;
  for (var i = 0; i < itemIdsToDelete.length; i++) {
    playlistWriteOperationsUsed += 1;
    try {
      YouTube.PlaylistItems.remove(itemIdsToDelete[i]);
      removedCount += 1;
    } catch (e) {
      recordRowWarning("maintenance", "Could not remove playlist item " + itemIdsToDelete[i] + " from " + playlistId + ": " + describeError(e));
    }
  }
  delete targetPlaylistVideoCache[playlistId];
  Logger.log("Removed " + removedCount + " old or duplicate playlist item(s).");
}

//
// Functions for filtering videos
//

function applyFilters(videoIds, sheet, iRow) {
  var shortsSetting = normalizeCellValue(
    sheet.getRange(iRow + 1, reservedColumnShortsFilter + 1).getValue()
  ).toLowerCase();
  var filterShorts = shortsSetting == "no";
  var livestreamFilterMode = getLivestreamFilterMode(sheet, iRow);
  var filterLivestreams = livestreamFilterMode != "off";
  if (!filterShorts && !filterLivestreams) return videoIds;

  if (filterShorts) Logger.log("Removing shorts");
  if (filterLivestreams) {
    Logger.log("Livestream filter mode: " + livestreamFilterMode.toUpperCase());
    if (livestreamFilterMode == "strict") {
      Logger.log("Removing active and completed live-like videos; preserving upcoming items");
    } else {
      Logger.log("Removing active livestreams and live-like videos over 2 hours");
    }
  }

  var filteredVideoIds = [];
  for (var start = 0; start < videoIds.length; start += 50) {
    var batch = videoIds.slice(start, start + 50);
    try {
      // videos.list accepts up to 50 comma-separated IDs, so both filters share
      // one metadata request instead of making one or two requests per video.
      var part = filterLivestreams ? 'snippet,contentDetails,liveStreamingDetails' : 'contentDetails';
      var response = YouTube.Videos.list(part, {id: batch.join(',')});
      if (!response || !response.items) {
        recordRowError("filter", "Video metadata returned an invalid response for a batch of " + batch.length + " videos");
        continue;
      }

      var itemsById = {};
      response.items.forEach(function(item) {
        if (item && item.id) itemsById[item.id] = item;
      });

      batch.forEach(function(videoId) {
        var item = itemsById[videoId];
        if (!item) {
          // Private/deleted videos are commonly omitted from videos.list. They
          // cannot be inserted, but should not keep a row retrying forever.
          Logger.log("Skipped unavailable/private video during filtering: " + videoId);
          return;
        }

        var keep = true;
        var duration = item.contentDetails && item.contentDetails.duration;
        if (filterShorts && !duration) {
          Logger.log("Skipped video with missing duration metadata: " + videoId);
          keep = false;
        } else if (filterShorts && isLessThanThreeMinutes(duration)) {
          Logger.log("Filtered short: " + videoId + " | duration: " + duration);
          keep = false;
        }
        if (keep && filterLivestreams) {
          keep = passesLiveLikeFilter(videoId, item, livestreamFilterMode);
        }
        if (keep) filteredVideoIds.push(videoId);
      });
    } catch (e) {
      recordRowError(
        "filter",
        "Cannot retrieve metadata for video batch starting with " + batch[0] + ": " + describeError(e)
      );
      // Keep processing later batches; the failed batch will be retried because
      // its row timestamp is withheld.
    }
  }

  return filteredVideoIds;
}

// Column F accepts Strict/No/All, Long/Legacy/2h, or Off/Yes/Keep.
// Blank cells use defaultLivestreamFilterMode so an older sheet that lacks the
// newer column cannot silently disable livestream filtering.
function getLivestreamFilterMode(sheet, iRow) {
  var rawSetting = normalizeCellValue(
    sheet.getRange(iRow + 1, reservedColumnLongVideosFilter + 1).getValue()
  );
  var parsedMode = parseLivestreamFilterMode(rawSetting);
  if (parsedMode) return parsedMode;

  var fallbackMode = parseLivestreamFilterMode(defaultLivestreamFilterMode) || "strict";
  if (rawSetting) {
    recordRowWarning(
      "filter",
      "Unknown livestream filter setting '" + rawSetting + "' in column F; using " + fallbackMode.toUpperCase()
    );
  }
  return fallbackMode;
}

function parseLivestreamFilterMode(value) {
  var setting = normalizeCellValue(value).toLowerCase();
  if (!setting) return null;

  if (setting == "strict" || setting == "no" || setting == "all" ||
      setting == "all live" || setting == "all livestreams" || setting == "no livestreams") {
    return "strict";
  }
  if (setting == "long" || setting == "legacy" || setting == "2h" ||
      setting == "over 2h" || setting == "over 2 hours") {
    return "long";
  }
  if (setting == "off" || setting == "yes" || setting == "keep" ||
      setting == "none" || setting == "disabled") {
    return "off";
  }
  return null;
}

// Checks if an ISO 8601 duration is less or equal than three minutes.
// Verifying the duration is of the form PT1M or PTXXX.XXXS where X represents digits.

function isLessThanThreeMinutes(duration) {
  // Check if duration is 3 minutes
  // Since there can be a 1 second variation, we check for 3 minutes + 1 second, too, due to following bug
  // https://stackoverflow.com/questions/72459082/yt-api-pulling-different-video-lengths-for-youtube-videos
  if (duration == "PT3M" || duration == "PT3M1S") return true;
  if (duration.slice(0,2) != "PT") return false;
  // match one or two groups of this, so e.g. "2M", "59S" or "2M5S"
  return duration.match("^PT([12]M|[1-5]?[0-9]S){1,2}$") != null;
}

// Applies the selected policy to videos that the public API marks as live-like.
// The API does not expose a reliable discriminator between a completed stream
// and a completed Premiere, so Strict and Long intentionally represent two
// different policy tradeoffs rather than pretending that distinction exists.
function passesLiveLikeFilter(videoId, item, livestreamFilterMode) {
  if (!isLiveLikeVideo(item)) return true;
  livestreamFilterMode = parseLivestreamFilterMode(livestreamFilterMode) ||
    parseLivestreamFilterMode(defaultLivestreamFilterMode) || "strict";

  var liveBroadcastContent = item.snippet && item.snippet.liveBroadcastContent;
  if (liveBroadcastContent == "upcoming") {
    Logger.log("Kept upcoming live-like video to preserve possible Premiere: " + videoId);
    return true;
  }

  if (liveBroadcastContent == "live") {
    Logger.log("Filtered active livestream: " + videoId);
    return false;
  }

  var duration = item.contentDetails && item.contentDetails.duration;
  if (livestreamFilterMode == "strict") {
    Logger.log(
      "Filtered completed live-like video in STRICT mode: " + videoId +
      (duration ? " | duration: " + duration : "")
    );
    return false;
  }

  if (duration && isOverTwoHours(duration)) {
    Logger.log("Filtered live-like video over 2 hours: " + videoId + " | duration: " + duration);
    return false;
  }

  var liveWindowSeconds = getLiveWindowSeconds(item.liveStreamingDetails, liveBroadcastContent);
  if (liveWindowSeconds !== null && liveWindowSeconds > 2 * 60 * 60) {
    Logger.log("Filtered live-like video with a live window over 2 hours: " + videoId + " | live window seconds: " + liveWindowSeconds);
    return false;
  }

  Logger.log(
    "Kept completed live-like video under the two-hour LONG threshold: " + videoId +
    (duration ? " | duration: " + duration : "")
  );
  return true;
}

// liveBroadcastContent only identifies upcoming/active state. Once a broadcast
// completes it becomes "none", while liveStreamingDetails remains present.
function isLiveLikeVideo(item) {
  var liveBroadcastContent = item.snippet && item.snippet.liveBroadcastContent;
  return !!item.liveStreamingDetails || liveBroadcastContent == "live" || liveBroadcastContent == "upcoming";
}

// For active livestreams, Youtube may not have a useful final duration yet.
// Use actualStartTime -> actualEndTime when finished, or actualStartTime -> now when live.
function getLiveWindowSeconds(liveStreamingDetails, liveBroadcastContent) {
  if (!liveStreamingDetails || !liveStreamingDetails.actualStartTime) return null;

  var start = new Date(liveStreamingDetails.actualStartTime);
  if (isNaN(start.getTime())) return null;

  var end = null;
  if (liveStreamingDetails.actualEndTime) {
    end = new Date(liveStreamingDetails.actualEndTime);
  } else if (liveBroadcastContent == "live") {
    end = new Date();
  }

  if (!end || isNaN(end.getTime())) return null;

  var seconds = Math.floor((end.getTime() - start.getTime()) / 1000);
  return seconds >= 0 ? seconds : null;
}

// Checks if an ISO 8601 duration is strictly longer than two hours.
// Exactly 2:00:00 is allowed. Change > to >= if you also want to block exactly two-hour videos.
function isOverTwoHours(duration) {
  var seconds = isoDurationToSeconds(duration);
  return seconds !== null && seconds > 2 * 60 * 60;
}

// Converts Youtube ISO 8601 durations like PT1H23M45S, PT3M, PT2H, or P0D into seconds.
function isoDurationToSeconds(duration) {
  var match = String(duration).match(/^P(?:(\d+)D)?T?(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/);
  if (!match) return null;
  var days = Number(match[1] || 0);
  var hours = Number(match[2] || 0);
  var minutes = Number(match[3] || 0);
  var seconds = Number(match[4] || 0);
  return (((days * 24 + hours) * 60 + minutes) * 60 + seconds);
}

//
// Functions for maintaining debug logs
//

// Parse debug sheet to find column of cell to write debug logs to
function getNextDebugCol(debugSheet) {
  var data = debugSheet.getDataRange().getValues();
  // Only one column, not filled yet, return this column
  if (data.length < reservedDebugNumRows) return 0;
  // Need to iterate since next col might be in middle of data
  for (var col = 0; col < reservedDebugNumColumns; col += 2) {
    // New column
    // Necessary check since data is list of lists and col might be out of bounds
    if (data[0].length < col + 1) return col
    // Unfilled column
    if (data[reservedDebugNumRows - 1][col + 1] == "") return col;
  }
  clearDebugCol(debugSheet, 0)
  return 0;
}

// Parse debug sheet to find row of cell to write debug logs to
function getNextDebugRow(debugSheet, nextDebugCol) {
  var data = debugSheet.getDataRange().getValues();
  // Empty sheet, return first row
  if (data.length == 1 && data[0].length == 1 && data[0][0] == "") return 0;
  // Only one column, not filled yet, return last row + 1
  // Second check needed in case reservedDebugNumRows has expanded while other columns are filled
  if (data.length < reservedDebugNumRows && data[0][0] != "") return data.length;
  for (var row = 0; row < reservedDebugNumRows; row++) {
    // Found empty row
    if (data[row][nextDebugCol + 1] == "") return row;
  }
  return 0;
}

// Clear column in debug sheet for next execution's logs
function clearDebugCol(debugSheet, colIndex) {
  // Clear first reservedDebugNumRows rows
  debugSheet.getRange(1, colIndex + 1, reservedDebugNumRows, 2).clear();
  // Clear as many additional rows as necessary
  var rowIndex = reservedDebugNumRows;
  while (debugSheet.getRange(rowIndex + 1, colIndex + 1, 1, 2).getValues()[0][1] != "") {
    debugSheet.getRange(rowIndex + 1, colIndex + 1, 1, 2).clear();
    rowIndex += 1;
  }
}

// Add execution entry to debug viewer, shift previous executions and remove earliest if too many
function initDebugEntry(debugViewer, nextDebugCol, nextDebugRow) {
  // Clear currently viewing logs to get proper last row
  debugViewer.getRange("B3").clear();
  // Calculate number of existing executions
  var numExecutionsRecorded = debugViewer.getDataRange().getLastRow() - 2;
  var maxToCopy = debugViewer.getRange("B1").getValue() - 1
  var numToCopy = numExecutionsRecorded
  if (numToCopy > maxToCopy) {
    numToCopy = maxToCopy
  }
  // Shift existing executions
  debugViewer.getRange(4, 1, numToCopy, 1).setValues(debugViewer.getRange(3, 1, numToCopy, 1).getValues())
  if (numExecutionsRecorded - numToCopy > 0) {
    debugViewer.getRange(4+numToCopy, 1, numExecutionsRecorded - numToCopy, 1).clear()
  }
  // Copy new execution
  debugViewer.getRange(3, 1).setValue("=DebugData!"+debugViewer.getRange(nextDebugRow + 1, nextDebugCol + 1).getA1Notation())
}

// Set currently viewed execution logs to most recent execution
function loadLastDebugLog(debugViewer) {
  debugViewer.getRange("B3").setValue(debugViewer.getRange("A3").getValue());
}

// Given an execution's (first log's) timestamp, return an array with the execution's logs
// Returns "" or Error if can't find logs
function getLogs(timestamp) {
  if (timestamp == "") return "";
  var debugSheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName("DebugData");
  if (!debugSheet) throw Error("No debug logs");
  var data = debugSheet.getDataRange().getValues();
  var results = []
  for (var col = 0; col < data[0].length; col += 2) {
    for (var row = 0; row < data.length; row++) {
      if (data[row][col] == timestamp) {
        for (; row < data.length; row++) {
          if (data[row][col] == "") break;
          results.push([data[row][col + 1]]);
        }
        return results;
      }
    }
  }
  return ""
}

//
// Functions for Housekeeping
// Makes Web App, function call from Google Sheets, add errors, etc
//

// Log errors in debug sheet and throw an error
function addError(s) {
  recordRowError("unexpected", s);
}
// Function to Set Up Google Spreadsheet
function onOpen() {
  SpreadsheetApp.getActiveSpreadsheet().addMenu("Youtube Controls", [
    {name: "Update Playlists", functionName: "updatePlaylists"},
    {name: "Get Channel ID", functionName: "getChannelId"}
  ]);
  var ss = SpreadsheetApp.getActiveSpreadsheet()
  var sheet = ss.getSheets()[0]
  if (!sheet || sheet.getRange("A3").getValue() !== "Playlist ID") {
    var additional = sheet ? ", instead found sheet with name "+ sheet.getName() : ""
    throw new Error("Cannot find playlist sheet, make sure the sheet with playlist IDs and channels is the first sheet (leftmost)"+ additional)
  }
  PropertiesService.getScriptProperties().setProperty("sheetID", ss.getId())
}

// Function to publish Script as Web App
function doGet(e) {
    var sheetID = PropertiesService.getScriptProperties().getProperty("sheetID");
    if (e.parameter.update == "True") {
        var sheet = SpreadsheetApp.openById(sheetID).getSheets()[0];
        if (!sheet || sheet.getRange("A3").getValue() !== "Playlist ID") {
          var additional = sheet ? ", instead found sheet with name "+ sheet.getName() : ""
          throw new Error("Cannot find playlist sheet, make sure the sheet with playlist IDs and channels is the first sheet (leftmost)"+ additional)
        }
        updatePlaylists(sheet);
    };

    var t = HtmlService.createTemplateFromFile('index.html');
    t.data = e.parameter.pl
    t.sheetID = sheetID
    return t.evaluate();
}

// Function to select playlist for Web App
function playlist(pl, sheetID){
  var sheet = SpreadsheetApp.openById(sheetID).getSheets()[0];
  var data = sheet.getDataRange().getValues();
  if (pl == undefined){
    pl = reservedTableRows;
  } else {
    pl = Number(pl) + reservedTableRows - 1;  // I like to think of the first playlist as being number 1.
  }
  if (pl > sheet.getLastRow()){
    pl = sheet.getLastRow();
  }
  var playlistId = data[pl][reservedColumnPlaylist];
  return playlistId
}
