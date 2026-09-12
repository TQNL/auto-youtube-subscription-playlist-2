// Manual, read-only diagnosis. No triggers, insertions, deletions or setters.
// At most 20 YouTube list calls and 120 seconds between calls per invocation.
function diagnoseNosRetryReadOnly() {
  var ss = SpreadsheetApp.openById(PropertiesService.getScriptProperties().getProperty('sheetID'));
  var store = openVideoRetryStore(ss, false);
  var entries = Object.keys(store.entries).map(function(key) { return store.entries[key]; })
    .filter(function(entry) { return entry.videoId === 'ozBfToKlFLw'; })
    .map(function(entry) { return {target: entry.playlistId, video: entry.videoId,
      status: entry.status, failures: entry.failures, first: new Date(entry.first).toISOString(),
      last: new Date(entry.last).toISOString(), due: entry.due === null ? null : new Date(entry.due).toISOString(),
      reason: entry.reason, sourceRow: entry.sourceRow}; });
  console.log('PLAYLIST_RETRY_DIAGNOSTIC ' + JSON.stringify(entries));
  return entries;
}

function diagnoseNosPlaylistReadOnly() {
  var ss = SpreadsheetApp.openById(PropertiesService.getScriptProperties().getProperty('sheetID'));
  var data = ss.getSheets()[0].getDataRange().getValues();
  var source = 'PLcz8MliLAY0d14lip6PaioP3aXSEOAXyC';
  var video = 'ozBfToKlFLw';
  var rows = [];
  data.forEach(function(row, index) {
    if (index >= 3 && row.slice(6).some(function(cell) { return String(cell).trim() === source; })) {
      rows.push({row: index + 1, target: row[0], checkpoint: row[1], shorts: row[4]});
    }
  });
  var retrySheet = ss.getSheetByName('VideoRetries');
  var retryRows = retrySheet ? retrySheet.getDataRange().getValues().filter(function(row) {
    return row.some(function(cell) { return String(cell) === video; });
  }) : [];
  var report = playlistDiagnosticCore_(YouTube, source, video, rows, function(entry) {
    console.log('PLAYLIST_DIAGNOSTIC ' + JSON.stringify(entry));
  });
  // Notes are user-authored and need not be copied to execution logs.
  report.retryMatchingRows = retryRows.length;
  console.log('PLAYLIST_DIAGNOSTIC_SUMMARY ' + JSON.stringify(report));
  return report;
}

// Dependency injection lets local tests simulate errors without live API writes.
function playlistDiagnosticCore_(api, source, video, rows, emit) {
  var started = Date.now();
  var report = {source: source, video: video, calls: 0, pages: [], rows: rows,
    sourceComplete: false, sourceMatches: [], metadata: null, membership: [], errors: []};
  function read(service, part, options) {
    if (report.calls >= 20 || Date.now() - started >= 120000) throw Error('DIAGNOSTIC_BUDGET_REACHED');
    report.calls++;
    return api[service].list(part, options);
  }
  function error(stage, e) {
    var detail = {stage: stage, message: String(e && e.message || e)};
    report.errors.push(detail); emit(detail);
  }
  // Metadata first: remains available in the trace even if source pagination stalls.
  try {
    var metadata = read('Videos', 'snippet,contentDetails,liveStreamingDetails,status', {id: video,
      fields: 'items(id,snippet(title,publishedAt,liveBroadcastContent),contentDetails,liveStreamingDetails,status)'});
    if (!metadata || !Array.isArray(metadata.items)) throw Error('INVALID_METADATA_RESPONSE');
    var item = metadata.items.filter(function(v) { return v && v.id === video; })[0];
    report.metadata = item ? {returned: true, item: item,
      admission: evaluateVideoAdmissionPolicy(item)} : {returned: false, reason: 'API_OMITTED_VIDEO'};
    emit({stage: 'metadata', result: report.metadata});
  } catch (e) { error('metadata', e); }

  var token = null, seenTokens = Object.create(null), seenItems = Object.create(null);
  try {
    do {
      var options = {playlistId: source, maxResults: 50,
        fields: 'nextPageToken,pageInfo,items(id,snippet(title,publishedAt,position,resourceId(videoId)),contentDetails(videoId,videoPublishedAt))'};
      if (token) options.pageToken = token;
      var page = read('PlaylistItems', 'snippet,contentDetails', options);
      if (!page || !Array.isArray(page.items)) throw Error('INVALID_SOURCE_RESPONSE');
      var summary = {stage: 'sourcePage', page: report.pages.length + 1, count: page.items.length,
        totalReported: page.pageInfo && page.pageInfo.totalResults, duplicateItemIds: 0,
        malformedItems: 0, firstPosition: null, lastPosition: null, hasNext: !!page.nextPageToken};
      page.items.forEach(function(entry) {
        var s = entry && entry.snippet;
        var id = s && s.resourceId && s.resourceId.videoId;
        if (!id || !s.publishedAt || isNaN(Date.parse(s.publishedAt))) summary.malformedItems++;
        if (entry && entry.id) {
          if (seenItems[entry.id]) summary.duplicateItemIds++;
          seenItems[entry.id] = true;
        }
        if (s) {
          if (summary.firstPosition === null) summary.firstPosition = s.position;
          summary.lastPosition = s.position;
        }
        if (id === video) report.sourceMatches.push({page: summary.page, addedAt: s.publishedAt,
          videoPublishedAt: entry.contentDetails && entry.contentDetails.videoPublishedAt,
          position: s.position, title: s.title});
      });
      report.pages.push(summary); emit(summary);
      var next = page.nextPageToken || null;
      if (next && seenTokens[next]) throw Error('REPEATED_SOURCE_PAGE_TOKEN');
      if (next) seenTokens[next] = true;
      token = next;
    } while (token);
    report.sourceComplete = report.pages.every(function(p) { return p.malformedItems === 0; });
  } catch (e) { error('source', e); }

  rows.forEach(function(row) {
    var result = {row: row.row, target: row.target, checkpoint: row.checkpoint,
      sourceDateEligible: report.sourceMatches.some(function(m) {
        return Date.parse(m.addedAt) >= new Date(row.checkpoint).getTime();
      })};
    try {
      var membership = read('PlaylistItems', 'id,snippet', {playlistId: row.target, videoId: video,
        maxResults: 1, fields: 'items(id,snippet(publishedAt))'});
      if (!membership || !Array.isArray(membership.items) ||
          membership.items.some(function(x) { return !x || !x.id; })) throw Error('INVALID_MEMBERSHIP_RESPONSE');
      result.present = membership.items.length > 0;
      result.addedToTargetAt = result.present ? membership.items[0].snippet.publishedAt : null;
    } catch (e) { result.present = null; error('membership', e); }
    report.membership.push(result); emit({stage: 'membership', result: result});
  });
  report.elapsedMs = Date.now() - started;
  report.mutations = 0;
  return report;
}
