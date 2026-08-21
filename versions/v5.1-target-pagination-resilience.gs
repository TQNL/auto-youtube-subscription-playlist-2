// Strict-ingestion experiment v5.1: 2026-08-21
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

// Strict policy: duration is never used to identify livestreams. A video is
// admitted only when videos.list proves liveBroadcastContent == "none" and
// liveStreamingDetails is absent. This intentionally rejects Premieres when
// YouTube exposes them as broadcast-like; the public API has no reliable
// completed-Premiere discriminator.

// Per-execution and per-row state. Source, filter, write, and maintenance
// failures are tracked separately so one broken source cannot cancel videos
// obtained from healthy sources.
var totalErrorCount = 0;
var totalWarningCount = 0;
var currentRowStatus = null;
var targetPlaylistVideoCache = {};
var experimentDryRun = false;
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
var reservedColumnLegacyLivestreamSetting = 5; // Reserved for sheet compatibility; strict policy ignores column F
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
          ", policy=" + currentRowStatus.policyErrors +
          ", write=" + currentRowStatus.writeErrors +
          ", maintenance=" + currentRowStatus.maintenanceErrors +
          ", unexpected=" + currentRowStatus.unexpectedErrors +
          "). Timestamp was not updated."
        );
      } else if (currentRowStatus.warningCount > 0) {
        Logger.log(
          "Row completed with non-blocking warnings (source=" + currentRowStatus.sourceWarnings +
          ", filter=" + currentRowStatus.filterWarnings +
          ", policy=" + currentRowStatus.policyWarnings +
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
  if (experimentDryRun) {
    Logger.log("[STRICT DRY RUN] Would submit " + newVideoIds.length + " strictly eligible video(s) for target de-duplication and insertion");
  } else if (!debugFlag_dontUpdatePlaylists) {
    addVideosToPlaylist(playlistId, newVideoIds);
  } else {
    recordRowError("write", "Don't Update Playlists debug flag is set");
  }

  var daysBack = data[iRow][reservedColumnDeleteDays];
  if (!experimentDryRun && daysBack && daysBack > 0) {
    var deleteBeforeTimestamp = new Date((new Date()).getTime() - daysBack * MILLIS_PER_DAY).toIsoString();
    Logger.log("Delete before: " + deleteBeforeTimestamp);
    deletePlaylistItems(playlistId, deleteBeforeTimestamp);
  }

  if (experimentDryRun) {
    Logger.log("[STRICT DRY RUN] Timestamp and playlist were not modified");
  } else if (currentRowStatus.errorCount === 0 && !debugFlag_dontUpdateTimestamp) {
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
    policyErrors: 0,
    policyWarnings: 0,
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
// waste insert quota on videos that are already present. A failure on the first
// page means the target itself cannot be verified and is blocking. A later-page
// failure leaves a useful partial inventory: addVideosToPlaylist() then verifies
// every unresolved candidate with playlistItems.list's documented videoId filter.
// This is necessary because ordinary YouTube playlists allow duplicate videos;
// playlistItems.insert cannot be used as an idempotency check.
function getTargetPlaylistVideoInventory(playlistId) {
  if (targetPlaylistVideoCache[playlistId]) {
    var cached = targetPlaylistVideoCache[playlistId];
    // Accept the direct video-set shape used by older in-memory callers while
    // an execution is being upgraded; it represents a complete known set.
    if (!cached.videoSet) {
      return {videoSet: cached, complete: true, pagesRead: null};
    }
    return cached;
  }

  var inventory = {
    videoSet: {},
    complete: false,
    pagesRead: 0
  };
  var nextPageToken = null;
  var seenPageTokens = {};

  do {
    try {
      var options = {
        playlistId: playlistId,
        maxResults: 50,
        fields: 'nextPageToken,items(contentDetails(videoId))'
      };
      // The documented initial request has no pageToken. Subsequent requests
      // use the opaque token returned by the immediately preceding page.
      if (nextPageToken) options.pageToken = nextPageToken;

      var results = YouTube.PlaylistItems.list('contentDetails', options);
      if (!results || !results.items) {
        if (inventory.pagesRead === 0) {
          recordRowError("write", "Target playlist returned an invalid first-page response for playlist " + playlistId);
          return null;
        }
        recordRowWarning(
          "write",
          "Target playlist pagination became invalid after " + inventory.pagesRead +
          " page(s); unresolved candidates will be checked individually"
        );
        targetPlaylistVideoCache[playlistId] = inventory;
        return inventory;
      }

      inventory.pagesRead += 1;
      results.items.forEach(function(item) {
        var videoId = item && item.contentDetails && item.contentDetails.videoId;
        if (videoId) inventory.videoSet[videoId] = true;
      });

      var returnedToken = results.nextPageToken || null;
      if (returnedToken && seenPageTokens[returnedToken]) {
        recordRowWarning(
          "write",
          "Target playlist returned a repeated page token after " + inventory.pagesRead +
          " page(s); unresolved candidates will be checked individually"
        );
        targetPlaylistVideoCache[playlistId] = inventory;
        return inventory;
      }
      if (returnedToken) seenPageTokens[returnedToken] = true;
      nextPageToken = returnedToken;
    } catch (e) {
      if (inventory.pagesRead === 0) {
        recordRowError("write", "Cannot read the first page of target playlist " + playlistId + " before insertion: " + describeError(e));
        return null;
      }
      recordRowWarning(
        "write",
        "Cannot finish reading target playlist " + playlistId + " after " + inventory.pagesRead +
        " page(s): " + describeError(e) + ". Unresolved candidates will be checked individually"
      );
      targetPlaylistVideoCache[playlistId] = inventory;
      return inventory;
    }
  } while (nextPageToken !== null);

  inventory.complete = true;
  targetPlaylistVideoCache[playlistId] = inventory;
  return inventory;
}

// Resolve membership without relying on a complete target scan. playlistItems
// supports playlistId + videoId, which remains precise even when a deep page
// token fails. A failed membership probe withholds only that candidate and keeps
// the row checkpoint so it can be retried.
function getTargetPendingVideoIds(playlistId, videoIds, inventory) {
  var pendingVideoIds = [];
  var alreadyPresentCount = 0;

  videoIds.forEach(function(videoId) {
    if (inventory.videoSet[videoId]) {
      alreadyPresentCount += 1;
      return;
    }

    if (!inventory.complete) {
      try {
        var membership = YouTube.PlaylistItems.list('id', {
          playlistId: playlistId,
          videoId: videoId,
          maxResults: 1,
          fields: 'items(id)'
        });
        if (!membership || !membership.items) {
          recordRowError(
            "write",
            "Target membership check returned an invalid response for video " + videoId + "; withholding it for retry"
          );
          return;
        }
        if (membership.items.length > 0) {
          inventory.videoSet[videoId] = true;
          alreadyPresentCount += 1;
          return;
        }
      } catch (e) {
        recordRowError(
          "write",
          "Cannot verify whether video " + videoId + " is already in target playlist " +
          playlistId + "; withholding it for retry: " + describeError(e)
        );
        return;
      }
    }

    pendingVideoIds.push(videoId);
  });

  return {
    pendingVideoIds: pendingVideoIds,
    alreadyPresentCount: alreadyPresentCount
  };
}

// Non-mutating v5 audit. This deliberately does not repair the target yet: the
// live experiment must first establish how many existing entries strict policy
// would classify as broadcasts (including the Premiere tradeoff).
function inspectTargetPlaylistStrict(playlistId) {
  var playlistItems = [];
  var nextPageToken = '';
  do {
    try {
      var page = YouTube.PlaylistItems.list('id,contentDetails', {
        playlistId: playlistId,
        maxResults: 50,
        pageToken: nextPageToken,
        fields: 'nextPageToken,items(id,contentDetails(videoId))'
      });
      if (!page || !page.items) {
        recordRowError("policy", "Strict target audit received an invalid playlist response");
        return null;
      }
      [].push.apply(playlistItems, page.items);
      nextPageToken = page.nextPageToken || null;
    } catch (e) {
      recordRowError("policy", "Cannot read target playlist during strict audit: " + describeError(e));
      return null;
    }
  } while (nextPageToken !== null);

  var videoIds = dedupeVideoIds(playlistItems.map(function(item) {
    return item && item.contentDetails && item.contentDetails.videoId;
  }));
  var counts = {
    NORMAL_UPLOAD: 0,
    UPCOMING: 0,
    ACTIVE: 0,
    COMPLETED_LIVE: 0,
    UNKNOWN: 0
  };

  for (var start = 0; start < videoIds.length; start += 50) {
    var batch = videoIds.slice(start, start + 50);
    try {
      var response = YouTube.Videos.list('snippet,contentDetails,liveStreamingDetails', {id: batch.join(',')});
      if (!response || !response.items) {
        recordRowError("policy", "Strict target audit received invalid metadata for batch starting with " + batch[0]);
        counts.UNKNOWN += batch.length;
        continue;
      }

      var itemsById = {};
      response.items.forEach(function(item) {
        if (item && item.id) itemsById[item.id] = item;
      });
      batch.forEach(function(videoId) {
        var item = itemsById[videoId];
        var classification = item ? classifyVideoStrict(item) : "UNKNOWN";
        counts[classification] += 1;
        if (classification != "NORMAL_UPLOAD") {
          Logger.log("[STRICT TARGET AUDIT] " + classification + ": " + formatVideoEvidence(videoId, item));
        }
      });
    } catch (e) {
      recordRowError("policy", "Strict target metadata audit failed for batch starting with " + batch[0] + ": " + describeError(e));
      counts.UNKNOWN += batch.length;
    }
  }

  var report = {
    playlistItemCount: playlistItems.length,
    uniqueVideoCount: videoIds.length,
    classifications: counts,
    forbiddenCount: counts.UPCOMING + counts.ACTIVE + counts.COMPLETED_LIVE,
    unknownCount: counts.UNKNOWN,
    mutationPerformed: false
  };
  Logger.log("STRICT_TARGET_AUDIT_RESULT " + JSON.stringify(report));
  return report;
}

// Re-check candidates immediately before insertion. The acquisition/filter pass
// can be seconds earlier, so this closes the observable state-change window and
// fails closed if metadata cannot be proven safe.
function revalidateStrictCandidates(videoIds, context) {
  var allowedVideoIds = [];
  for (var start = 0; start < videoIds.length; start += 50) {
    var batch = videoIds.slice(start, start + 50);
    try {
      var response = YouTube.Videos.list('snippet,contentDetails,liveStreamingDetails', {id: batch.join(',')});
      if (!response || !response.items) {
        recordRowError("policy", "Invalid metadata response while " + context + " for " + batch.length + " video(s)");
        continue;
      }

      var itemsById = {};
      response.items.forEach(function(item) {
        if (item && item.id) itemsById[item.id] = item;
      });

      batch.forEach(function(videoId) {
        var item = itemsById[videoId];
        if (!item) {
          recordRowError("policy", "Video " + videoId + " was omitted while " + context + "; withholding it for retry");
          return;
        }

        var classification = classifyVideoStrict(item);
        if (classification == "NORMAL_UPLOAD") {
          allowedVideoIds.push(videoId);
        } else if (classification == "UNKNOWN") {
          recordRowError("policy", "Cannot prove video " + videoId + " is a normal upload while " + context + "; withholding it");
        } else {
          Logger.log("Strict policy rejected " + classification + " during " + context + ": " + formatVideoEvidence(videoId, item));
        }
      });
    } catch (e) {
      recordRowError("policy", "Cannot retrieve metadata while " + context + " for batch starting with " + batch[0] + ": " + describeError(e));
    }
  }
  return allowedVideoIds;
}

function rollbackInsertedPlaylistItem(record, existingVideos, reason) {
  if (!record || !record.playlistItemId) {
    recordRowError("policy", "Cannot roll back inserted video " + (record && record.videoId ? record.videoId : "unknown") + " because the insert response had no playlist-item ID");
    return false;
  }
  if (playlistWriteOperationsUsed >= maxPlaylistWriteOperationsPerRun) {
    recordRowError("policy", "Cannot roll back inserted video " + record.videoId + " because the write safety budget is exhausted");
    return false;
  }

  playlistWriteOperationsUsed += 1;
  try {
    YouTube.PlaylistItems.remove(record.playlistItemId);
    delete existingVideos[record.videoId];
    Logger.log("Rolled back inserted video " + record.videoId + ": " + reason);
    return true;
  } catch (e) {
    recordRowError("policy", "Failed to roll back inserted video " + record.videoId + ": " + describeError(e));
    return false;
  }
}

// Re-check successful inserts and use the playlist-item ID returned by insert
// for rollback. One potential rollback operation is reserved for each attempted
// insert before mutation begins.
function postValidateInsertedItems(records, existingVideos) {
  for (var start = 0; start < records.length; start += 50) {
    var batchRecords = records.slice(start, start + 50);
    var batchIds = batchRecords.map(function(record) { return record.videoId; });
    var response = null;
    try {
      response = YouTube.Videos.list('snippet,contentDetails,liveStreamingDetails', {id: batchIds.join(',')});
    } catch (e) {
      recordRowError("policy", "Post-insert metadata check failed for batch starting with " + batchIds[0] + ": " + describeError(e));
      batchRecords.forEach(function(record) {
        rollbackInsertedPlaylistItem(record, existingVideos, "post-insert metadata could not be verified");
      });
      continue;
    }

    if (!response || !response.items) {
      recordRowError("policy", "Post-insert metadata returned an invalid response for " + batchRecords.length + " video(s)");
      batchRecords.forEach(function(record) {
        rollbackInsertedPlaylistItem(record, existingVideos, "post-insert metadata response was invalid");
      });
      continue;
    }

    var itemsById = {};
    response.items.forEach(function(item) {
      if (item && item.id) itemsById[item.id] = item;
    });

    batchRecords.forEach(function(record) {
      var item = itemsById[record.videoId];
      var classification = item ? classifyVideoStrict(item) : "UNKNOWN";
      if (classification == "NORMAL_UPLOAD") return;

      var reason = item ? "post-insert classification changed to " + classification : "video was omitted by post-insert metadata";
      if (classification == "UNKNOWN") {
        recordRowError("policy", "Post-insert state for video " + record.videoId + " is unverifiable");
      } else {
        recordRowWarning("policy", "Post-insert state for video " + record.videoId + " is " + classification + "; rolling it back");
      }
      rollbackInsertedPlaylistItem(record, existingVideos, reason);
    });
  }
}

// Add videos using an execution-wide mutation budget. At most half of the
// remaining operations are used for insert attempts so every success retains a
// reserved rollback operation. Oversized rows make bounded progress and retain
// their checkpoint; retries de-duplicate the already completed insertions.
function addVideosToPlaylist(playlistId, videoIds) {
  if (!videoIds.length) {
    Logger.log("No new videos yet.");
    return;
  }

  var targetInventory = getTargetPlaylistVideoInventory(playlistId);
  if (targetInventory === null) return;

  var membershipResult = getTargetPendingVideoIds(playlistId, videoIds, targetInventory);
  var existingVideos = targetInventory.videoSet;
  var pendingVideoIds = membershipResult.pendingVideoIds;
  var alreadyPresentCount = membershipResult.alreadyPresentCount;
  if (alreadyPresentCount > 0) {
    Logger.log("Skipped " + alreadyPresentCount + " video(s) already present in the target playlist.");
  }
  if (!pendingVideoIds.length) {
    Logger.log("No new videos to insert after target-playlist de-duplication.");
    return;
  }

  pendingVideoIds = revalidateStrictCandidates(pendingVideoIds, "pre-insert strict revalidation");
  if (!pendingVideoIds.length) {
    Logger.log("No strictly eligible videos remain after pre-insert revalidation.");
    return;
  }

  var remainingOperations = maxPlaylistWriteOperationsPerRun - playlistWriteOperationsUsed;
  var safeInsertCapacity = Math.floor(Math.max(0, remainingOperations) / 2);
  if (safeInsertCapacity == 0) {
    recordRowError(
      "write",
      "No safe insert capacity remains after reserving rollback operations; " + pendingVideoIds.length + " video(s) deferred"
    );
    return;
  }
  if (pendingVideoIds.length > safeInsertCapacity) {
    recordRowError(
      "write",
      "Write safety capacity permits " + safeInsertCapacity + " of " + pendingVideoIds.length +
      " strictly eligible video(s); inserting that bounded subset and retaining the checkpoint for retry"
    );
    pendingVideoIds = pendingVideoIds.slice(0, safeInsertCapacity);
  }

  var successCount = 0;
  var skippedCount = 0;
  var errorCount = 0;
  var insertedRecords = [];
  for (var i = 0; i < pendingVideoIds.length; i++) {
    var videoId = pendingVideoIds[i];
    playlistWriteOperationsUsed += 1;
    try {
      var insertedResource = YouTube.PlaylistItems.insert({
        snippet: {
          playlistId: playlistId,
          resourceId: {videoId: videoId, kind: 'youtube#video'}
        }
      }, 'snippet');
      existingVideos[videoId] = true;
      insertedRecords.push({
        videoId: videoId,
        playlistItemId: insertedResource && insertedResource.id ? insertedResource.id : null
      });
      successCount += 1;
    } catch (e) {
      var reason = getErrorReason(e);
      if (reason === "videoAlreadyInPlaylist") {
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

  if (insertedRecords.length > 0) postValidateInsertedItems(insertedRecords, existingVideos);
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
  if (!videoIds || videoIds.length == 0) return videoIds || [];

  var shortsSetting = normalizeCellValue(
    sheet.getRange(iRow + 1, reservedColumnShortsFilter + 1).getValue()
  ).toLowerCase();
  var filterShorts = shortsSetting == "no";

  if (filterShorts) Logger.log("Removing shorts");
  Logger.log("Strict livestream policy: rejecting upcoming, active, and completed broadcast-like videos; column F is ignored");

  var filteredVideoIds = [];
  for (var start = 0; start < videoIds.length; start += 50) {
    var batch = videoIds.slice(start, start + 50);
    try {
      // videos.list accepts up to 50 comma-separated IDs, so both filters share
      // one metadata request instead of making one or two requests per video.
      var response = YouTube.Videos.list('snippet,contentDetails,liveStreamingDetails', {id: batch.join(',')});
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
          recordRowError("filter", "Video " + videoId + " was omitted from a successful metadata response; withholding it for retry");
          return;
        }

        var classification = classifyVideoStrict(item);
        if (classification == "UNKNOWN") {
          recordRowError("filter", "Cannot prove video is a normal upload: " + formatVideoEvidence(videoId, item));
          return;
        }
        if (classification != "NORMAL_UPLOAD") {
          Logger.log("Strict policy rejected " + classification + ": " + formatVideoEvidence(videoId, item));
          return;
        }

        var duration = item.contentDetails && item.contentDetails.duration;
        if (filterShorts && !duration) {
          recordRowError("filter", "Video " + videoId + " has no duration metadata; withholding it for retry");
          return;
        } else if (filterShorts && isLessThanThreeMinutes(duration)) {
          Logger.log("Filtered short: " + videoId + " | duration: " + duration);
          return;
        }
        filteredVideoIds.push(videoId);
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

// Classify only from documented API fields. Duration and title are deliberately
// excluded: they are not livestream type signals.
function classifyVideoStrict(item) {
  if (!item || !item.snippet) return "UNKNOWN";

  var liveBroadcastContent = normalizeCellValue(item.snippet.liveBroadcastContent).toLowerCase();
  if (liveBroadcastContent == "upcoming") return "UPCOMING";
  if (liveBroadcastContent == "live") return "ACTIVE";
  if (liveBroadcastContent != "none") return "UNKNOWN";

  if (item.liveStreamingDetails !== undefined && item.liveStreamingDetails !== null) {
    return "COMPLETED_LIVE";
  }
  return "NORMAL_UPLOAD";
}

function formatVideoEvidence(videoId, item) {
  var title = item && item.snippet && item.snippet.title ? item.snippet.title : "";
  var state = item && item.snippet ? normalizeCellValue(item.snippet.liveBroadcastContent) : "missing";
  var duration = item && item.contentDetails ? normalizeCellValue(item.contentDetails.duration) : "";
  var hasLiveDetails = !!(item && item.liveStreamingDetails !== undefined && item.liveStreamingDetails !== null);
  return videoId +
    (title ? " | title: " + title : "") +
    " | liveBroadcastContent: " + (state || "missing") +
    " | liveStreamingDetails: " + (hasLiveDetails ? "present" : "absent") +
    (duration ? " | duration: " + duration : "");
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
