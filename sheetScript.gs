// Strict broadcast rejection v5.5: 2026-08-25
// Source/read, filter, insertion, and maintenance failures are isolated per row.
// First-page permanently missing sources and independent cleanup failures are non-blocking warnings.
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
var targetMembershipProbesUsed = 0;
var targetMembershipQuotaFailure = null;

// Strict policy: every item carrying a documented YouTube broadcast marker is
// rejected, including completed broadcasts and Premieres. Duration is never a
// broadcast discriminator, so ordinary long uploads remain eligible. Column F
// remains reserved/ignored.

// Per-execution and per-row state. Source, filter, write, and maintenance
// failures are tracked separately so one broken source cannot cancel videos
// obtained from healthy sources.
var totalErrorCount = 0;
var totalWarningCount = 0;
var currentRowStatus = null;
var currentRowLogBuffer = [];
var currentRowLoggerStreamUnreliable = false;
var targetPlaylistVideoCache = Object.create(null);
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
var reservedColumnLegacyLivestreamSetting = 5; // Reserved for sheet compatibility; the hardcoded experiment ignores column F
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
    targetMembershipProbesUsed = 0;
    targetMembershipQuotaFailure = null;
    currentRowLogBuffer = [];
    currentRowLoggerStreamUnreliable = false;
    targetPlaylistVideoCache = Object.create(null);
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
  var debugPersistenceWarnings = [];
  var bufferedRowDebugEvidence = [];
  var debugSheet = null;
  var nextDebugCol = 0;
  var nextDebugRow = 0;
  var debugViewerSheet = null;

  // DebugData is auxiliary observability, not part of playlist correctness.
  // Creation and scanning may fail because of sheet limits, permissions, or a
  // damaged log range; none of those failures may prevent configured rows from
  // being processed.
  try {
    debugSheet = spreadsheet.getSheetByName("DebugData");
    if (!debugSheet) debugSheet = spreadsheet.insertSheet("DebugData").hideSheet();
    nextDebugCol = getNextDebugCol(debugSheet);
    nextDebugRow = getNextDebugRow(debugSheet, nextDebugCol);
  } catch (debugSetupError) {
    var debugSetupWarning =
      "WARNING [DEBUG]: Could not initialize DebugData persistence; playlist rows will continue " +
      "and their logs will be retained in the execution log. " + describeError(debugSetupError);
    debugPersistenceWarnings.push(debugSetupWarning);
    safeLog(debugSetupWarning);
    debugSheet = null;
  }

  // Keep viewer initialization independent from DebugData persistence. A
  // broken or missing viewer must not disable a usable DebugData sheet.
  if (debugSheet) {
    try {
      debugViewerSheet = spreadsheet.getSheetByName("Debug");
      if (!debugViewerSheet) throw new Error("Cannot find Debug viewer sheet");
      initDebugEntry(debugViewerSheet, nextDebugCol, nextDebugRow);
    } catch (debugViewerSetupError) {
      var debugViewerWarning =
        "WARNING [DEBUG]: Could not initialize Debug viewer; DebugData persistence and playlist rows will continue. " +
        describeError(debugViewerSetupError);
      debugPersistenceWarnings.push(debugViewerWarning);
      safeLog(debugViewerWarning);
      debugViewerSheet = null;
    }
  }

  for (var iRow = reservedTableRows; iRow < sheet.getLastRow(); iRow++) {
    var playlistId = normalizeCellValue(data[iRow][reservedColumnPlaylist]);
    if (!playlistId) continue;

    currentRowLogBuffer = [];
    currentRowLoggerStreamUnreliable = false;
    clearLogBestEffort();
    safeLog("Row: " + (iRow + 1));
    currentRowStatus = createRowStatus();

    try {
      processPlaylistRow(sheet, data, iRow, playlistId);
    } catch (e) {
      recordRowError("unexpected", "Unexpected row failure: " + describeError(e));
    } finally {
      if (currentRowStatus.errorCount > 0) {
        safeLog(
          "Row completed with blocking failures (source=" + currentRowStatus.sourceErrors +
          ", filter=" + currentRowStatus.filterErrors +
          ", policy=" + currentRowStatus.policyErrors +
          ", write=" + currentRowStatus.writeErrors +
          ", maintenance=" + currentRowStatus.maintenanceErrors +
          ", unexpected=" + currentRowStatus.unexpectedErrors +
          "). Final checkpoint was not advanced." +
          (currentRowStatus.checkpointSeeded
            ? " A conservative initial checkpoint seed was saved for retry."
            : "")
        );
      } else if (currentRowStatus.warningCount > 0) {
        safeLog(
          "Row completed with non-blocking warnings (source=" + currentRowStatus.sourceWarnings +
          ", filter=" + currentRowStatus.filterWarnings +
          ", policy=" + currentRowStatus.policyWarnings +
          ", write=" + currentRowStatus.writeWarnings +
          ", maintenance=" + currentRowStatus.maintenanceWarnings +
          ", unexpected=" + currentRowStatus.unexpectedWarnings +
          "). Timestamp " + (currentRowStatus.timestampUpdated ? "was updated." : "was not updated.")
        );
      }

      // Row accounting must not depend on the auxiliary DebugData sheet. If
      // that write fails, later playlist rows and the aggregate result still
      // need to run with the exact counts produced by this row.
      totalErrorCount += currentRowStatus.errorCount;
      totalWarningCount += currentRowStatus.warningCount;

      var rawRowLog = "";
      try {
        try {
          rawRowLog = Logger.getLog();
        } catch (loggerReadError) {
          currentRowLoggerStreamUnreliable = true;
          var loggerReadWarning =
            "WARNING [DEBUG]: Could not read the Apps Script Logger stream for row " + (iRow + 1) +
            "; using complete in-memory row evidence instead. " + describeError(loggerReadError);
          debugPersistenceWarnings.push(loggerReadWarning);
          safeLog(loggerReadWarning);
        }
        if (currentRowLoggerStreamUnreliable || !rawRowLog) {
          rawRowLog = currentRowLogBuffer.join("\n");
        }
        if (!debugSheet) throw new Error("DebugData persistence is unavailable for this execution");
        var newLogs = formatLogsForDebugSheet(rawRowLog);
        if (newLogs.length > 0) {
          debugSheet.getRange(nextDebugRow + 1, nextDebugCol + 1, newLogs.length, 2).setValues(newLogs);
        }
        nextDebugRow += newLogs.length;
      } catch (debugWriteError) {
        // Do not call recordRowWarning here: it writes to the same per-row log
        // stream whose persistence just failed and would also change row
        // accounting after that accounting has been finalized.
        var debugWarning =
          "WARNING [DEBUG]: Could not persist DebugData logs for row " + (iRow + 1) +
          "; continuing with later rows and unchanged row accounting. " + describeError(debugWriteError);
        debugPersistenceWarnings.push(debugWarning);
        bufferedRowDebugEvidence.push({rowNumber: iRow + 1, rawLog: rawRowLog});
        safeLog(debugWarning);
      } finally {
        currentRowStatus = null;
      }
    }
  }

  // Logger.clear() at the start of each row can remove an earlier persistence
  // warning from the execution log. Re-emit those warnings after the loop so
  // the best-effort failure remains visible even when DebugData is unavailable.
  debugPersistenceWarnings.forEach(function(debugWarning) {
    safeLog(debugWarning);
  });
  bufferedRowDebugEvidence.forEach(function(evidence) {
    emitBufferedRowDebugEvidence(evidence.rowNumber, evidence.rawLog);
  });

  // Execution-summary persistence is auxiliary too. A persistent DebugData
  // outage must not replace the row-error aggregate thrown below.
  try {
    if (!debugSheet) throw new Error("DebugData persistence is unavailable for this execution");
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

    if (debugViewerSheet) loadLastDebugLog(debugViewerSheet);
  } catch (debugSummaryError) {
    safeLog(
      "WARNING [DEBUG]: Could not finish DebugData execution-summary persistence; " +
      "the playlist aggregate result is unchanged. " + describeError(debugSummaryError)
    );
  }
  if (totalErrorCount > 0) {
    throw new Error(totalErrorCount + " error(s) occurred. Healthy sources were still processed; affected row final checkpoints were not advanced. Check the Debug sheet or execution log.");
  }
}

function processPlaylistRow(sheet, data, iRow, playlistId) {
  var MILLIS_PER_HOUR = 1000 * 60 * 60;
  var MILLIS_PER_DAY = MILLIS_PER_HOUR * 24;
  var lastTimestamp = data[iRow][reservedColumnTimestamp];
  var checkpointWasBlank = !lastTimestamp;

  if (checkpointWasBlank) {
    var date = new Date(Date.now() - MILLIS_PER_DAY);
    lastTimestamp = date.toIsoString();
    // A blank row is immediately eligible regardless of frequency. Normal
    // mutation mode first persists this conservative retry floor so a failed
    // first run cannot shift its 24-hour window forward on every retry. A pure
    // dry run keeps the seed in memory. Timestamp-suppressed mutation mode
    // cannot preserve a retry floor and therefore fails before any API call.
    if (!experimentDryRun && debugFlag_dontUpdateTimestamp) {
      recordRowError(
        "source",
        "Column B is blank while timestamp updates are disabled. Set a real checkpoint timestamp before using this debug mode; no source API or playlist mutation was attempted"
      );
      return;
    }
    if (!experimentDryRun) {
      sheet.getRange(iRow + 1, reservedColumnTimestamp + 1).setValue(lastTimestamp);
      currentRowStatus.checkpointSeeded = true;
    }
  }

  var freqDate = new Date(lastTimestamp);
  if (isNaN(freqDate.getTime())) {
    recordRowError("source", "Column B contains an invalid checkpoint timestamp; row was not read and the timestamp was retained");
    return;
  }
  var dateDiff = Date.now() - freqDate.getTime();
  var nextTime = data[iRow][reservedColumnFrequency] * MILLIS_PER_HOUR;
  if (!checkpointWasBlank && nextTime && dateDiff <= nextTime) {
    safeLog("Skipped: Not time yet");
    return;
  }

  // Freeze the successful checkpoint before the first source read. If a video
  // is published after its source was queried but before this row finishes, it
  // remains newer than this cutoff and is discovered on the next execution.
  // Source boundaries are inclusive and target de-duplication makes the small
  // overlap safe.
  var rowCutoffTimestamp = new Date().toIsoString();

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
        if (!user || !Array.isArray(user.items)) recordRowError("source", "Cannot query for user " + source);
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
      safeLog("Channel with id " + channelIds[channelIndex] + " has no new videos");
    }
    [].push.apply(newVideoIds, channelVideos);
  }

  for (var playlistIndex = 0; playlistIndex < playlistIds.length; playlistIndex++) {
    var playlistVideos = getPlaylistVideoIds(playlistIds[playlistIndex], lastTimestamp);
    if (debugFlag_logWhenNoNewVideosFound && playlistVideos.length === 0) {
      safeLog("Playlist with id " + playlistIds[playlistIndex] + " has no new videos");
    }
    [].push.apply(newVideoIds, playlistVideos);
  }

  newVideoIds = dedupeVideoIds(newVideoIds);
  safeLog("Acquired " + newVideoIds.length + " unique videos");
  newVideoIds = applyFilters(newVideoIds, sheet, iRow);
  safeLog("Filtering finished, left with " + newVideoIds.length + " videos");

  // Issues do not cancel candidates from healthy sources. Only failures that
  // could lose retryable candidates (transient source/filter/write/unexpected)
  // block the timestamp. Permanent bad-source and cleanup issues are warnings.
  if (experimentDryRun) {
    safeLog("[DRY RUN] Would submit " + newVideoIds.length + " admission-eligible video(s) for target de-duplication and insertion");
  } else if (!debugFlag_dontUpdatePlaylists) {
    addVideosToPlaylist(playlistId, newVideoIds);
  } else {
    recordRowError("write", "Don't Update Playlists debug flag is set");
  }

  var daysBack = data[iRow][reservedColumnDeleteDays];
  if (!experimentDryRun && daysBack && daysBack > 0) {
    var deleteBeforeTimestamp = new Date((new Date()).getTime() - daysBack * MILLIS_PER_DAY).toIsoString();
    safeLog("Delete before: " + deleteBeforeTimestamp);
    deletePlaylistItems(playlistId, deleteBeforeTimestamp);
  }

  if (experimentDryRun) {
    safeLog("[STRICT DRY RUN] Timestamp and playlist were not modified");
  } else if (currentRowStatus.errorCount === 0 && !debugFlag_dontUpdateTimestamp) {
    sheet.getRange(iRow + 1, reservedColumnTimestamp + 1).setValue(rowCutoffTimestamp);
    currentRowStatus.timestampUpdated = true;
  } else if (debugFlag_dontUpdateTimestamp) {
    safeLog("Timestamp update disabled by debug flag");
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
    timestampUpdated: false,
    checkpointSeeded: false
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
  // Correctness state is authoritative. Observability is best-effort and may
  // never prevent checkpoint retention or a mandatory rollback.
  if (currentRowStatus) {
    var suffix = blocksTimestamp ? "Errors" : "Warnings";
    var field = category + suffix;
    if (typeof currentRowStatus[field] !== "number") field = "unexpected" + suffix;
    currentRowStatus[field] += 1;
    if (blocksTimestamp) currentRowStatus.errorCount += 1;
    else currentRowStatus.warningCount += 1;
  }
  safeLog(severity + " [" + category.toUpperCase() + "]: " + message);
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

// Liveness policy: a permanently missing source playlist is skipped only when
// its first page cannot be read. This includes channel-derived uploads
// playlists, which YouTube can leave unmaterialized for channels without public
// uploads. A first-page 404 does not prove that a source is empty, so this is a
// deliberate tradeoff while the sheet has one row-wide checkpoint rather than a
// checkpoint per source. Once any page has succeeded, every subsequent failure
// means the source was read only partially.
// Keep acquired candidates, but retain the row checkpoint so unread pages are
// retried on the next execution. Non-missing first-page failures remain blocking.
function recordSourcePageReadFailure(context, e, pagesRead) {
  if (pagesRead === 0 && isMissingSourceConfigurationError(e)) {
    recordRowWarning(
      "source",
      context + ": " + describeError(e) + ". Source skipped; fix or remove its sheet entry."
    );
    return;
  }

  var progress = pagesRead > 0
    ? " after " + pagesRead + " completed page(s); partial candidates were kept and the checkpoint was retained"
    : " before its first page could be completed";
  recordRowError("source", context + progress + ": " + describeError(e));
}

function normalizeCellValue(value) {
  return value === null || value === undefined ? "" : String(value).trim();
}

function lookupSetHas(set, key) {
  return !!set && Object.prototype.hasOwnProperty.call(set, key) && set[key] === true;
}

function dedupeVideoIds(videoIds) {
  var seen = Object.create(null);
  return videoIds.filter(function(videoId) {
    if (!videoId || Object.prototype.hasOwnProperty.call(seen, videoId)) return false;
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

function isQuotaExhaustionError(e) {
  var reason = String(getErrorReason(e) || "").toLowerCase();
  var message = String(e && e.message ? e.message : e || "").toLowerCase();
  return reason === "quotaexceeded" ||
    reason === "dailylimitexceeded" ||
    reason === "userratelimitexceeded" ||
    reason === "ratelimitexceeded" ||
    (message.indexOf("quota") >= 0 && message.indexOf("exceed") >= 0);
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

function safeLog(message) {
  var bufferedMessage = "";
  try {
    bufferedMessage = String(message);
  } catch (ignoredStringFailure) {
    bufferedMessage = "[unprintable log message]";
  }
  currentRowLogBuffer.push(bufferedMessage);
  try {
    Logger.log(bufferedMessage);
    return true;
  } catch (ignored) {
    currentRowLoggerStreamUnreliable = true;
    return false;
  }
}

function clearLogBestEffort() {
  try {
    Logger.clear();
    return true;
  } catch (ignored) {
    currentRowLoggerStreamUnreliable = true;
    return false;
  }
}

// Re-emit raw row evidence when DebugData persistence fails. Apps Script can
// truncate oversized individual log entries, so split every source line into
// conservative chunks while retaining all substantive text and its row owner.
function emitBufferedRowDebugEvidence(rowNumber, rawLog) {
  var prefix = "DEBUG FALLBACK [row " + rowNumber + "]: ";
  var maxPayloadChars = 1800;
  var lines = String(rawLog || "").split(/\r?\n/);
  var emitted = false;

  lines.forEach(function(line) {
    if (!line) return;
    emitted = true;
    for (var offset = 0; offset < line.length; offset += maxPayloadChars) {
      safeLog(prefix + line.substring(offset, offset + maxPayloadChars));
    }
  });

  if (!emitted) safeLog(prefix + "[raw Logger log unavailable]");
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
  var nextPageToken = null;
  var seenPageTokens = Object.create(null);

  try {
    do {
      var options = {
        mine: true,
        maxResults: 50,
        order: 'alphabetical',
        fields: 'nextPageToken,items(snippet(resourceId(channelId)))'
      };
      if (nextPageToken) options.pageToken = nextPageToken;
      var response = YouTube.Subscriptions.list('snippet', options);

      if (!response || !Array.isArray(response.items)) {
        recordRowError("source", "YouTube subscriptions search returned an invalid response");
        return channelIds;
      }

      response.items.forEach(function(item) {
        var channelId = item && item.snippet && item.snippet.resourceId && item.snippet.resourceId.channelId;
        if (channelId) {
          channelIds.push(channelId);
        } else {
          recordRowError("source", "A subscriptions page contained an item without a channel ID; the checkpoint was retained");
        }
      });
      var returnedToken = response.nextPageToken || null;
      if (returnedToken && seenPageTokens[returnedToken]) {
        recordRowError("source", "YouTube subscriptions search returned a repeated page token");
        return channelIds;
      }
      if (returnedToken) seenPageTokens[returnedToken] = true;
      nextPageToken = returnedToken;
    } while (nextPageToken !== null);
  } catch (e) {
    recordRowError("source", "Could not get subscribed channels: " + describeError(e));
  }

  safeLog('Acquired subscriptions ' + channelIds.length);
  return channelIds;
}

function getVideoIds(channelId, lastTimestamp) {
  var videoIds = [];
  var nextPageToken = null;
  var seenPageTokens = Object.create(null);
  var pagesRead = 0;
  // search.list's publishedAfter boundary is exclusive. Back it up by one
  // second because row checkpoints are stored only to second precision; target
  // de-duplication makes this deliberate overlap safe.
  var inclusiveSearchBoundary = new Date(new Date(lastTimestamp).getTime() - 1000).toISOString();

  do {
    try {
      var options = {
        channelId: channelId,
        maxResults: 50,
        order: "date",
        publishedAfter: inclusiveSearchBoundary,
        type: "video"
      };
      if (nextPageToken) options.pageToken = nextPageToken;
      var results = YouTube.Search.list('id', options);
      if (!results || !Array.isArray(results.items)) {
        recordRowError("source", "YouTube video search returned an invalid response for channel " + channelId);
        return videoIds;
      }
    } catch (e) {
      recordSourcePageReadFailure("Cannot search YouTube with channel id " + channelId, e, pagesRead);
      return videoIds;
    }

    pagesRead += 1;
    results.items.forEach(function(item) {
      if (item && item.id && item.id.videoId) {
        videoIds.push(item.id.videoId);
      } else {
        recordRowError("source", "YouTube video search returned an item without a video ID for channel " + channelId);
      }
    });
    var returnedToken = results.nextPageToken || null;
    if (returnedToken && seenPageTokens[returnedToken]) {
      recordRowError(
        "source",
        "YouTube video search returned a repeated page token for channel " + channelId +
        " after " + pagesRead + " page(s); the checkpoint was retained"
      );
      return videoIds;
    }
    if (returnedToken) seenPageTokens[returnedToken] = true;
    nextPageToken = returnedToken;
  } while (nextPageToken !== null);

  if (videoIds.length === 0) {
    try {
      var channelResults = YouTube.Channels.list('id', {id: channelId});
      if (!channelResults || !Array.isArray(channelResults.items)) {
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
    if (!channelResults || !Array.isArray(channelResults.items)) {
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

  var nextPageToken = null;
  var seenPageTokens = Object.create(null);
  var pagesRead = 0;
  do {
    try {
      var options = {
        playlistId: uploadsPlaylistId,
        maxResults: 50,
        fields: 'nextPageToken,items(contentDetails(videoId,videoPublishedAt))'
      };
      if (nextPageToken) options.pageToken = nextPageToken;
      var results = YouTube.PlaylistItems.list('contentDetails', options);
      if (!results || !Array.isArray(results.items)) {
        recordRowError("source", "Uploads playlist returned an invalid response for channel " + channelId);
        return videoIds;
      }

      pagesRead += 1;
      var pageHasUnknownItem = false;
      var videosToBeAdded = results.items.filter(function(item) {
        var details = item && item.contentDetails;
        var publishedAt = details && new Date(details.videoPublishedAt);
        if (!details || !details.videoId || !publishedAt || isNaN(publishedAt.getTime())) {
          pageHasUnknownItem = true;
          recordRowError(
            "source",
            "Uploads playlist " + uploadsPlaylistId + " returned an item with incomplete publication metadata; " +
            "valid candidates were kept and the checkpoint was retained"
          );
          return false;
        }
        return new Date(lastTimestamp) <= publishedAt;
      });
      [].push.apply(videoIds, videosToBeAdded.map(function(item) {
        return item.contentDetails.videoId;
      }));

      // Uploads playlists are newest-first. Once a whole page predates the
      // checkpoint there is no reason to request older pages.
      if (results.items.length > 0 && videosToBeAdded.length === 0 && !pageHasUnknownItem) break;
      var returnedToken = results.nextPageToken || null;
      if (returnedToken && seenPageTokens[returnedToken]) {
        recordRowError(
          "source",
          "Uploads playlist " + uploadsPlaylistId + " returned a repeated page token after " +
          pagesRead + " page(s); partial candidates were kept and the checkpoint was retained"
        );
        return videoIds.reverse();
      }
      if (returnedToken) seenPageTokens[returnedToken] = true;
      nextPageToken = returnedToken;
    } catch (e) {
      recordSourcePageReadFailure(
        "Cannot search uploads playlist " + uploadsPlaylistId + " for channel " + channelId,
        e,
        pagesRead
      );
      return videoIds.reverse();
    }
  } while (nextPageToken !== null);

  return videoIds.reverse(); // Ascending publication order for insertion.
}

// Get video IDs from an explicit source playlist.

function getPlaylistVideoIds(playlistId, lastTimestamp) {
  var videoIds = [];
  var nextPageToken = null;
  var seenPageTokens = Object.create(null);
  var pagesRead = 0;
  var checkpoint = new Date(lastTimestamp);

  // playlistItems.list has no order or publishedAfter parameters. Explicit
  // playlists can also be manually ordered, so every page must be fetched and
  // snippet.publishedAt (the time the item was added) must be filtered locally.
  do {
    try {
      var options = {
        playlistId: playlistId,
        maxResults: 50,
        fields: 'nextPageToken,items(snippet(publishedAt,resourceId(videoId)))'
      };
      if (nextPageToken) options.pageToken = nextPageToken;
      var results = YouTube.PlaylistItems.list('snippet', options);
      if (!results || !Array.isArray(results.items)) {
        recordRowError("source", "YouTube playlist search returned an invalid response for playlist " + playlistId);
        return videoIds;
      }

      pagesRead += 1;
      results.items.forEach(function(item) {
        var snippet = item && item.snippet;
        var videoId = snippet && snippet.resourceId && snippet.resourceId.videoId;
        var publishedAt = snippet && new Date(snippet.publishedAt);
        if (!videoId || !publishedAt || isNaN(publishedAt.getTime())) {
          recordRowError(
            "source",
            "Source playlist " + playlistId + " returned an item with incomplete publication metadata; " +
            "valid candidates were kept and the checkpoint was retained"
          );
          return;
        }
        if (publishedAt >= checkpoint) videoIds.push(videoId);
      });
      var returnedToken = results.nextPageToken || null;
      if (returnedToken && seenPageTokens[returnedToken]) {
        recordRowError(
          "source",
          "Source playlist " + playlistId + " returned a repeated page token after " +
          pagesRead + " page(s); partial candidates were kept and the checkpoint was retained"
        );
        return videoIds;
      }
      if (returnedToken) seenPageTokens[returnedToken] = true;
      nextPageToken = returnedToken;
    } catch (e) {
      recordSourcePageReadFailure("Cannot read source playlist " + playlistId, e, pagesRead);
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
    videoSet: Object.create(null),
    complete: false,
    pagesRead: 0
  };
  var nextPageToken = null;
  var seenPageTokens = Object.create(null);

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
      if (!results || !Array.isArray(results.items)) {
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
      var pageHadMalformedItem = false;
      results.items.forEach(function(item) {
        var videoId = item && item.contentDetails && item.contentDetails.videoId;
        if (videoId) {
          inventory.videoSet[videoId] = true;
        } else {
          pageHadMalformedItem = true;
        }
      });
      if (pageHadMalformedItem) {
        recordRowWarning(
          "write",
          "Target playlist page " + inventory.pagesRead + " contained an item without a video ID; " +
          "unresolved candidates will be checked individually"
        );
        targetPlaylistVideoCache[playlistId] = inventory;
        return inventory;
      }

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
      if (isQuotaExhaustionError(e)) targetMembershipQuotaFailure = e;
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
// token fails. Exact probes are capped by the rollback-safe insert capacity so
// a pagination failure cannot turn a bounded mutation into an unbounded read
// fan-out. Any unresolved candidate keeps the row checkpoint for retry.
function getTargetPendingVideoIds(playlistId, videoIds, inventory, maxMembershipProbes) {
  var pendingVideoIds = [];
  var alreadyPresentCount = 0;
  var unresolvedCount = 0;
  var membershipProbesUsed = 0;
  var deferredByProbeLimit = 0;
  var deferredAfterQuota = 0;
  var quotaFailure = targetMembershipQuotaFailure;
  var probeLimit = typeof maxMembershipProbes === "number"
    ? Math.max(0, Math.floor(maxMembershipProbes))
    : videoIds.length;

  videoIds.forEach(function(videoId) {
    if (lookupSetHas(inventory.videoSet, videoId)) {
      alreadyPresentCount += 1;
      return;
    }

    if (!inventory.complete) {
      if (quotaFailure) {
        unresolvedCount += 1;
        deferredAfterQuota += 1;
        return;
      }
      if (membershipProbesUsed >= probeLimit) {
        unresolvedCount += 1;
        deferredByProbeLimit += 1;
        return;
      }

      membershipProbesUsed += 1;
      targetMembershipProbesUsed += 1;
      try {
        var membership = YouTube.PlaylistItems.list('id', {
          playlistId: playlistId,
          videoId: videoId,
          maxResults: 1,
          fields: 'items(id)'
        });
        if (!membership || !Array.isArray(membership.items)) {
          unresolvedCount += 1;
          recordRowError(
            "write",
            "Target membership check returned an invalid response for video " + videoId + "; withholding it for retry"
          );
          return;
        }
        if (membership.items.length > 0 && !membership.items.some(function(item) { return item && item.id; })) {
          unresolvedCount += 1;
          recordRowError(
            "write",
            "Target membership check returned an item without an ID for video " + videoId + "; withholding it for retry"
          );
          return;
        }
        if (membership.items.length > 0) {
          inventory.videoSet[videoId] = true;
          alreadyPresentCount += 1;
          return;
        }
      } catch (e) {
        unresolvedCount += 1;
        if (isQuotaExhaustionError(e)) {
          quotaFailure = e;
          targetMembershipQuotaFailure = e;
          deferredAfterQuota += 1;
        } else {
          recordRowError(
            "write",
            "Cannot verify whether video " + videoId + " is already in target playlist " +
            playlistId + "; withholding it for retry: " + describeError(e)
          );
        }
        return;
      }
    }

    pendingVideoIds.push(videoId);
  });

  if (quotaFailure && deferredAfterQuota > 0) {
    recordRowError(
      "write",
      "Target membership probes stopped after quota exhaustion; " + deferredAfterQuota +
      " unresolved candidate(s) were withheld, already resolved candidates were retained, and the checkpoint will be retried: " +
      describeError(quotaFailure)
    );
  }
  if (deferredByProbeLimit > 0) {
    recordRowError(
      "write",
      "Target membership probe limit of " + probeLimit + " was reached; " + deferredByProbeLimit +
      " unresolved candidate(s) were withheld and the checkpoint will be retried"
    );
  }

  return {
    pendingVideoIds: pendingVideoIds,
    alreadyPresentCount: alreadyPresentCount,
    unresolvedCount: unresolvedCount,
    membershipProbesUsed: membershipProbesUsed,
    quotaExhausted: !!quotaFailure
  };
}

// Non-mutating target audit. Factual broadcast classification stays separate
// from the admission decision so unknown metadata can remain fail-closed while
// every known broadcast state is counted as forbidden.
function inspectTargetPlaylistStrict(playlistId) {
  var playlistItems = [];
  var nextPageToken = null;
  var seenPageTokens = Object.create(null);
  do {
    try {
      var options = {
        playlistId: playlistId,
        maxResults: 50,
        fields: 'nextPageToken,items(id,contentDetails(videoId))'
      };
      if (nextPageToken) options.pageToken = nextPageToken;
      var page = YouTube.PlaylistItems.list('id,contentDetails', options);
      if (!page || !Array.isArray(page.items)) {
        recordRowError("policy", "Strict target audit received an invalid playlist response");
        return null;
      }
      [].push.apply(playlistItems, page.items);
      var returnedToken = page.nextPageToken || null;
      if (returnedToken && seenPageTokens[returnedToken]) {
        recordRowError("policy", "Strict target audit received a repeated playlist page token");
        return null;
      }
      if (returnedToken) seenPageTokens[returnedToken] = true;
      nextPageToken = returnedToken;
    } catch (e) {
      recordRowError("policy", "Cannot read target playlist during strict audit: " + describeError(e));
      return null;
    }
  } while (nextPageToken !== null);

  var unidentifiedPlaylistItemCount = 0;
  var videoIds = dedupeVideoIds(playlistItems.map(function(item) {
    var videoId = item && item.contentDetails && item.contentDetails.videoId;
    if (typeof videoId !== "string" || !videoId.trim()) {
      unidentifiedPlaylistItemCount += 1;
      recordRowError(
        "policy",
        "Strict target audit found a playlist item without a usable contentDetails.videoId"
      );
      return null;
    }
    return videoId;
  }));
  var counts = {
    NORMAL_UPLOAD: 0,
    UPCOMING: 0,
    ACTIVE: 0,
    COMPLETED_LIVE: 0,
    UNKNOWN: unidentifiedPlaylistItemCount
  };
  var forbiddenCount = 0;
  var withheldCount = unidentifiedPlaylistItemCount;

  for (var start = 0; start < videoIds.length; start += 50) {
    var batch = videoIds.slice(start, start + 50);
    try {
      var response = YouTube.Videos.list('snippet,contentDetails,liveStreamingDetails', {id: batch.join(',')});
      if (!response || !Array.isArray(response.items)) {
        recordRowError("policy", "Strict target audit received invalid metadata for batch starting with " + batch[0]);
        counts.UNKNOWN += batch.length;
        withheldCount += batch.length;
        continue;
      }

      var itemsById = Object.create(null);
      response.items.forEach(function(item) {
        if (item && item.id) itemsById[item.id] = item;
      });
      batch.forEach(function(videoId) {
        var item = itemsById[videoId];
        var decision = item ? evaluateVideoAdmissionPolicy(item) : {
          allowed: false,
          blocking: true,
          classification: "UNKNOWN",
          reason: "video_metadata_missing"
        };
        var classification = decision.classification;
        counts[classification] += 1;
        if (decision.blocking) {
          withheldCount += 1;
          recordRowError(
            "policy",
            "Strict target audit withheld " + classification + ": " +
            formatVideoAdmissionEvidence(videoId, item, decision)
          );
        } else if (!decision.allowed) {
          forbiddenCount += 1;
          safeLog("[STRICT TARGET AUDIT] REJECTED " + classification + ": " +
            formatVideoAdmissionEvidence(videoId, item, decision));
        }
      });
    } catch (e) {
      recordRowError("policy", "Strict target metadata audit failed for batch starting with " + batch[0] + ": " + describeError(e));
      counts.UNKNOWN += batch.length;
      withheldCount += batch.length;
    }
  }

  var report = {
    playlistItemCount: playlistItems.length,
    uniqueVideoCount: videoIds.length,
    unidentifiedPlaylistItemCount: unidentifiedPlaylistItemCount,
    classifications: counts,
    // Retained as a compatibility field for existing audit consumers. Strict
    // policy never admits a completed broadcast, so this is always zero.
    admittedHeuristicCompletedBroadcastCount: 0,
    forbiddenCount: forbiddenCount,
    withheldCount: withheldCount,
    unknownCount: counts.UNKNOWN,
    mutationPerformed: false
  };
  safeLog("STRICT_TARGET_AUDIT_RESULT " + JSON.stringify(report));
  return report;
}

// Re-check candidates immediately before insertion. The acquisition/filter pass
// can be seconds earlier, so this closes the observable state-change window and
// fails closed if metadata cannot be proven safe under the same admission rule.
function revalidateStrictCandidates(videoIds, context) {
  var allowedVideoIds = [];
  for (var start = 0; start < videoIds.length; start += 50) {
    var batch = videoIds.slice(start, start + 50);
    try {
      var response = YouTube.Videos.list('snippet,contentDetails,liveStreamingDetails', {id: batch.join(',')});
      if (!response || !Array.isArray(response.items)) {
        recordRowError("policy", "Invalid metadata response while " + context + " for " + batch.length + " video(s)");
        continue;
      }

      var itemsById = Object.create(null);
      response.items.forEach(function(item) {
        if (item && item.id) itemsById[item.id] = item;
      });

      batch.forEach(function(videoId) {
        var item = itemsById[videoId];
        if (!item) {
          recordRowError("policy", "Video " + videoId + " was omitted while " + context + "; withholding it for retry");
          return;
        }

        var decision = evaluateVideoAdmissionPolicy(item);
        if (decision.allowed) {
          allowedVideoIds.push(videoId);
        } else if (decision.blocking) {
          recordRowError("policy", "Video " + videoId + " is not currently eligible while " + context +
            " and must be retried: " + formatVideoAdmissionEvidence(videoId, item, decision));
        } else {
          safeLog("Strict policy rejected " + decision.classification + " during " + context + ": " +
            formatVideoAdmissionEvidence(videoId, item, decision));
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
    safeLog("Rolled back inserted video " + record.videoId + ": " + reason);
    return true;
  } catch (e) {
    recordRowError("policy", "Failed to roll back inserted video " + record.videoId + ": " + describeError(e));
    return false;
  }
}

function reconcileInsertWithoutResponseId(playlistId, videoId, existingVideos) {
  // This exceptional read is part of mandatory rollback recovery, so it is
  // attempted even if ordinary membership probes have reached their ceiling.
  // Charge it before the request so diagnostics report the attempted quota use.
  targetMembershipProbesUsed += 1;
  var response = null;
  try {
    response = YouTube.PlaylistItems.list('id', {
      playlistId: playlistId,
      videoId: videoId,
      maxResults: 50,
      fields: 'items(id)'
    });
  } catch (e) {
    if (isQuotaExhaustionError(e)) targetMembershipQuotaFailure = e;
    recordRowError(
      "write",
      "Could not reconcile the likely insertion of video " + videoId +
      " after its response omitted a valid playlist-item ID; manual target-playlist review is required: " +
      describeError(e)
    );
    return false;
  }

  if (!response || !Array.isArray(response.items)) {
    recordRowError(
      "write",
      "Insert reconciliation returned an invalid response for video " + videoId +
      "; manual target-playlist review is required"
    );
    return false;
  }

  var recoveredIds = response.items.map(function(item) {
    return item && typeof item.id === "string" ? item.id.trim() : "";
  }).filter(function(id) { return !!id; });
  if (response.items.length !== 1 || recoveredIds.length !== 1) {
    recordRowError(
      "write",
      "Insert reconciliation found " + response.items.length + " matching target item(s) and " +
      recoveredIds.length + " usable playlist-item ID(s) for video " + videoId +
      "; the new item cannot be identified safely and manual target-playlist review is required"
    );
    return false;
  }

  return rollbackInsertedPlaylistItem(
    {videoId: videoId, playlistItemId: recoveredIds[0]},
    existingVideos,
    "insert response omitted its playlist-item ID; exact membership reconciliation recovered the only matching item"
  );
}

function postValidateInsertWithoutRollbackHandle(videoId) {
  try {
    var response = YouTube.Videos.list(
      'snippet,contentDetails,liveStreamingDetails',
      {id: videoId}
    );
    var item = response && Array.isArray(response.items)
      ? response.items.filter(function(candidate) { return candidate && candidate.id === videoId; })[0]
      : null;
    var decision = item ? evaluateVideoAdmissionPolicy(item) : {
      allowed: false,
      blocking: true,
      classification: "UNKNOWN",
      reason: "video_metadata_missing"
    };
    if (decision.allowed) {
      safeLog(
        "Untracked likely insertion for video " + videoId +
        " still satisfies the admission policy, but its target item could not be identified; manual review remains required"
      );
    } else {
      recordRowError(
        "policy",
        "Untracked likely insertion for video " + videoId + " has post-insert classification " +
        decision.classification + " (" + decision.reason +
        ") and cannot be rolled back automatically; urgent manual target-playlist review is required"
      );
    }
  } catch (e) {
    recordRowError(
      "policy",
      "Cannot post-validate untracked likely insertion for video " + videoId +
      "; manual target-playlist review is required: " + describeError(e)
    );
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

    if (!response || !Array.isArray(response.items)) {
      recordRowError("policy", "Post-insert metadata returned an invalid response for " + batchRecords.length + " video(s)");
      batchRecords.forEach(function(record) {
        rollbackInsertedPlaylistItem(record, existingVideos, "post-insert metadata response was invalid");
      });
      continue;
    }

    var itemsById = Object.create(null);
    response.items.forEach(function(item) {
      if (item && item.id) itemsById[item.id] = item;
    });

    batchRecords.forEach(function(record) {
      var item = itemsById[record.videoId];
      var decision = item ? evaluateVideoAdmissionPolicy(item) : {
        allowed: false,
        blocking: true,
        classification: "UNKNOWN",
        reason: "video_metadata_missing"
      };
      if (decision.allowed) return;

      var reason = item
        ? "post-insert admission changed to " + decision.reason + " (" + decision.classification + ")"
        : "video was omitted by post-insert metadata";
      if (decision.blocking) {
        recordRowError("policy", "Post-insert state for video " + record.videoId +
          " requires retry: " + reason + "; rolling it back");
      } else {
        recordRowWarning("policy", "Post-insert state for video " + record.videoId + " is no longer eligible: " + reason + "; rolling it back");
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
    safeLog("No new videos yet.");
    return;
  }

  var remainingOperations = maxPlaylistWriteOperationsPerRun - playlistWriteOperationsUsed;
  var safeInsertCapacity = Math.floor(Math.max(0, remainingOperations) / 2);

  var targetInventory = getTargetPlaylistVideoInventory(playlistId);
  if (targetInventory === null) return;

  // Bound exact fallback reads across the whole execution, not just this row.
  // Tying the probe budget to the configured rollback-safe write ceiling keeps
  // a series of partial target scans from multiplying quota consumption.
  var maxMembershipProbesPerRun = Math.floor(Math.max(0, maxPlaylistWriteOperationsPerRun) / 2);
  var remainingMembershipProbeBudget = Math.max(
    0,
    maxMembershipProbesPerRun - targetMembershipProbesUsed
  );

  var membershipResult = getTargetPendingVideoIds(
    playlistId,
    videoIds,
    targetInventory,
    Math.min(safeInsertCapacity, remainingMembershipProbeBudget)
  );
  var existingVideos = targetInventory.videoSet;
  var pendingVideoIds = membershipResult.pendingVideoIds;
  var alreadyPresentCount = membershipResult.alreadyPresentCount;
  if (alreadyPresentCount > 0) {
    safeLog("Skipped " + alreadyPresentCount + " video(s) already present in the target playlist.");
  }
  if (!pendingVideoIds.length) {
    safeLog("No new videos to insert after target-playlist de-duplication.");
    return;
  }

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
      " candidate video(s); validating and inserting that bounded subset while retaining the checkpoint for retry"
    );
    pendingVideoIds = pendingVideoIds.slice(0, safeInsertCapacity);
  }

  pendingVideoIds = revalidateStrictCandidates(pendingVideoIds, "pre-insert admission revalidation");
  if (!pendingVideoIds.length) {
    safeLog("No eligible videos remain after pre-insert admission revalidation.");
    return;
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
      var playlistItemId = insertedResource && typeof insertedResource.id === "string"
        ? insertedResource.id.trim()
        : "";
      if (!playlistItemId) {
        // The mutation may have succeeded, but without its playlist-item ID it
        // cannot be post-validated with a guaranteed rollback. Remember likely
        // membership for this execution, stop further writes, and force a retry
        // plus manual review instead of reporting unsafe success.
        existingVideos[videoId] = true;
        errorCount += 1;
        recordRowError(
          "write",
          "Insert response for video " + videoId +
          " had no valid playlist-item ID. The insertion may have succeeded, automatic rollback from that response is impossible, " +
          "the checkpoint was retained, and exact reconciliation will attempt to recover a rollback handle"
        );
        if (!reconcileInsertWithoutResponseId(playlistId, videoId, existingVideos)) {
          postValidateInsertWithoutRollbackHandle(videoId);
        }
        break;
      }
      existingVideos[videoId] = true;
      insertedRecords.push({
        videoId: videoId,
        playlistItemId: playlistItemId
      });
      successCount += 1;
    } catch (e) {
      var reason = getErrorReason(e);
      if (reason === "videoAlreadyInPlaylist") {
        existingVideos[videoId] = true;
        skippedCount += 1;
        safeLog("Skipped video already present in playlist: " + videoId);
      } else if (reason === "videoNotFound") {
        errorCount += 1;
        recordRowError(
          "write",
          "Video " + videoId + " disappeared between validation and insertion; withholding it for retry: " + describeError(e)
        );
      } else if (reason === "playlistOperationUnsupported") {
        errorCount += 1;
        recordRowError("write", "The target is a playlist that the API cannot modify (for example Watch Later or Watch History): " + playlistId);
        break;
      } else {
        errorCount += 1;
        if (isQuotaExhaustionError(e)) targetMembershipQuotaFailure = e;
        recordRowError("write", "Could not insert video " + videoId + " into playlist " + playlistId + ": " + describeError(e));
      }
    }
  }

  if (insertedRecords.length > 0) postValidateInsertedItems(insertedRecords, existingVideos);
  safeLog("Added " + successCount + " video(s); skipped " + skippedCount + "; failed " + errorCount + ".");
}

// Delete old and duplicate items only after all pages have been read. Mutating
// a playlist while paging through it can otherwise skip entries.
function deletePlaylistItems(playlistId, deleteBeforeTimestamp) {
  var allItems = [];
  var nextPageToken = null;
  var seenPageTokens = Object.create(null);

  do {
    try {
      var options = {
        playlistId: playlistId,
        maxResults: 50,
        fields: 'nextPageToken,items(id,contentDetails(videoId,videoPublishedAt))'
      };
      if (nextPageToken) options.pageToken = nextPageToken;
      var results = YouTube.PlaylistItems.list('id,contentDetails', options);
      if (!results || !Array.isArray(results.items)) {
        recordRowWarning("maintenance", "Target playlist returned an invalid response while preparing deletion: " + playlistId);
        return;
      }
      [].push.apply(allItems, results.items);
      var returnedToken = results.nextPageToken || null;
      if (returnedToken && seenPageTokens[returnedToken]) {
        recordRowWarning("maintenance", "Target playlist returned a repeated page token while preparing deletion: " + playlistId);
        return;
      }
      if (returnedToken) seenPageTokens[returnedToken] = true;
      nextPageToken = returnedToken;
    } catch (e) {
      recordRowWarning("maintenance", "Cannot read target playlist " + playlistId + " before deletion: " + describeError(e));
      return;
    }
  } while (nextPageToken !== null);

  var deleteBefore = new Date(deleteBeforeTimestamp);
  var seenVideoIds = Object.create(null);
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
  safeLog("Removed " + removedCount + " old or duplicate playlist item(s).");
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

  if (filterShorts) safeLog("Removing shorts");
  safeLog("Strict livestream policy: rejecting upcoming, active, and completed broadcast-like videos; column F is ignored");

  var filteredVideoIds = [];
  for (var start = 0; start < videoIds.length; start += 50) {
    var batch = videoIds.slice(start, start + 50);
    try {
      // videos.list accepts up to 50 comma-separated IDs, so both filters share
      // one metadata request instead of making one or two requests per video.
      var response = YouTube.Videos.list('snippet,contentDetails,liveStreamingDetails', {id: batch.join(',')});
      if (!response || !Array.isArray(response.items)) {
        recordRowError("filter", "Video metadata returned an invalid response for a batch of " + batch.length + " videos");
        continue;
      }

      var itemsById = Object.create(null);
      response.items.forEach(function(item) {
        if (item && item.id) itemsById[item.id] = item;
      });

      batch.forEach(function(videoId) {
        var item = itemsById[videoId];
        if (!item) {
          recordRowError("filter", "Video " + videoId + " was omitted from a successful metadata response; withholding it for retry");
          return;
        }

        var decision = evaluateVideoAdmissionPolicy(item);
        if (decision.blocking) {
          recordRowError("filter", "Cannot prove video is eligible under the strict broadcast policy: " +
            formatVideoAdmissionEvidence(videoId, item, decision));
          return;
        }
        if (!decision.allowed) {
          safeLog("Strict policy rejected " + decision.classification + ": " +
            formatVideoAdmissionEvidence(videoId, item, decision));
          return;
        }

        var duration = item.contentDetails && item.contentDetails.duration;
        if (filterShorts && !duration) {
          recordRowError("filter", "Video " + videoId + " has no duration metadata; withholding it for retry");
          return;
        } else if (filterShorts && isLessThanThreeMinutes(duration)) {
          safeLog("Filtered short: " + videoId + " | duration: " + duration);
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

// Parse the documented ISO 8601 duration form used by videos.contentDetails.
// This utility remains available for diagnostics/tests; broadcast admission no
// longer depends on duration. Empty P/PT, signs, calendar months/years, and
// malformed values are rejected.
function parseIso8601DurationSeconds(duration) {
  var text = normalizeCellValue(duration);
  var match = text.match(
    /^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?)?$/
  );
  if (!match || text.slice(-1) == "T" || !match.slice(1).some(function(value) { return value !== undefined; })) {
    return null;
  }

  var days = Number(match[1] || 0);
  var hours = Number(match[2] || 0);
  var minutes = Number(match[3] || 0);
  var seconds = Number(match[4] || 0);
  var total = (((days * 24) + hours) * 60 + minutes) * 60 + seconds;
  return isFinite(total) && total >= 0 ? total : null;
}

function parseApiTimestampMillis(value) {
  var text = normalizeCellValue(value);
  if (!text) return null;

  // YouTube documents these values as ISO 8601 datetimes. Accept the strict
  // RFC3339-compatible profile that the API emits: a complete date and time,
  // optional fractional seconds, and a mandatory Z or numeric timezone. Do not
  // delegate validation to Date.parse(), which accepts non-ISO strings and even
  // normalizes impossible calendar dates such as February 30.
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
  // RFC3339 uses -00:00 to mean that the local offset is unknown. That cannot
  // prove an actual elapsed interval, so reject it instead of treating it as Z.
  if (timezoneSign == "-" && timezoneHours === 0 && timezoneMinutes === 0) return null;

  var leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  var daysInMonth = [31, leapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (day < 1 || day > daysInMonth[month - 1]) return null;

  // setUTCFullYear avoids Date.UTC's special interpretation of years 0..99.
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

// Keep factual classification separate from admission. The public API cannot
// reliably distinguish a completed Premiere from a completed livestream, so
// strict mode rejects every known broadcast state. Known rejections are
// non-blocking because they can never become eligible under this policy;
// missing or unknown metadata remains blocking and fail-closed.
function evaluateVideoAdmissionPolicy(item) {
  var classification = classifyVideoStrict(item);
  var decision = {
    allowed: false,
    blocking: false,
    classification: classification,
    admissionClass: classification,
    reason: ""
  };

  if (classification == "NORMAL_UPLOAD") {
    decision.allowed = true;
    decision.reason = "normal_upload";
    return decision;
  }
  if (classification == "UPCOMING") {
    decision.reason = "upcoming_broadcast_rejected_by_strict_policy";
    return decision;
  }
  if (classification == "ACTIVE") {
    decision.reason = "active_broadcast_rejected_by_strict_policy";
    return decision;
  }
  if (classification == "COMPLETED_LIVE") {
    decision.reason = "completed_broadcast_rejected_by_strict_policy";
    return decision;
  }
  if (classification != "NORMAL_UPLOAD") {
    decision.blocking = true;
    decision.reason = "live_state_missing_or_unknown";
    return decision;
  }
  return decision;
}

// Classify only from documented API fields. Duration and title are deliberately
// excluded from factual type classification and admission.
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

function formatVideoAdmissionEvidence(videoId, item, decision) {
  var evidence = formatVideoEvidence(videoId, item);
  if (!decision) return evidence;
  evidence += " | admission: " + (decision.admissionClass || decision.classification || "UNKNOWN") +
    " | decision: " + (decision.reason || "unknown");
  if (decision.contentDurationSeconds !== undefined && decision.contentDurationSeconds !== null) {
    evidence += " | playbackSeconds: " + decision.contentDurationSeconds;
  }
  if (decision.actualDurationSeconds !== undefined && decision.actualDurationSeconds !== null) {
    evidence += " | actualSeconds: " + decision.actualDurationSeconds;
  }
  if (decision.effectiveDurationSeconds !== undefined && decision.effectiveDurationSeconds !== null) {
    evidence += " | effectiveSeconds: " + decision.effectiveDurationSeconds;
  }
  return evidence;
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
