'use strict';

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const vm = require('vm');
const source = fs.readFileSync(__dirname + '/../sheetScript.gs', 'utf8');
const experimentSource = fs.readFileSync(__dirname + '/../apps-script/Experiment.gs', 'utf8');

function makeContext(youtube) {
  const logs = [];
  const context = {
    console,
    Date,
    Math,
    JSON,
    Error,
    isNaN,
    Logger: {
      log: (...args) => logs.push(args.join(' ')),
      clear: () => { logs.length = 0; },
      getLog: () => logs.join('\n')
    },
    YouTube: youtube || {},
    SpreadsheetApp: {},
    PropertiesService: {},
    LockService: {},
    HtmlService: {}
  };
  vm.createContext(context);
  vm.runInContext(source, context, {filename: 'sheetScript-fixed.gs'});
  context.__logs = logs;
  return context;
}

function makeExperimentContext(youtube, appsScriptGlobals) {
  const context = makeContext(youtube);
  Object.assign(context, appsScriptGlobals || {});
  vm.runInContext(experimentSource, context, {filename: 'Experiment.gs'});
  return context;
}

function makeExperimentOnlyContext() {
  const context = {console, Date, Math, JSON, Error, isFinite, Logger: {log() {}}};
  vm.createContext(context);
  vm.runInContext(experimentSource, context, {filename: 'Experiment-only.gs'});
  return context;
}

function testExplicitPlaylistUsesSupportedPagination() {
  const calls = [];
  const ctx = makeContext({
    PlaylistItems: {
      list(part, options) {
        calls.push({part, options: Object.assign({}, options)});
        if (!options.pageToken) {
          return {
            nextPageToken: 'page-2',
            items: [
              {snippet: {publishedAt: '2026-07-16T00:00:00Z', resourceId: {videoId: 'old'}}},
              {snippet: {publishedAt: '2026-07-18T00:00:00Z', resourceId: {videoId: 'new-1'}}}
            ]
          };
        }
        return {
          items: [{snippet: {publishedAt: '2026-07-19T00:00:00Z', resourceId: {videoId: 'new-2'}}}]
        };
      }
    }
  });
  ctx.currentRowStatus = ctx.createRowStatus();
  const ids = Array.from(ctx.getPlaylistVideoIds('PL_SOURCE', '2026-07-17T00:00:00Z'));
  assert.deepStrictEqual(ids, ['new-1', 'new-2']);
  assert.strictEqual(calls.length, 2);
  calls.forEach(call => {
    assert.strictEqual(call.part, 'snippet');
    assert.ok(!Object.prototype.hasOwnProperty.call(call.options, 'order'));
    assert.ok(!Object.prototype.hasOwnProperty.call(call.options, 'publishedAfter'));
  });
}

function testMissingSourceWarnsHealthyInsertAndAdvancesTimestamp() {
  const inserted = [];
  let brokenSourceFirstRequestHadPageToken = null;
  let timestampWrites = 0;
  const ctx = makeContext({
    Channels: {
      list() {
        return {items: [{contentDetails: {relatedPlaylists: {uploads: 'UU_HEALTHY'}}}]};
      }
    },
    PlaylistItems: {
      list(part, options) {
        if (options.playlistId === 'UU_HEALTHY') {
          return {items: [{contentDetails: {videoId: 'healthy-video', videoPublishedAt: '2026-07-18T08:00:00Z'}}]};
        }
        if (options.playlistId === 'PL_BROKEN_12345') {
          brokenSourceFirstRequestHadPageToken = Object.prototype.hasOwnProperty.call(options, 'pageToken');
          // Apps Script sometimes exposes only this message, without details.code.
          throw new Error("API call failed: The playlist identified with the request's playlistId parameter cannot be found.");
        }
        if (options.playlistId === 'PL_TARGET_12345') return {items: []};
        throw new Error('unexpected playlist lookup ' + options.playlistId + ' / ' + part);
      },
      insert(resource) {
        const videoId = resource.snippet.resourceId.videoId;
        inserted.push(videoId);
        return {id: 'inserted-' + videoId};
      },
      remove() {}
    },
    Videos: {
      list() {
        return {items: [{
          id: 'healthy-video',
          snippet: {liveBroadcastContent: 'none'},
          contentDetails: {duration: 'PT10M'}
        }]};
      }
    }
  });
  const sheet = {
    getLastColumn: () => 8,
    getRange(row, column) {
      return {
        getValue: () => (column === 5 ? 'Yes' : (column === 6 ? 2 : '')),
        getDisplayValue: () => (column === 6 ? '2' : ''),
        setValue: () => { timestampWrites += 1; }
      };
    }
  };
  const data = [[], [], [], [
    'PL_TARGET_12345', '2026-07-17T00:00:00Z', 0, 0, 'Yes', 2,
    'UC_HEALTHY_12345', 'PL_BROKEN_12345'
  ]];

  ctx.currentRowStatus = ctx.createRowStatus();
  ctx.targetPlaylistVideoCache = {};
  ctx.playlistWriteOperationsUsed = 0;
  ctx.processPlaylistRow(sheet, data, 3, 'PL_TARGET_12345');

  assert.deepStrictEqual(inserted, ['healthy-video']);
  assert.strictEqual(ctx.currentRowStatus.sourceWarnings, 1);
  assert.strictEqual(ctx.currentRowStatus.sourceErrors, 0);
  assert.strictEqual(ctx.currentRowStatus.writeErrors, 0);
  assert.strictEqual(brokenSourceFirstRequestHadPageToken, false,
    'the initial explicit-source request must omit pageToken');
  assert.strictEqual(timestampWrites, 1, 'permanently missing source must not freeze the row checkpoint');
  assert.strictEqual(ctx.currentRowStatus.timestampUpdated, true);
}

function testMissingUploadsPlaylistWarnsHealthyInsertAndAdvancesTimestamp() {
  const inserted = [];
  let brokenUploadsFirstRequestHadPageToken = null;
  let timestampWrites = 0;
  const ctx = makeContext({
    Channels: {
      list(part, options) {
        assert.strictEqual(part, 'contentDetails');
        if (options.id === 'UC_HEALTHY_12345') {
          return {items: [{contentDetails: {relatedPlaylists: {uploads: 'UU_HEALTHY'}}}]};
        }
        if (options.id === 'UC_NO_UPLOADS_12345') {
          return {items: [{contentDetails: {relatedPlaylists: {uploads: 'UU_NO_UPLOADS'}}}]};
        }
        throw new Error('unexpected channel lookup ' + options.id);
      }
    },
    PlaylistItems: {
      list(part, options) {
        if (options.playlistId === 'UU_HEALTHY') {
          return {items: [{contentDetails: {
            videoId: 'healthy-video',
            videoPublishedAt: '2026-07-18T08:00:00Z'
          }}]};
        }
        if (options.playlistId === 'UU_NO_UPLOADS') {
          brokenUploadsFirstRequestHadPageToken = Object.prototype.hasOwnProperty.call(options, 'pageToken');
          const error = new Error('uploads playlist does not exist');
          error.details = {code: 404, errors: [{reason: 'playlistNotFound'}]};
          throw error;
        }
        if (options.playlistId === 'PL_TARGET_12345') return {items: []};
        throw new Error('unexpected playlist lookup ' + options.playlistId + ' / ' + part);
      },
      insert(resource) {
        inserted.push(resource.snippet.resourceId.videoId);
        return {id: 'inserted-' + resource.snippet.resourceId.videoId};
      },
      remove() {}
    },
    Videos: {
      list(part, options) {
        return {items: options.id.split(',').map(id => normalUpload(id, 'PT10M'))};
      }
    }
  });
  const sheet = {
    getLastColumn: () => 8,
    getRange(row, column) {
      return {
        getValue: () => (column === 5 ? 'Yes' : ''),
        setValue: () => { timestampWrites += 1; }
      };
    }
  };
  const data = [[], [], [], [
    'PL_TARGET_12345', '2026-07-17T00:00:00Z', 0, 0, 'Yes', '',
    'UC_HEALTHY_12345', 'UC_NO_UPLOADS_12345'
  ]];

  ctx.currentRowStatus = ctx.createRowStatus();
  ctx.targetPlaylistVideoCache = {};
  ctx.playlistWriteOperationsUsed = 0;
  ctx.processPlaylistRow(sheet, data, 3, 'PL_TARGET_12345');

  assert.deepStrictEqual(inserted, ['healthy-video']);
  assert.strictEqual(ctx.currentRowStatus.sourceWarnings, 1);
  assert.strictEqual(ctx.currentRowStatus.sourceErrors, 0);
  assert.strictEqual(ctx.currentRowStatus.writeErrors, 0);
  assert.strictEqual(brokenUploadsFirstRequestHadPageToken, false,
    'the initial uploads-playlist request must omit pageToken');
  assert.strictEqual(timestampWrites, 1,
    'a permanently absent first uploads page must not freeze healthy sources');
  assert.strictEqual(ctx.currentRowStatus.timestampUpdated, true);
}

function testTransientSourceErrorStillBlocksCheckpoint() {
  const inserted = [];
  let timestampWrites = 0;
  const ctx = makeContext({
    Channels: {
      list() {
        return {items: [{contentDetails: {relatedPlaylists: {uploads: 'UU_HEALTHY'}}}]};
      }
    },
    PlaylistItems: {
      list(part, options) {
        if (options.playlistId === 'UU_HEALTHY') {
          return {items: [{contentDetails: {videoId: 'healthy-video', videoPublishedAt: '2026-07-21T08:00:00Z'}}]};
        }
        if (options.playlistId === 'PL_TRANSIENT_12345') {
          const error = new Error('temporary backend failure');
          error.details = {code: 503, errors: [{reason: 'backendError'}]};
          throw error;
        }
        if (options.playlistId === 'PL_TARGET_12345') return {items: []};
        throw new Error('unexpected playlist lookup ' + options.playlistId + ' / ' + part);
      },
      insert(resource) {
        inserted.push(resource.snippet.resourceId.videoId);
        return {id: 'inserted-healthy-video'};
      }
    },
    Videos: {
      list(part, options) {
        return {items: options.id.split(',').map(id => normalUpload(id, 'PT10M'))};
      }
    }
  });
  const sheet = {
    getLastColumn: () => 8,
    getRange(row, column) {
      return {
        getValue: () => (column === 5 ? 'Yes' : ''),
        setValue: () => { timestampWrites += 1; }
      };
    }
  };
  const data = [[], [], [], [
    'PL_TARGET_12345', '2026-07-20T00:00:00Z', 0, 0, 'Yes', '',
    'UC_HEALTHY_12345', 'PL_TRANSIENT_12345'
  ]];

  ctx.currentRowStatus = ctx.createRowStatus();
  ctx.targetPlaylistVideoCache = {};
  ctx.playlistWriteOperationsUsed = 0;
  ctx.processPlaylistRow(sheet, data, 3, 'PL_TARGET_12345');

  assert.deepStrictEqual(inserted, ['healthy-video'], 'healthy candidates must survive a transient failure in another source');
  assert.strictEqual(ctx.currentRowStatus.sourceErrors, 1);
  assert.strictEqual(ctx.currentRowStatus.sourceWarnings, 0);
  assert.strictEqual(timestampWrites, 0, 'transient source failures must retain the retry checkpoint');
  assert.strictEqual(ctx.currentRowStatus.timestampUpdated, false);
}

function testMixedKnownBroadcastsRejectNormalUploadInsertsAndCheckpointAdvances() {
  const candidateIds = [
    'ordinary-long-upload',
    'scheduled-premiere',
    'active-livestream',
    'short-completed-broadcast'
  ];
  let timestampWrites = 0;
  let targetReads = 0;
  const inserted = [];
  const metadata = {
    'ordinary-long-upload': normalUpload('ordinary-long-upload', 'PT3H'),
    'scheduled-premiere': {
      id: 'scheduled-premiere',
      snippet: {liveBroadcastContent: 'upcoming'},
      contentDetails: {duration: 'P0D'},
      liveStreamingDetails: {scheduledStartTime: '2026-08-22T16:00:00Z'}
    },
    'active-livestream': {
      id: 'active-livestream',
      snippet: {liveBroadcastContent: 'live'},
      contentDetails: {duration: 'P0D'},
      liveStreamingDetails: {actualStartTime: '2026-08-21T20:00:00Z'}
    },
    'short-completed-broadcast': completedBroadcast(
      'short-completed-broadcast',
      'PT30M',
      '2026-08-21T18:00:00Z',
      '2026-08-21T18:30:00Z'
    )
  };
  const ctx = makeContext({
    Channels: {
      list() {
        return {items: [{contentDetails: {relatedPlaylists: {uploads: 'UU_TRANSITIONAL'}}}]};
      }
    },
    PlaylistItems: {
      list(part, options) {
        if (options.playlistId === 'UU_TRANSITIONAL') {
          return {items: candidateIds.map((videoId, index) => ({contentDetails: {
            videoId,
            videoPublishedAt: '2026-08-21T' + String(index + 8).padStart(2, '0') + ':00:00Z'
          }}))};
        }
        if (options.playlistId === 'PL_TARGET_12345') {
          targetReads += 1;
          return {items: []};
        }
        throw new Error('unexpected playlist lookup ' + options.playlistId + ' / ' + part);
      },
      insert(resource) {
        inserted.push(resource.snippet.resourceId.videoId);
        return {id: 'playlist-item-normal'};
      }
    },
    Videos: {
      list(part, options) {
        return {items: options.id.split(',').map(videoId => metadata[videoId])};
      }
    }
  });
  const sheet = {
    getLastColumn: () => 7,
    getRange(row, column) {
      return {
        getValue: () => (column === 5 ? 'Yes' : ''),
        setValue: () => { timestampWrites += 1; }
      };
    }
  };
  const data = [[], [], [], [
    'PL_TARGET_12345', '2026-08-20T00:00:00Z', 0, 0, 'Yes', '', 'UC_TRANSITIONAL_12345'
  ]];

  ctx.currentRowStatus = ctx.createRowStatus();
  ctx.targetPlaylistVideoCache = {};
  ctx.playlistWriteOperationsUsed = 0;
  ctx.processPlaylistRow(sheet, data, 3, 'PL_TARGET_12345');

  assert.strictEqual(ctx.currentRowStatus.filterErrors, 0);
  assert.strictEqual(ctx.currentRowStatus.errorCount, 0);
  assert.strictEqual(timestampWrites, 1,
    'known broadcast states are permanent strict rejections and must not freeze the row');
  assert.strictEqual(ctx.currentRowStatus.timestampUpdated, true);
  assert.strictEqual(targetReads, 1);
  assert.deepStrictEqual(inserted, ['ordinary-long-upload'],
    'ordinary long uploads remain eligible while every known broadcast state is rejected');
}

function testInvalidCheckpointTimestampBlocksBeforeAnyApiOrWrite() {
  let youtubeCalls = 0;
  let timestampWrites = 0;
  const unexpectedCall = () => {
    youtubeCalls += 1;
    throw new Error('invalid timestamp must stop before any YouTube request');
  };
  const ctx = makeContext({
    Channels: {list: unexpectedCall},
    PlaylistItems: {list: unexpectedCall, insert: unexpectedCall, remove: unexpectedCall},
    Videos: {list: unexpectedCall},
    Subscriptions: {list: unexpectedCall},
    Search: {list: unexpectedCall}
  });
  const sheet = {
    getLastColumn: () => 7,
    getRange() {
      return {setValue: () => { timestampWrites += 1; }};
    }
  };
  const data = [[], [], [], [
    'PL_TARGET_12345', 'definitely-not-a-valid-date', 0, 0, 'Yes', '', 'UC_SOURCE_12345'
  ]];

  ctx.currentRowStatus = ctx.createRowStatus();
  ctx.playlistWriteOperationsUsed = 0;
  ctx.processPlaylistRow(sheet, data, 3, 'PL_TARGET_12345');

  assert.strictEqual(youtubeCalls, 0);
  assert.strictEqual(ctx.playlistWriteOperationsUsed, 0);
  assert.strictEqual(timestampWrites, 0);
  assert.strictEqual(ctx.currentRowStatus.sourceErrors, 1);
  assert.strictEqual(ctx.currentRowStatus.errorCount, 1);
  assert.strictEqual(ctx.currentRowStatus.timestampUpdated, false);
  assert.ok(ctx.__logs.some(line => line.includes('invalid checkpoint timestamp')));
}

function testAggregateRowFailureDoesNotStopLaterRowCheckpoint() {
  const sourceReads = [];
  const timestampWrites = [];
  let debugRowWriteAttempts = 0;
  let debugSummaryWriteAttempts = 0;
  let lockReleased = false;
  const data = [
    [],
    [],
    ['Playlist ID'],
    ['PL_BROKEN_TARGET_12345', 'invalid-checkpoint', 0, 0, '', '', 'PL_UNUSED_SOURCE_12345'],
    ['PL_HEALTHY_TARGET_12345', '2026-08-20T00:00:00Z', 0, 0, '', '', 'PL_HEALTHY_SOURCE_12345']
  ];

  const sheet = {
    toString: () => 'Sheet',
    getDataRange: () => ({getValues: () => data}),
    getLastRow: () => data.length,
    getLastColumn: () => 7,
    getRange(row, column) {
      if (row === 'A3') return {getValue: () => 'Playlist ID'};
      return {
        getValue: () => data[row - 1][column - 1],
        setValue(value) {
          timestampWrites.push({row, column, value});
        }
      };
    }
  };
  const debugSheet = {
    getRange() {
      return {
        setValue() {
          debugSummaryWriteAttempts += 1;
          throw new Error('simulated DebugData summary outage');
        },
        setValues() {
          debugRowWriteAttempts += 1;
          throw new Error('simulated DebugData row-log outage');
        }
      };
    }
  };
  const debugViewer = {};
  const spreadsheet = {
    getSheets: () => [sheet],
    getSheetByName(name) {
      if (name === 'VideoRetries') return {getDataRange: () => ({getValues: () => [ctx.videoRetryHeaders]})};
      if (name === 'DebugData') return debugSheet;
      if (name === 'Debug') return debugViewer;
      return null;
    }
  };
  const ctx = makeContext({
    PlaylistItems: {
      list(part, options) {
        sourceReads.push(options.playlistId);
        assert.strictEqual(options.playlistId, 'PL_HEALTHY_SOURCE_12345');
        return {items: []};
      }
    }
  });
  ctx.LockService = {
    getScriptLock() {
      return {
        tryLock: () => true,
        releaseLock: () => { lockReleased = true; }
      };
    }
  };
  ctx.PropertiesService = {
    getScriptProperties() {
      return {getProperty: () => 'sheet-id'};
    }
  };
  ctx.SpreadsheetApp = {
    openById(id) {
      assert.strictEqual(id, 'sheet-id');
      return spreadsheet;
    }
  };
  // This test targets row-loop isolation, so keep debug-sheet bookkeeping out
  // of the fixture while leaving the real row processor and checkpoint logic in place.
  ctx.getNextDebugCol = () => 0;
  ctx.getNextDebugRow = () => 0;
  ctx.initDebugEntry = () => {};
  ctx.loadLastDebugLog = () => {};

  assert.throws(
    () => ctx.updatePlaylists(sheet),
    /1 error\(s\) occurred\. Healthy sources were still processed/
  );

  assert.deepStrictEqual(sourceReads, ['PL_HEALTHY_SOURCE_12345'],
    'the later clean row must still be processed after the earlier blocking row failure');
  assert.strictEqual(timestampWrites.length, 1,
    'only the later clean row may advance its checkpoint');
  assert.strictEqual(timestampWrites[0].row, 5);
  assert.strictEqual(timestampWrites[0].column, 2);
  assert.ok(!isNaN(new Date(timestampWrites[0].value).getTime()));
  assert.strictEqual(ctx.totalErrorCount, 1,
    'the earlier row failure must still be reported by the aggregate result');
  assert.strictEqual(ctx.totalWarningCount, 0,
    'auxiliary debug persistence failures must not corrupt playlist-row accounting');
  assert.strictEqual(debugRowWriteAttempts, 2,
    'each configured row should attempt best-effort log persistence');
  assert.strictEqual(debugSummaryWriteAttempts, 1,
    'the aggregate summary should still be attempted after per-row debug failures');
  assert.strictEqual(ctx.currentRowStatus, null,
    'row status must be cleared even when DebugData persistence fails');
  assert.ok(ctx.__logs.some(line =>
    line.includes('Could not persist DebugData logs for row 4')),
  'the first row persistence failure must be re-emitted after later Logger.clear calls');
  assert.ok(ctx.__logs.some(line =>
    line.includes('DEBUG FALLBACK [row 4]:') && line.includes('invalid checkpoint timestamp')),
  'the first row substantive Logger evidence must survive the later row Logger.clear call');
  assert.ok(ctx.__logs.some(line =>
    line.includes('Could not persist DebugData logs for row 5')),
  'the later row persistence failure must remain visible');
  assert.ok(ctx.__logs.some(line =>
    line.includes('Could not finish DebugData execution-summary persistence')),
  'the summary persistence failure must be logged without replacing the aggregate error');
  assert.strictEqual(lockReleased, true, 'the execution lock must be released after the aggregate throw');
}

function testDebugSetupFailuresDoNotBlockValidPlaylistRows() {
  ['creation', 'scan', 'viewer'].forEach(failingStage => {
    const sourceReads = [];
    const timestampWrites = [];
    let debugRowWriteAttempts = 0;
    let debugSummaryWriteAttempts = 0;
    let debugViewerInitAttempts = 0;
    let debugViewerLoadAttempts = 0;
    let lockReleased = false;
    const data = [
      [],
      [],
      ['Playlist ID'],
      ['PL_HEALTHY_TARGET_12345', '2026-08-20T00:00:00Z', 0, 0, '', '', 'PL_HEALTHY_SOURCE_12345']
    ];
    const sheet = {
      toString: () => 'Sheet',
      getDataRange: () => ({getValues: () => data}),
      getLastRow: () => data.length,
      getLastColumn: () => 7,
      getRange(row, column) {
        if (row === 'A3') return {getValue: () => 'Playlist ID'};
        return {
          getValue: () => data[row - 1][column - 1],
          setValue(value) { timestampWrites.push({row, column, value}); }
        };
      }
    };
    const debugSheet = {
      hideSheet() { return this; },
      getRange() {
        return {
          setValues() { debugRowWriteAttempts += 1; },
          setValue() { debugSummaryWriteAttempts += 1; }
        };
      }
    };
    const debugViewer = {};
    const spreadsheet = {
      getSheets: () => [sheet],
      getSheetByName(name) {
        if (name === 'VideoRetries') return {getDataRange: () => ({getValues: () => [ctx.videoRetryHeaders]})};
        if (name === 'DebugData') return failingStage === 'creation' ? null : debugSheet;
        if (name === 'Debug') return debugViewer;
        return null;
      },
      insertSheet(name) {
        assert.strictEqual(name, 'DebugData');
        if (failingStage === 'creation') throw new Error('simulated DebugData creation outage');
        throw new Error('unexpected DebugData creation');
      }
    };
    const ctx = makeContext({
      PlaylistItems: {
        list(part, options) {
          sourceReads.push(options.playlistId);
          assert.strictEqual(options.playlistId, 'PL_HEALTHY_SOURCE_12345');
          return {items: []};
        }
      }
    });
    ctx.LockService = {
      getScriptLock() {
        return {
          tryLock: () => true,
          releaseLock: () => { lockReleased = true; }
        };
      }
    };
    ctx.PropertiesService = {
      getScriptProperties() {
        return {getProperty: () => 'sheet-id'};
      }
    };
    ctx.SpreadsheetApp = {openById: () => spreadsheet};
    ctx.getNextDebugCol = () => {
      if (failingStage === 'scan') throw new Error('simulated DebugData scan outage');
      return 0;
    };
    ctx.getNextDebugRow = () => 0;
    ctx.initDebugEntry = () => {
      debugViewerInitAttempts += 1;
      if (failingStage === 'viewer') throw new Error('simulated Debug viewer outage');
    };
    ctx.loadLastDebugLog = () => { debugViewerLoadAttempts += 1; };

    assert.doesNotThrow(() => ctx.updatePlaylists(sheet),
      failingStage + ' debug setup failure must not escape playlist processing');
    assert.deepStrictEqual(sourceReads, ['PL_HEALTHY_SOURCE_12345']);
    assert.strictEqual(timestampWrites.length, 1,
      failingStage + ' debug setup failure must not block the healthy checkpoint');
    assert.strictEqual(timestampWrites[0].row, 4);
    assert.strictEqual(ctx.totalErrorCount, 0);
    assert.strictEqual(ctx.totalWarningCount, 0,
      'debug setup warnings must stay outside playlist-row accounting');
    assert.strictEqual(ctx.currentRowStatus, null);
    assert.strictEqual(lockReleased, true);

    if (failingStage === 'viewer') {
      assert.strictEqual(debugViewerInitAttempts, 1);
      assert.strictEqual(debugRowWriteAttempts, 1,
        'a broken viewer must not disable a healthy DebugData sheet');
      assert.strictEqual(debugSummaryWriteAttempts, 1);
      assert.strictEqual(debugViewerLoadAttempts, 0,
        'a viewer that failed initialization must not be used after the row loop');
      assert.ok(ctx.__logs.some(line => line.includes('Could not initialize Debug viewer')));
    } else {
      assert.strictEqual(debugViewerInitAttempts, 0,
        'viewer initialization must be skipped when DebugData setup is unavailable');
      assert.strictEqual(debugRowWriteAttempts, 0);
      assert.strictEqual(debugSummaryWriteAttempts, 0);
      assert.ok(ctx.__logs.some(line => line.includes('Could not initialize DebugData persistence')));
      assert.ok(ctx.__logs.some(line =>
        line.includes('DEBUG FALLBACK [row 4]:') && line.includes('Acquired 0 unique videos')),
      'substantive row evidence must fall back to Logger when DebugData setup fails');
    }
  });
}

function testBufferedDebugEvidenceChunksOversizedLines() {
  const ctx = makeContext();
  const rawEvidence = 'substantive-marker:' + 'x'.repeat(10000);
  const prefix = 'DEBUG FALLBACK [row 7]: ';

  ctx.emitBufferedRowDebugEvidence(7, rawEvidence);

  const chunks = ctx.__logs.filter(line => line.startsWith(prefix));
  assert.ok(chunks.length > 1, 'oversized raw evidence must use multiple Logger entries');
  chunks.forEach(line => {
    assert.ok(Buffer.byteLength(line, 'utf8') < 8192,
      'each fallback Logger entry must remain below 8 KiB');
  });
  assert.strictEqual(chunks.map(line => line.substring(prefix.length)).join(''), rawEvidence,
    'chunking must preserve the complete substantive raw log line');
}

function testRowWritesFrozenCutoffCapturedBeforeSourceRead() {
  const initialClockMillis = Date.parse('2026-08-22T10:11:12Z');
  const advancedClockMillis = Date.parse('2026-08-22T12:34:56Z');
  let currentClockMillis = initialClockMillis;
  let noArgumentDateConstructions = 0;
  let sourceReads = 0;
  const timestampWrites = [];
  const ctx = makeContext({
    PlaylistItems: {
      list(part, options) {
        sourceReads += 1;
        assert.strictEqual(noArgumentDateConstructions, 1,
          'row cutoff must be captured before the first source API request');
        assert.strictEqual(options.playlistId, 'PL_FROZEN_CUTOFF_SOURCE');
        currentClockMillis = advancedClockMillis;
        return {items: []};
      }
    }
  });
  class ControlledDate extends Date {
    constructor(...args) {
      if (args.length === 0) {
        super(currentClockMillis);
        noArgumentDateConstructions += 1;
      } else {
        super(...args);
      }
    }
    static now() { return currentClockMillis; }
  }
  ctx.Date = ControlledDate;
  const expectedCutoff = new Date(initialClockMillis).toIsoString();
  const laterTimestamp = new Date(advancedClockMillis).toIsoString();
  const sheet = {
    getLastColumn: () => 7,
    getRange() {
      return {setValue: value => { timestampWrites.push(value); }};
    }
  };
  const data = [[], [], [], [
    'PL_TARGET_12345', '2026-08-20T00:00:00Z', 0, 0, 'Yes', '', 'PL_FROZEN_CUTOFF_SOURCE'
  ]];

  ctx.currentRowStatus = ctx.createRowStatus();
  ctx.processPlaylistRow(sheet, data, 3, 'PL_TARGET_12345');

  assert.strictEqual(sourceReads, 1);
  assert.deepStrictEqual(timestampWrites, [expectedCutoff]);
  assert.notStrictEqual(timestampWrites[0], laterTimestamp,
    'successful checkpoint must not be recomputed from the clock after source reads');
  assert.strictEqual(ctx.currentRowStatus.errorCount, 0);
  assert.strictEqual(ctx.currentRowStatus.timestampUpdated, true);
}

function testExplicitSourceIncludesItemEqualToSecondResolutionCheckpoint() {
  const checkpoint = '2026-08-20T12:34:56Z';
  const calls = [];
  const ctx = makeContext({
    PlaylistItems: {
      list(part, options) {
        calls.push(Object.assign({}, options));
        return {items: [
          {snippet: {publishedAt: '2026-08-20T12:34:55Z', resourceId: {videoId: 'older'}}},
          {snippet: {publishedAt: checkpoint, resourceId: {videoId: 'equal-second'}}}
        ]};
      }
    }
  });
  ctx.currentRowStatus = ctx.createRowStatus();

  assert.deepStrictEqual(Array.from(ctx.getPlaylistVideoIds('PL_EQUALITY_SOURCE', checkpoint)), ['equal-second']);
  assert.strictEqual(calls.length, 1);
  assert.ok(!Object.prototype.hasOwnProperty.call(calls[0], 'pageToken'));
  assert.strictEqual(ctx.currentRowStatus.errorCount, 0);
}

function testUploadsSourceIncludesItemEqualToSecondResolutionCheckpoint() {
  const checkpoint = '2026-08-20T12:34:56Z';
  const playlistCalls = [];
  const ctx = makeContext({
    Channels: {
      list() {
        return {items: [{contentDetails: {relatedPlaylists: {uploads: 'UU_EQUALITY_SOURCE'}}}]};
      }
    },
    PlaylistItems: {
      list(part, options) {
        playlistCalls.push(Object.assign({}, options));
        return {items: [{
          contentDetails: {
            videoId: 'equal-second-upload',
            videoPublishedAt: checkpoint
          }
        }]};
      }
    }
  });
  ctx.currentRowStatus = ctx.createRowStatus();

  assert.deepStrictEqual(
    Array.from(ctx.getVideoIdsWithLessQueries('UC_EQUALITY_SOURCE', checkpoint)),
    ['equal-second-upload']
  );
  assert.strictEqual(playlistCalls.length, 1);
  assert.ok(!Object.prototype.hasOwnProperty.call(playlistCalls[0], 'pageToken'));
  assert.strictEqual(ctx.currentRowStatus.errorCount, 0);
}

function runLaterSourcePage404Scenario(sourceKind) {
  const isExplicit = sourceKind === 'explicit';
  const sourceId = isExplicit ? 'PL_PARTIAL_SOURCE_12345' : 'UC_PARTIAL_SOURCE_12345';
  const uploadsPlaylistId = 'UU_PARTIAL_SOURCE_UPLOADS';
  const targetPlaylistId = 'PL_TARGET_12345';
  const candidate = isExplicit ? 'explicit-page-one-candidate' : 'uploads-page-one-candidate';
  const sourcePageTokens = [];
  const sourcePageTokenPresence = [];
  const inserted = [];
  let timestampWrites = 0;
  const ctx = makeContext({
    Channels: {
      list(part, options) {
        assert.strictEqual(isExplicit, false, 'explicit playlist source must not query Channels.list');
        assert.strictEqual(options.id, sourceId);
        return {items: [{contentDetails: {relatedPlaylists: {uploads: uploadsPlaylistId}}}]};
      }
    },
    PlaylistItems: {
      list(part, options) {
        if (options.playlistId === targetPlaylistId) return {items: []};
        const expectedSourcePlaylist = isExplicit ? sourceId : uploadsPlaylistId;
        assert.strictEqual(options.playlistId, expectedSourcePlaylist);
        sourcePageTokens.push(options.pageToken);
        sourcePageTokenPresence.push(Object.prototype.hasOwnProperty.call(options, 'pageToken'));
        if (!options.pageToken) {
          if (isExplicit) {
            return {
              nextPageToken: 'source-page-2',
              items: [{
                snippet: {
                  publishedAt: '2026-08-21T08:00:00Z',
                  resourceId: {videoId: candidate}
                }
              }]
            };
          }
          return {
            nextPageToken: 'source-page-2',
            items: [{
              contentDetails: {
                videoId: candidate,
                videoPublishedAt: '2026-08-21T08:00:00Z'
              }
            }]
          };
        }

        assert.strictEqual(options.pageToken, 'source-page-2');
        const error = new Error('source disappeared during pagination');
        error.details = {code: 404, errors: [{reason: 'playlistNotFound'}]};
        throw error;
      },
      insert(resource) {
        const videoId = resource.snippet.resourceId.videoId;
        inserted.push(videoId);
        return {id: 'playlist-item-for-' + videoId};
      },
      remove() {}
    },
    Videos: {
      list(part, options) {
        return {items: options.id.split(',').map(id => normalUpload(id, 'PT20M'))};
      }
    }
  });
  const sheet = {
    getLastColumn: () => 7,
    getRange(row, column) {
      return {
        getValue: () => (column === 5 ? 'Yes' : ''),
        setValue: () => { timestampWrites += 1; }
      };
    }
  };
  const data = [[], [], [], [
    targetPlaylistId, '2026-08-20T00:00:00Z', 0, 0, 'Yes', '', sourceId
  ]];

  ctx.currentRowStatus = ctx.createRowStatus();
  ctx.targetPlaylistVideoCache = {};
  ctx.maxPlaylistWriteOperationsPerRun = 20;
  ctx.playlistWriteOperationsUsed = 0;
  ctx.processPlaylistRow(sheet, data, 3, targetPlaylistId);

  return {
    ctx,
    candidate,
    inserted,
    sourcePageTokens,
    sourcePageTokenPresence,
    timestampWrites
  };
}

function assertLaterSourcePage404BlocksCheckpoint(run) {
  assert.deepStrictEqual(run.inserted, [run.candidate],
    'candidates acquired before the page failure must continue through filtering and insertion');
  assert.strictEqual(run.ctx.currentRowStatus.sourceErrors, 1,
    'a 404 after candidates were observed is an incomplete read, not a missing-source warning');
  assert.strictEqual(run.ctx.currentRowStatus.sourceWarnings, 0);
  assert.strictEqual(run.ctx.currentRowStatus.writeErrors, 0);
  assert.strictEqual(run.ctx.currentRowStatus.errorCount, 1);
  assert.strictEqual(run.ctx.currentRowStatus.timestampUpdated, false);
  assert.strictEqual(run.timestampWrites, 0, 'incomplete source pagination must retain the retry checkpoint');
  assert.deepStrictEqual(run.sourcePageTokens, [undefined, 'source-page-2']);
  assert.deepStrictEqual(run.sourcePageTokenPresence, [false, true],
    'initial source playlistItems request must omit pageToken entirely');
}

function testExplicitSourceLaterPage404BlocksCheckpointButKeepsCandidates() {
  assertLaterSourcePage404BlocksCheckpoint(runLaterSourcePage404Scenario('explicit'));
}

function testUploadsSourceLaterPage404BlocksCheckpointButKeepsCandidates() {
  assertLaterSourcePage404BlocksCheckpoint(runLaterSourcePage404Scenario('uploads'));
}

function testMalformedUploadsItemBlocksAndPreventsAllOldEarlyStop() {
  const targetPlaylistId = 'PL_TARGET_12345';
  const sourceChannelId = 'UC_UPLOADS_METADATA_SOURCE';
  const uploadsPlaylistId = 'UU_UPLOADS_METADATA_SOURCE';
  const candidate = 'valid-candidate-from-later-uploads-page';
  const sourcePageTokens = [];
  const sourcePageTokenPresence = [];
  const inserted = [];
  let timestampWrites = 0;
  const ctx = makeContext({
    Channels: {
      list(part, options) {
        assert.strictEqual(options.id, sourceChannelId);
        return {items: [{contentDetails: {relatedPlaylists: {uploads: uploadsPlaylistId}}}]};
      }
    },
    PlaylistItems: {
      list(part, options) {
        if (options.playlistId === targetPlaylistId) return {items: []};
        assert.strictEqual(options.playlistId, uploadsPlaylistId);
        sourcePageTokens.push(options.pageToken);
        sourcePageTokenPresence.push(Object.prototype.hasOwnProperty.call(options, 'pageToken'));
        if (!options.pageToken) {
          return {
            nextPageToken: 'uploads-page-2',
            items: [
              {contentDetails: {videoId: 'old-video', videoPublishedAt: '2026-08-01T00:00:00Z'}},
              {contentDetails: {videoId: 'unknown-publication-video', videoPublishedAt: 'not-a-date'}}
            ]
          };
        }
        assert.strictEqual(options.pageToken, 'uploads-page-2');
        return {items: [{
          contentDetails: {
            videoId: candidate,
            videoPublishedAt: '2026-08-21T08:00:00Z'
          }
        }]};
      },
      insert(resource) {
        const videoId = resource.snippet.resourceId.videoId;
        inserted.push(videoId);
        return {id: 'playlist-item-for-' + videoId};
      },
      remove() {}
    },
    Videos: {
      list(part, options) {
        return {items: options.id.split(',').map(id => normalUpload(id, 'PT20M'))};
      }
    }
  });
  const sheet = {
    getLastColumn: () => 7,
    getRange(row, column) {
      return {
        getValue: () => (column === 5 ? 'Yes' : ''),
        setValue: () => { timestampWrites += 1; }
      };
    }
  };
  const data = [[], [], [], [
    targetPlaylistId, '2026-08-20T00:00:00Z', 0, 0, 'Yes', '', sourceChannelId
  ]];

  ctx.currentRowStatus = ctx.createRowStatus();
  ctx.targetPlaylistVideoCache = {};
  ctx.maxPlaylistWriteOperationsPerRun = 20;
  ctx.playlistWriteOperationsUsed = 0;
  ctx.processPlaylistRow(sheet, data, 3, targetPlaylistId);

  assert.deepStrictEqual(sourcePageTokens, [undefined, 'uploads-page-2']);
  assert.deepStrictEqual(sourcePageTokenPresence, [false, true]);
  assert.deepStrictEqual(inserted, [candidate],
    'unknown publication metadata must force the reader to continue to the later candidate page');
  assert.strictEqual(ctx.currentRowStatus.sourceErrors, 1);
  assert.strictEqual(ctx.currentRowStatus.errorCount, 1);
  assert.strictEqual(ctx.currentRowStatus.timestampUpdated, false);
  assert.strictEqual(timestampWrites, 0);
  assert.ok(ctx.__logs.some(line => line.includes('incomplete publication metadata')));
}

function runExperimentSourcePage404Scenario(kind, failurePage, messageOnly) {
  const candidate = 'candidate-from-page-one';
  const playlistCalls = [];
  const source = {
    value: kind === 'uploads' ? 'UC_EXPERIMENT_SOURCE' : 'PL_EXPERIMENT_SOURCE',
    column: 7,
    hash: 'sha256:experiment-source'
  };
  const sourcePlaylistId = kind === 'uploads' ? 'UU_EXPERIMENT_SOURCE' : source.value;
  const ctx = makeExperimentContext({
    Channels: {
      list(part, options) {
        assert.strictEqual(kind, 'uploads');
        assert.strictEqual(part, 'contentDetails');
        assert.strictEqual(options.id, source.value);
        return {items: [{contentDetails: {relatedPlaylists: {uploads: sourcePlaylistId}}}]};
      }
    },
    PlaylistItems: {
      list(part, options) {
        assert.strictEqual(options.playlistId, sourcePlaylistId);
        playlistCalls.push(Object.assign({}, options));
        if (failurePage === 1 || options.pageToken) {
          const error = new Error(messageOnly
            ? "API call failed: The playlist identified with the request's playlistId parameter cannot be found."
            : 'source playlist not found');
          if (!messageOnly) {
            error.details = {code: 404, errors: [{reason: 'playlistNotFound'}]};
          }
          throw error;
        }
        if (kind === 'uploads') {
          return {
            nextPageToken: 'page-2',
            items: [{contentDetails: {
              videoId: candidate,
              videoPublishedAt: '2026-08-21T08:00:00Z'
            }}]
          };
        }
        return {
          nextPageToken: 'page-2',
          items: [{snippet: {
            publishedAt: '2026-08-21T08:00:00Z',
            resourceId: {videoId: candidate}
          }}]
        };
      }
    }
  });
  const state = ctx.experimentState_();
  const checkpointMillis = new Date('2026-08-20T00:00:00Z').getTime();
  const ids = kind === 'uploads'
    ? ctx.experimentReadChannelVideos_(source.value, checkpointMillis, source, state)
    : ctx.experimentReadSourcePlaylistVideos_(source.value, checkpointMillis, source, state);
  return {candidate, ids: Array.from(ids), playlistCalls, state};
}

function testExperimentFirstPageMissingWarnsForUploadsAndExplicit() {
  ['uploads', 'explicit'].forEach(kind => {
    const run = runExperimentSourcePage404Scenario(kind, 1);
    assert.deepStrictEqual(run.ids, []);
    assert.strictEqual(run.playlistCalls.length, 1);
    assert.ok(!Object.prototype.hasOwnProperty.call(run.playlistCalls[0], 'pageToken'));
    assert.strictEqual(run.state.warningCount, 1);
    assert.strictEqual(run.state.blockingErrorCount, 0);
    assert.strictEqual(run.state.issues[0].severity, 'warning');
    assert.strictEqual(run.state.issues[0].apiCode, 404);
    assert.strictEqual(run.state.issues[0].apiReason, 'playlistNotFound');
  });

  const messageOnly = runExperimentSourcePage404Scenario('uploads', 1, true);
  assert.deepStrictEqual(messageOnly.ids, []);
  assert.strictEqual(messageOnly.state.warningCount, 1,
    'Apps Script message-only playlistNotFound errors must match production classification');
  assert.strictEqual(messageOnly.state.blockingErrorCount, 0);
  assert.strictEqual(messageOnly.state.issues[0].severity, 'warning');
  assert.ok(!Object.prototype.hasOwnProperty.call(messageOnly.state.issues[0], 'apiCode'));
  assert.ok(!Object.prototype.hasOwnProperty.call(messageOnly.state.issues[0], 'apiReason'));
}

function testExperimentLaterPageMissingBlocksForUploadsAndExplicit() {
  ['uploads', 'explicit'].forEach(kind => {
    const run = runExperimentSourcePage404Scenario(kind, 2);
    assert.deepStrictEqual(run.ids, [run.candidate],
      'the helper must retain candidates acquired before a later-page failure');
    assert.strictEqual(run.playlistCalls.length, 2);
    assert.ok(!Object.prototype.hasOwnProperty.call(run.playlistCalls[0], 'pageToken'));
    assert.strictEqual(run.playlistCalls[1].pageToken, 'page-2');
    assert.strictEqual(run.state.warningCount, 0);
    assert.strictEqual(run.state.blockingErrorCount, 1);
    assert.strictEqual(run.state.issues[0].severity, 'error');
    assert.strictEqual(run.state.issues[0].apiCode, 404);
    assert.strictEqual(run.state.issues[0].apiReason, 'playlistNotFound');
  });
}

function testExperimentAllSubscriptionFailuresAndMalformedItemsAreBlocking() {
  const allSource = {value: 'ALL', column: 7, hash: 'sha256:all-source'};

  const firstPageContext = makeExperimentContext({
    Subscriptions: {
      list() {
        const error = new Error('subscription list unexpectedly not found');
        error.details = {code: 404, errors: [{reason: 'playlistNotFound'}]};
        throw error;
      }
    }
  });
  const firstPageState = firstPageContext.experimentState_();
  assert.deepStrictEqual(
    Array.from(firstPageContext.experimentReadSubscriptionIds_(allSource, firstPageState)),
    []
  );
  assert.strictEqual(firstPageState.warningCount, 0,
    'ALL subscription failures must never use the configured-source missing warning');
  assert.strictEqual(firstPageState.blockingErrorCount, 1);
  assert.strictEqual(firstPageState.issues[0].reason, 'subscriptions_read_failed');
  assert.strictEqual(firstPageState.issues[0].severity, 'error');
  assert.strictEqual(firstPageState.issues[0].apiCode, 404);

  let subscriptionPage = 0;
  const laterPageOptions = [];
  const laterPageContext = makeExperimentContext({
    Subscriptions: {
      list(part, options) {
        subscriptionPage += 1;
        laterPageOptions.push(Object.assign({}, options));
        if (subscriptionPage === 1) {
          return {
            nextPageToken: 'subscriptions-page-2',
            items: [{snippet: {resourceId: {channelId: 'UC_VALID_FROM_PAGE_ONE'}}}]
          };
        }
        const error = new Error('later subscription page not found');
        error.details = {code: 404, errors: [{reason: 'playlistNotFound'}]};
        throw error;
      }
    }
  });
  const laterPageState = laterPageContext.experimentState_();
  assert.deepStrictEqual(
    Array.from(laterPageContext.experimentReadSubscriptionIds_(allSource, laterPageState)),
    ['UC_VALID_FROM_PAGE_ONE'],
    'valid subscription IDs collected before a later-page failure must be preserved'
  );
  assert.strictEqual(laterPageOptions.length, 2);
  assert.ok(!Object.prototype.hasOwnProperty.call(laterPageOptions[0], 'pageToken'));
  assert.strictEqual(laterPageOptions[1].pageToken, 'subscriptions-page-2');
  assert.strictEqual(laterPageState.warningCount, 0);
  assert.strictEqual(laterPageState.blockingErrorCount, 1,
    'an incomplete later subscription page must retain the checkpoint');
  assert.strictEqual(laterPageState.issues[0].severity, 'error');

  const malformedItemContext = makeExperimentContext({
    Subscriptions: {
      list() {
        return {items: [
          {snippet: {resourceId: {channelId: 'UC_VALID_BESIDE_MALFORMED'}}},
          {snippet: {resourceId: {}}}
        ]};
      }
    }
  });
  const malformedItemState = malformedItemContext.experimentState_();
  assert.deepStrictEqual(
    Array.from(malformedItemContext.experimentReadSubscriptionIds_(allSource, malformedItemState)),
    ['UC_VALID_BESIDE_MALFORMED'],
    'a malformed item must not discard valid subscription IDs from the same page'
  );
  assert.strictEqual(malformedItemState.warningCount, 0);
  assert.strictEqual(malformedItemState.blockingErrorCount, 1);
  assert.strictEqual(malformedItemState.issues[0].severity, 'error');
  assert.strictEqual(malformedItemState.issues[0].stage, 'source');
  assert.strictEqual(malformedItemState.issues[0].reason, 'subscription_item_metadata_invalid');
}

function testExperimentMissingTargetReadIsBlocking() {
  const ctx = makeExperimentContext({
    PlaylistItems: {
      list() {
        const error = new Error('target playlist not found');
        error.details = {code: 404, errors: [{reason: 'playlistNotFound'}]};
        throw error;
      }
    }
  });
  const state = ctx.experimentState_();
  const result = ctx.experimentReadTargetVideoSet_('PL_TARGET', state);

  assert.strictEqual(result.ok, false);
  assert.strictEqual(state.warningCount, 0);
  assert.strictEqual(state.blockingErrorCount, 1);
  assert.strictEqual(state.issues[0].severity, 'error');
  assert.strictEqual(state.issues[0].stage, 'target');
  assert.strictEqual(state.issues[0].reason, 'target_playlist_read_failed');
  assert.strictEqual(state.issues[0].apiCode, 404);
  assert.strictEqual(state.issues[0].apiReason, 'playlistNotFound');
}

function testExperimentMalformedTargetItemBlocksReplayCheckpoint() {
  const targetPlaylistId = 'PL_MALFORMED_TARGET';
  const rows = {
    4: [targetPlaylistId, '2026-08-20T00:00:00Z', '', '', 'Yes', '', '']
  };

  function cellValue(row, column) {
    const values = rows[row] || [];
    return values[column - 1] === undefined ? '' : values[column - 1];
  }

  const sheet = {
    getLastRow: () => 4,
    getLastColumn: () => 7,
    getRange(row, column, numRows, numColumns) {
      const height = numRows || 1;
      const width = numColumns || 1;
      return {
        getValues: () => Array.from({length: height}, (_, rowOffset) =>
          Array.from({length: width}, (_, columnOffset) =>
            cellValue(row + rowOffset, column + columnOffset))),
        getDisplayValues: () => Array.from({length: height}, (_, rowOffset) =>
          Array.from({length: width}, (_, columnOffset) =>
            String(cellValue(row + rowOffset, column + columnOffset)))),
        getFormulas: () => Array.from({length: height}, () =>
          Array.from({length: width}, () => ''))
      };
    }
  };
  const utilities = {
    DigestAlgorithm: {SHA_256: 'SHA_256'},
    Charset: {UTF_8: 'UTF_8'},
    computeDigest(algorithm, text, charset) {
      assert.strictEqual(algorithm, 'SHA_256');
      assert.strictEqual(charset, 'UTF_8');
      return Array.from(crypto.createHash('sha256').update(String(text), 'utf8').digest(), value =>
        value > 127 ? value - 256 : value);
    }
  };
  const ctx = makeExperimentContext({
    PlaylistItems: {
      list(part, options) {
        assert.strictEqual(part, 'contentDetails');
        assert.strictEqual(options.playlistId, targetPlaylistId);
        return {items: [
          {contentDetails: {videoId: 'known-valid-target-member'}},
          {contentDetails: {}}
        ]};
      }
    }
  }, {Utilities: utilities});

  const result = ctx.replayStrictDryRun(4, sheet);

  assert.strictEqual(result.targetReadComplete, false,
    'an unidentifiable target item makes the inventory incomplete');
  assert.strictEqual(result.blockingErrorCount, 1);
  assert.strictEqual(result.warningCount, 0);
  assert.strictEqual(result.checkpointWouldAdvance, false,
    'a malformed target item must retain the replay checkpoint');
  assert.strictEqual(result.alreadyPresentIds, null);
  assert.strictEqual(result.wouldInsertIds, null);
  assert.strictEqual(result.issues[0].severity, 'error');
  assert.strictEqual(result.issues[0].stage, 'target');
  assert.strictEqual(result.issues[0].reason, 'target_playlist_item_metadata_invalid');
}

function testExperimentReplayRejectsKnownBroadcastsWithoutBlockingCheckpoint() {
  const targetPlaylistId = 'PL_REPLAY_TARGET';
  const sourcePlaylistId = 'PL_REPLAY_SOURCE';
  const candidateIds = ['replay-upcoming', 'replay-active'];
  const rows = {
    4: [targetPlaylistId, '2026-08-20T00:00:00Z', '', '', 'Yes', '', sourcePlaylistId]
  };
  function cellValue(row, column) {
    const values = rows[row] || [];
    return values[column - 1] === undefined ? '' : values[column - 1];
  }
  const sheet = {
    getLastRow: () => 4,
    getLastColumn: () => 7,
    getRange(row, column, numRows, numColumns) {
      const height = numRows || 1;
      const width = numColumns || 1;
      return {
        getValues: () => Array.from({length: height}, (_, rowOffset) =>
          Array.from({length: width}, (_, columnOffset) =>
            cellValue(row + rowOffset, column + columnOffset))),
        getDisplayValues: () => Array.from({length: height}, (_, rowOffset) =>
          Array.from({length: width}, (_, columnOffset) =>
            String(cellValue(row + rowOffset, column + columnOffset)))),
        getFormulas: () => Array.from({length: height}, () =>
          Array.from({length: width}, () => ''))
      };
    }
  };
  const utilities = {
    DigestAlgorithm: {SHA_256: 'SHA_256'},
    Charset: {UTF_8: 'UTF_8'},
    computeDigest(algorithm, text, charset) {
      assert.strictEqual(algorithm, 'SHA_256');
      assert.strictEqual(charset, 'UTF_8');
      return Array.from(crypto.createHash('sha256').update(String(text), 'utf8').digest(), value =>
        value > 127 ? value - 256 : value);
    }
  };
  const ctx = makeExperimentContext({
    PlaylistItems: {
      list(part, options) {
        if (options.playlistId === sourcePlaylistId) {
          assert.strictEqual(part, 'snippet');
          return {items: candidateIds.map((videoId, index) => ({snippet: {
            publishedAt: '2026-08-21T0' + (index + 8) + ':00:00Z',
            resourceId: {videoId}
          }}))};
        }
        if (options.playlistId === targetPlaylistId) {
          assert.strictEqual(part, 'contentDetails');
          return {items: []};
        }
        throw new Error('unexpected replay playlist lookup ' + options.playlistId);
      }
    },
    Videos: {
      list() {
        return {items: [
          {
            id: candidateIds[0],
            snippet: {liveBroadcastContent: 'upcoming'},
            contentDetails: {duration: 'P0D'},
            liveStreamingDetails: {scheduledStartTime: '2026-08-22T16:00:00Z'}
          },
          {
            id: candidateIds[1],
            snippet: {liveBroadcastContent: 'live'},
            contentDetails: {duration: 'P0D'},
            liveStreamingDetails: {actualStartTime: '2026-08-21T20:00:00Z'}
          }
        ]};
      }
    }
  }, {Utilities: utilities});

  const result = ctx.replayStrictDryRun(4, sheet);

  assert.deepStrictEqual(Array.from(result.acquiredCandidateIds), candidateIds);
  assert.deepStrictEqual(Array.from(result.keptCandidateIds), []);
  assert.deepStrictEqual(
    Array.from(result.rejectedCandidates, candidate => candidate.reason),
    [
      'upcoming_broadcast_rejected_by_strict_policy',
      'active_broadcast_rejected_by_strict_policy'
    ]
  );
  assert.deepStrictEqual(Array.from(result.withheldCandidates), []);
  assert.strictEqual(result.blockingErrorCount, 0);
  assert.strictEqual(result.checkpointWouldAdvance, true,
    'known broadcasts are permanent strict rejections, not retryable metadata failures');
  assert.strictEqual(result.targetReadComplete, true);
  assert.deepStrictEqual(Array.from(result.wouldInsertIds), []);
}

function testExperimentVideoMetadata404IsBlocking() {
  const ctx = makeExperimentContext({
    Videos: {
      list() {
        const error = new Error('video metadata not found');
        error.details = {code: 404, errors: [{reason: 'videoNotFound'}]};
        throw error;
      }
    }
  });
  const state = ctx.experimentState_();
  const result = ctx.experimentClassifyStrict_(['missing-video'], false, state);

  assert.deepStrictEqual(Array.from(result.kept), []);
  assert.deepStrictEqual(Array.from(result.rejected), []);
  assert.strictEqual(result.withheld.length, 1);
  assert.strictEqual(result.withheld[0].reason, 'metadata_batch_failed');
  assert.strictEqual(state.warningCount, 0);
  assert.strictEqual(state.blockingErrorCount, 1);
  assert.strictEqual(state.issues[0].severity, 'error');
  assert.strictEqual(state.issues[0].stage, 'filter');
  assert.strictEqual(state.issues[0].apiCode, 404);
  assert.strictEqual(state.issues[0].apiReason, 'videoNotFound');
}

function testExperimentVideoMetadataBatchesOmitUnsupportedMaxResults() {
  const ids = Array.from({length: 101}, (_, index) => 'experiment-video-' + index);
  const calls = [];
  const ctx = makeExperimentContext({
    Videos: {
      list(part, options) {
        calls.push({part, options: Object.assign({}, options)});
        return {items: options.id.split(',').map(id => normalUpload(id, 'PT10M'))};
      }
    }
  });
  const state = ctx.experimentState_();
  const result = ctx.experimentClassifyStrict_(ids, false, state);

  assert.deepStrictEqual(Array.from(result.kept), ids);
  assert.deepStrictEqual(calls.map(call => call.options.id.split(',').length), [50, 50, 1],
    'experiment metadata requests must still batch at no more than 50 IDs');
  calls.forEach(call => {
    assert.strictEqual(call.part, 'snippet,contentDetails,liveStreamingDetails');
    assert.ok(!Object.prototype.hasOwnProperty.call(call.options, 'maxResults'),
      'Videos.list with an id filter must omit unsupported maxResults');
  });
  assert.strictEqual(state.warningCount, 0);
  assert.strictEqual(state.blockingErrorCount, 0);
}

function testCleanupFailureWarnsButDoesNotFreezeIngestionCheckpoint() {
  let timestampWrites = 0;
  const ctx = makeContext({
    PlaylistItems: {
      list() {
        const error = new Error('temporary cleanup failure');
        error.details = {code: 503, errors: [{reason: 'backendError'}]};
        throw error;
      }
    }
  });
  const sheet = {
    getLastColumn: () => 6,
    getRange(row, column) {
      return {
        getValue: () => (column === 5 || column === 6 ? 'Yes' : ''),
        setValue: () => { timestampWrites += 1; }
      };
    }
  };
  const data = [[], [], [], [
    'PL_TARGET_12345', '2026-07-20T00:00:00Z', 0, 30, 'Yes', 'Yes'
  ]];

  ctx.currentRowStatus = ctx.createRowStatus();
  ctx.processPlaylistRow(sheet, data, 3, 'PL_TARGET_12345');

  assert.strictEqual(ctx.currentRowStatus.maintenanceWarnings, 1);
  assert.strictEqual(ctx.currentRowStatus.errorCount, 0);
  assert.strictEqual(timestampWrites, 1, 'independent cleanup failures must not freeze ingestion');
  assert.strictEqual(ctx.currentRowStatus.timestampUpdated, true);
}
function normalUpload(id, duration) {
  return {
    id,
    snippet: {liveBroadcastContent: 'none'},
    contentDetails: {duration: duration || 'PT10M'}
  };
}

function completedBroadcast(id, duration, actualStartTime, actualEndTime) {
  return {
    id,
    snippet: {liveBroadcastContent: 'none'},
    contentDetails: {duration},
    liveStreamingDetails: {actualStartTime, actualEndTime}
  };
}

function strictFilterSheet(shortsSetting) {
  return {
    getRange(row, column) {
      assert.strictEqual(column, 5, 'strict ingestion must not consult the column-F duration heuristic');
      return {getValue: () => shortsSetting || 'Yes'};
    }
  };
}

function testStrictClassificationOracle() {
  const ctx = makeContext();
  assert.strictEqual(
    ctx.classifyVideoStrict(normalUpload('long-upload', 'PT12H')),
    'NORMAL_UPLOAD',
    'duration alone must never turn an ordinary upload into a livestream'
  );
  assert.strictEqual(ctx.classifyVideoStrict({
    id: 'scheduled',
    snippet: {liveBroadcastContent: 'upcoming'},
    contentDetails: {duration: 'P0D'},
    liveStreamingDetails: {scheduledStartTime: '2026-08-23T16:00:00Z'}
  }), 'UPCOMING');
  assert.strictEqual(ctx.classifyVideoStrict({
    id: 'live-now',
    snippet: {liveBroadcastContent: 'live'},
    contentDetails: {duration: 'P0D'},
    liveStreamingDetails: {actualStartTime: '2026-08-21T18:00:00Z'}
  }), 'ACTIVE');
  assert.strictEqual(ctx.classifyVideoStrict({
    id: 'short-archive',
    snippet: {liveBroadcastContent: 'none'},
    contentDetails: {duration: 'PT12M'},
    liveStreamingDetails: {
      actualStartTime: '2026-08-20T18:00:00Z',
      actualEndTime: '2026-08-20T18:12:00Z'
    }
  }), 'COMPLETED_LIVE');
  assert.strictEqual(ctx.classifyVideoStrict({
    id: 'long-archive',
    snippet: {liveBroadcastContent: 'none'},
    contentDetails: {duration: 'PT6H9M41S'},
    liveStreamingDetails: {
      actualStartTime: '2026-08-17T10:00:00Z',
      actualEndTime: '2026-08-17T16:09:41Z'
    }
  }), 'COMPLETED_LIVE');
  assert.strictEqual(ctx.classifyVideoStrict({
    id: 'empty-live-details',
    snippet: {liveBroadcastContent: 'none'},
    contentDetails: {duration: 'PT59M12S'},
    liveStreamingDetails: {}
  }), 'COMPLETED_LIVE', 'presence of even an empty liveStreamingDetails object is a broadcast marker');
  assert.strictEqual(ctx.classifyVideoStrict({
    id: 'malformed-state',
    snippet: {liveBroadcastContent: 'premiere-ish'},
    contentDetails: {duration: 'PT20M'}
  }), 'UNKNOWN');
  assert.strictEqual(ctx.classifyVideoStrict({
    id: 'missing-state',
    snippet: {},
    contentDetails: {duration: 'PT20M'}
  }), 'UNKNOWN');
}

function testStrictAdmissionRejectsEveryKnownBroadcastWithoutDurationException() {
  const ctx = makeContext();
  const cases = [
    [normalUpload('ordinary-long', 'PT10H'), true, false, 'normal_upload'],
    [normalUpload('over-hard-limit', 'PT12H'), false, false, 'over_10_hour_hard_limit'],
    [{id: 'scheduled', snippet: {liveBroadcastContent: 'upcoming'}}, false, false,
      'upcoming_broadcast_rejected_by_strict_policy'],
    [{id: 'active', snippet: {liveBroadcastContent: 'live'}}, false, false,
      'active_broadcast_rejected_by_strict_policy'],
    [completedBroadcast(
      'short-completed', 'PT1M', '2026-08-20T10:00:00Z', '2026-08-20T10:01:00Z'
    ), false, false, 'completed_broadcast_rejected_by_strict_policy'],
    [completedBroadcast(
      'long-completed', 'PT12H', '2026-08-20T10:00:00Z', '2026-08-20T22:00:00Z'
    ), false, false, 'completed_broadcast_rejected_by_strict_policy'],
    [{id: 'unknown', snippet: {liveBroadcastContent: 'unexpected'}}, false, true,
      'live_state_missing_or_unknown']
  ];

  cases.forEach(([item, allowed, blocking, reason]) => {
    const decision = ctx.evaluateVideoAdmissionPolicy(item);
    assert.strictEqual(decision.allowed, allowed, item.id);
    assert.strictEqual(decision.blocking, blocking, item.id);
    assert.strictEqual(decision.reason, reason, item.id);
    assert.strictEqual(Object.prototype.hasOwnProperty.call(decision, 'effectiveDurationSeconds'), false,
      'strict admission must not consult duration: ' + item.id);
  });
}

function testStrictCompletedBroadcastGoldenCorpusIsUniformlyRejected() {
  const ctx = makeContext();
  const corpus = [
    completedBroadcast(
      'CkmIANn_xZY',
      'PT1H8M1S',
      '2026-08-20T19:00:06Z',
      '2026-08-20T20:09:06Z'
    ),
    completedBroadcast(
      'SE7aCzUaUdY',
      'PT7H1M43S',
      '2026-08-20T10:00:00Z',
      '2026-08-20T17:11:48Z'
    ),
    completedBroadcast(
      'Knnm5_rG89E',
      'PT8H55M12S',
      '2026-08-20T10:00:00Z',
      '2026-08-20T19:02:32Z'
    )
  ];

  const decisions = corpus.map(item => ctx.evaluateVideoAdmissionPolicy(item));

  assert.deepStrictEqual(decisions.map(decision => decision.allowed), [false, false, false]);
  assert.deepStrictEqual(decisions.map(decision => decision.blocking), [false, false, false]);
  assert.deepStrictEqual(
    decisions.map(decision => decision.reason),
    [
      'completed_broadcast_rejected_by_strict_policy',
      'completed_broadcast_rejected_by_strict_policy',
      'completed_broadcast_rejected_by_strict_policy'
    ]
  );
  decisions.forEach(decision => {
    assert.strictEqual(decision.classification, 'COMPLETED_LIVE');
    assert.strictEqual(decision.admissionClass, 'COMPLETED_LIVE');
  });
}

function testStrictYoutubeTimestampGrammarAndExperimentParity() {
  const production = makeContext();
  const experimentOnly = makeExperimentOnlyContext();
  const validCases = [
    ['2026-08-20T10:00:00Z', Date.UTC(2026, 7, 20, 10, 0, 0)],
    [
      '2024-02-29T23:59:59.123456789+02:30',
      Date.UTC(2024, 1, 29, 21, 29, 59) + 123.456789
    ],
    ['2026-08-20T10:00:00-05:45', Date.UTC(2026, 7, 20, 15, 45, 0)],
    ['2026-08-20T10:00:00+14:00', Date.UTC(2026, 7, 19, 20, 0, 0)]
  ];
  validCases.forEach(([timestamp, expected]) => {
    const productionMillis = production.parseApiTimestampMillis(timestamp);
    const fallbackMillis = experimentOnly.experimentTimestampMillis_(timestamp);
    assert.ok(Math.abs(productionMillis - expected) < 0.001, timestamp);
    assert.strictEqual(fallbackMillis, productionMillis, 'standalone replay parser parity: ' + timestamp);
  });

  const invalidCases = [
    '2026-08-20 10:00:00',
    '2026-08-20T10:00:00',
    '2026-08-20',
    'Thu, 20 Aug 2026 10:00:00 GMT',
    '2026-02-30T00:00:00Z',
    '2025-02-29T00:00:00Z',
    '2026-08-20T24:00:00Z',
    '2026-08-20T10:60:00Z',
    '2026-08-20T10:00:60Z',
    '2026-08-20T10:00:00+14:01',
    '2026-08-20T10:00:00+24:00',
    '2026-08-20T10:00:00-00:00',
    '2026-08-20T10:00:00z'
  ];
  invalidCases.forEach(timestamp => {
    assert.strictEqual(production.parseApiTimestampMillis(timestamp), null, timestamp);
    assert.strictEqual(
      experimentOnly.experimentTimestampMillis_(timestamp),
      null,
      'standalone replay must reject ' + timestamp
    );
  });

  const malformedTimeCandidate = completedBroadcast(
    'malformed-api-time',
    'PT1H',
    '2026-02-30T10:00:00Z',
    '2026-03-02T11:00:00Z'
  );
  const productionDecision = JSON.parse(JSON.stringify(
    production.evaluateVideoAdmissionPolicy(malformedTimeCandidate)
  ));
  const fallbackDecision = JSON.parse(JSON.stringify(
    experimentOnly.experimentAdmissionDecision_(malformedTimeCandidate)
  ));
  assert.strictEqual(productionDecision.allowed, false);
  assert.strictEqual(productionDecision.blocking, false,
    'known completed broadcasts are rejected independently of timestamp quality');
  assert.strictEqual(productionDecision.reason, 'completed_broadcast_rejected_by_strict_policy');
  assert.deepStrictEqual(fallbackDecision, productionDecision);
}

function testStrictFilterUsesSharedAdmissionDecision() {
  const ids = [
    'long-upload',
    'scheduled',
    'live-now',
    'short-archive',
    'long-archive',
    'empty-live-details'
  ];
  let requestedPart = '';
  let listCalls = 0;
  const ctx = makeContext({
    Videos: {
      list(part, options) {
        requestedPart = part;
        listCalls += 1;
        assert.deepStrictEqual(options.id.split(','), ids);
        return {items: [
          normalUpload(ids[0], 'PT10H'),
          {
            id: ids[1],
            snippet: {liveBroadcastContent: 'upcoming'},
            contentDetails: {duration: 'P0D'},
            liveStreamingDetails: {scheduledStartTime: '2026-08-23T16:00:00Z'}
          },
          {
            id: ids[2],
            snippet: {liveBroadcastContent: 'live'},
            contentDetails: {duration: 'P0D'},
            liveStreamingDetails: {actualStartTime: '2026-08-21T18:00:00Z'}
          },
          {
            id: ids[3],
            snippet: {liveBroadcastContent: 'none'},
            contentDetails: {duration: 'PT12M'},
            liveStreamingDetails: {
              actualStartTime: '2026-08-20T18:00:00Z',
              actualEndTime: '2026-08-20T18:12:00Z'
            }
          },
          {
            id: ids[4],
            snippet: {liveBroadcastContent: 'none'},
            contentDetails: {duration: 'PT6H9M41S'},
            liveStreamingDetails: {
              actualStartTime: '2026-08-17T10:00:00Z',
              actualEndTime: '2026-08-17T16:09:41Z'
            }
          },
          {
            id: ids[5],
            snippet: {liveBroadcastContent: 'none'},
            contentDetails: {duration: 'PT59M12S'},
            liveStreamingDetails: {}
          }
        ]};
      }
    }
  });
  ctx.currentRowStatus = ctx.createRowStatus();
  const result = Array.from(ctx.applyFilters(ids, strictFilterSheet('Yes'), 3));

  assert.deepStrictEqual(result, ['long-upload']);
  assert.strictEqual(listCalls, 1);
  assert.ok(requestedPart.includes('snippet'));
  assert.ok(requestedPart.includes('contentDetails'));
  assert.ok(requestedPart.includes('liveStreamingDetails'));
  assert.strictEqual(ctx.currentRowStatus.filterErrors, 0,
    'all known broadcast states are nonblocking strict rejections');
  assert.ok(ctx.__logs.some(line =>
    line.includes('completed_broadcast_rejected_by_strict_policy') && line.includes('short-archive')));
}

function testCompletedBroadcastEvidenceQualityDoesNotCreateAnAdmissionException() {
  const cases = [
    completedBroadcast('missing-duration', undefined, '2026-08-20T10:00:00Z', '2026-08-20T10:30:00Z'),
    completedBroadcast('zero-duration', 'PT0S', '2026-08-20T10:00:00Z', '2026-08-20T10:30:00Z'),
    completedBroadcast('malformed-duration', '90 minutes', '2026-08-20T10:00:00Z', '2026-08-20T10:30:00Z'),
    completedBroadcast('missing-end', 'PT30M', '2026-08-20T10:00:00Z', undefined),
    completedBroadcast('reversed-times', 'PT30M', '2026-08-20T10:30:00Z', '2026-08-20T10:00:00Z')
  ];
  const ctx = makeContext({Videos: {list() { return {items: cases}; }}});
  ctx.currentRowStatus = ctx.createRowStatus();

  assert.deepStrictEqual(
    Array.from(ctx.applyFilters(cases.map(item => item.id), strictFilterSheet('Yes'), 3)),
    []
  );
  assert.strictEqual(ctx.currentRowStatus.filterErrors, 0);
  assert.strictEqual(ctx.currentRowStatus.errorCount, 0,
    'documented broadcast markers are sufficient for a permanent strict rejection');
}

function testConstructorVideoIdSurvivesDedupeAndStrictFilter() {
  const requestedIds = [];
  const ctx = makeContext({
    Videos: {
      list(part, options) {
        requestedIds.push(options.id);
        return {items: [normalUpload('constructor', 'PT20M')]};
      }
    }
  });
  ctx.currentRowStatus = ctx.createRowStatus();

  assert.deepStrictEqual(
    Array.from(ctx.dedupeVideoIds(['constructor', 'constructor', 'ordinary-id'])),
    ['constructor', 'ordinary-id'],
    'an inherited Object.prototype key is still a valid first-seen video ID'
  );
  assert.deepStrictEqual(
    Array.from(ctx.applyFilters(['constructor'], strictFilterSheet('Yes'), 3)),
    ['constructor'],
    'strict metadata indexing must retain a normal upload whose ID is an inherited property name'
  );
  assert.deepStrictEqual(requestedIds, ['constructor']);
  assert.strictEqual(ctx.currentRowStatus.filterErrors, 0);
  assert.strictEqual(ctx.currentRowStatus.errorCount, 0);
}

function testUnknownMetadataIsFailClosedAndBlocksCheckpoint() {
  const ids = ['malformed-state', 'missing-state'];
  const ctx = makeContext({
    Videos: {
      list() {
        return {items: [
          {
            id: ids[0],
            snippet: {liveBroadcastContent: 'premiere-ish'},
            contentDetails: {duration: 'PT20M'}
          },
          {
            id: ids[1],
            snippet: {},
            contentDetails: {duration: 'PT20M'}
          }
        ]};
      }
    }
  });
  ctx.currentRowStatus = ctx.createRowStatus();

  assert.deepStrictEqual(Array.from(ctx.applyFilters(ids, strictFilterSheet('Yes'), 3)), []);
  assert.strictEqual(ctx.currentRowStatus.filterErrors, 2);
  assert.strictEqual(ctx.currentRowStatus.errorCount, 2);
}

function testSuccessfulMetadataResponseOmissionIsWithheld() {
  const ctx = makeContext({
    Videos: {
      list() {
        return {items: [normalUpload('returned-upload', 'PT20M')]};
      }
    }
  });
  ctx.currentRowStatus = ctx.createRowStatus();

  const result = Array.from(ctx.applyFilters(
    ['returned-upload', 'omitted-video'],
    strictFilterSheet('Yes'),
    3
  ));

  assert.deepStrictEqual(result, ['returned-upload']);
  assert.strictEqual(ctx.currentRowStatus.filterErrors, 1, 'an omitted requested ID must retain the retry checkpoint');
  assert.strictEqual(ctx.currentRowStatus.errorCount, 1);
  assert.ok(ctx.__logs.some(line => line.includes('omitted-video')));
}

function testStrictShortFilterRemainsIndependent() {
  const ids = ['ordinary-short', 'ordinary-video', 'premiere-like-short', 'premiere-like-video'];
  const ctx = makeContext({
    Videos: {
      list() {
        return {items: [
          normalUpload(ids[0], 'PT2M'),
          normalUpload(ids[1], 'PT10M'),
          completedBroadcast(ids[2], 'PT2M', '2026-08-20T10:00:00Z', '2026-08-20T10:02:00Z'),
          completedBroadcast(ids[3], 'PT10M', '2026-08-20T10:00:00Z', '2026-08-20T10:10:00Z')
        ]};
      }
    }
  });
  ctx.currentRowStatus = ctx.createRowStatus();

  assert.deepStrictEqual(
    Array.from(ctx.applyFilters(ids, strictFilterSheet('No'), 3)),
    ['ordinary-video']
  );
  assert.strictEqual(ctx.currentRowStatus.filterErrors, 0);

  ctx.currentRowStatus = ctx.createRowStatus();
  assert.deepStrictEqual(
    Array.from(ctx.applyFilters(ids, strictFilterSheet('Yes'), 3)),
    ['ordinary-short', 'ordinary-video'],
    'short filtering remains independent, but no completed broadcast is eligible'
  );
  assert.strictEqual(ctx.currentRowStatus.filterErrors, 0);
}

function testFilterBatchFailureDoesNotCancelLaterBatch() {
  const ids = Array.from({length: 100}, (_, i) => 'video-' + i);
  let call = 0;
  const ctx = makeContext({
    Videos: {
      list(part, options) {
        call += 1;
        if (call === 1) throw new Error('temporary metadata failure');
        return {items: options.id.split(',').map(id => normalUpload(id, 'PT10M'))};
      }
    }
  });
  ctx.currentRowStatus = ctx.createRowStatus();
  const result = Array.from(ctx.applyFilters(ids, strictFilterSheet('Yes'), 3));

  assert.strictEqual(call, 2);
  assert.strictEqual(result.length, 50);
  assert.strictEqual(result[0], 'video-50');
  assert.strictEqual(ctx.currentRowStatus.filterErrors, 1);
  assert.strictEqual(ctx.currentRowStatus.errorCount, 1);
}

function testVideoMetadataUsesOneRequestPerFiftyIds() {
  const ids = Array.from({length: 101}, (_, i) => 'video-' + i);
  const batchSizes = [];
  const ctx = makeContext({
    Videos: {
      list(part, options) {
        const batch = options.id.split(',');
        batchSizes.push(batch.length);
        return {items: batch.map(id => normalUpload(id, 'PT10M'))};
      }
    }
  });
  ctx.currentRowStatus = ctx.createRowStatus();

  const result = Array.from(ctx.applyFilters(ids, strictFilterSheet('Yes'), 3));

  assert.deepStrictEqual(batchSizes, [50, 50, 1]);
  assert.deepStrictEqual(result, ids);
  assert.strictEqual(ctx.currentRowStatus.errorCount, 0);
}

function testExperimentAdmissionFallbackMatchesProductionPolicy() {
  const production = makeContext();
  const experimentOnly = makeExperimentOnlyContext();
  const samples = [
    normalUpload('ordinary-long', 'PT12H'),
    {id: 'upcoming', snippet: {liveBroadcastContent: 'upcoming'}, liveStreamingDetails: {}},
    {id: 'active', snippet: {liveBroadcastContent: 'live'}, liveStreamingDetails: {}},
    completedBroadcast('known-premiere', 'PT1H8M1S', '2026-08-20T19:00:06Z', '2026-08-20T20:09:06Z'),
    completedBroadcast('exact-limit', 'PT1H30M', '2026-08-20T10:00:00Z', '2026-08-20T11:30:00Z'),
    completedBroadcast('long-stream', 'PT7H1M43S', '2026-08-20T10:00:00Z', '2026-08-20T17:11:48Z'),
    completedBroadcast('trimmed-stream', 'PT1H', '2026-08-20T10:00:00Z', '2026-08-20T12:00:00Z'),
    completedBroadcast('missing-end', 'PT30M', '2026-08-20T10:00:00Z', undefined),
    {id: 'unknown', snippet: {liveBroadcastContent: 'unexpected'}}
  ];

  samples.forEach(item => {
    const expected = JSON.parse(JSON.stringify(production.evaluateVideoAdmissionPolicy(item)));
    const actual = JSON.parse(JSON.stringify(experimentOnly.experimentAdmissionDecision_(item)));
    assert.deepStrictEqual(actual, expected, item.id);
  });
}

function testExperimentReplaySummaryAggregatesAndOmitsSensitiveLists() {
  const ctx = makeExperimentContext();
  const result = {
    schemaVersion: 2,
    policy: 'strict-documented-broadcast-markers-v1',
    dryRun: true,
    rowNumber: 4,
    timestampReadFromColumnB: '2026-08-19T00:00:00.000Z',
    sourceConfigurationHash: 'sha256:CONFIGURATION-SECRET',
    rowSourceHash: 'sha256:ROW-SECRET',
    sourceCount: 12,
    sourceHashes: ['sha256:SOURCE-SECRET'],
    filterShorts: true,
    columnFIgnoredByStrictPolicy: true,
    completedBroadcastMaxSeconds: null,
    acquiredCandidateIds: [
      'KEEP-ME-SECRET-1', 'KEEP-ME-SECRET-2',
      'completed-1', 'completed-2', 'active-1', 'upcoming-1',
      'unknown-1', 'unknown-2', 'metadata-missing-1'
    ],
    keptCandidateIds: ['KEEP-ME-SECRET-1', 'KEEP-ME-SECRET-2'],
    admittedHeuristicCandidates: [],
    rejectedCandidates: [
      {videoId: 'completed-1', reason: 'broadcast_marker', classification: 'COMPLETED_LIVE'},
      {videoId: 'completed-2', reason: 'broadcast_marker', classification: 'COMPLETED_LIVE'},
      {videoId: 'active-1', reason: 'broadcast_marker', classification: 'ACTIVE'},
      {videoId: 'upcoming-1', reason: 'broadcast_marker', classification: 'UPCOMING'}
    ],
    withheldCandidates: [
      {videoId: 'unknown-1', reason: 'live_state_missing_or_unknown'},
      {videoId: 'unknown-2', reason: 'live_state_missing_or_unknown'},
      {videoId: 'metadata-missing-1', reason: 'metadata_missing'}
    ],
    alreadyPresentIds: ['KEEP-ME-SECRET-1'],
    wouldInsertIds: ['KEEP-ME-SECRET-2'],
    targetReadComplete: true,
    blockingErrorCount: 3,
    warningCount: 1,
    checkpointWouldAdvance: false,
    issues: [{
      severity: 'error',
      stage: 'filter',
      reason: 'live_state_missing_or_unknown',
      sourceHash: 'sha256:ISSUE-SOURCE-SECRET',
      sourceColumn: 19,
      videoId: 'unknown-1'
    }]
  };

  const summary = JSON.parse(JSON.stringify(ctx.experimentReplaySummary_(result)));
  const serialized = JSON.stringify(summary);

  assert.deepStrictEqual(summary.rejectionCounts, {
    COMPLETED_LIVE: 2,
    ACTIVE: 1,
    UPCOMING: 1
  });
  assert.deepStrictEqual(summary.withheldCounts, {
    live_state_missing_or_unknown: 2,
    metadata_missing: 1
  });
  assert.strictEqual(summary.acquiredCandidateCount, 9);
  assert.strictEqual(summary.keptCandidateCount, 2);
  assert.strictEqual(summary.rejectedCandidateCount, 4);
  assert.strictEqual(summary.withheldCandidateCount, 3);
  assert.strictEqual(summary.admittedHeuristicCandidateCount, 0);
  assert.strictEqual(summary.schemaVersion, 2);
  assert.strictEqual(summary.policy, result.policy);
  assert.strictEqual(summary.dryRun, true);
  assert.strictEqual(summary.rowNumber, 4);
  assert.strictEqual(summary.timestampReadFromColumnB, result.timestampReadFromColumnB);
  assert.strictEqual(summary.sourceConfigurationHash, result.sourceConfigurationHash,
    'the opaque full-source invariant hash must survive compaction');
  assert.strictEqual(summary.rowSourceHash, result.rowSourceHash,
    'the opaque row invariant hash must survive compaction');
  assert.strictEqual(summary.sourceCount, 12);
  assert.strictEqual(summary.filterShorts, true);
  assert.strictEqual(summary.columnFIgnoredByStrictPolicy, true);
  assert.strictEqual(summary.completedBroadcastMaxSeconds, null);
  assert.strictEqual(summary.targetReadComplete, true);
  assert.strictEqual(summary.blockingErrorCount, 3);
  assert.strictEqual(summary.warningCount, 1);
  assert.strictEqual(summary.checkpointWouldAdvance, false);
  assert.strictEqual(summary.issueCount, 1);

  [
    'sourceHashes', 'admittedHeuristicCandidates',
    'acquiredCandidateIds', 'keptCandidateIds', 'alreadyPresentIds', 'wouldInsertIds'
  ].forEach(key => {
    assert.ok(!Object.prototype.hasOwnProperty.call(summary, key), key + ' must not be copied into the compact summary');
  });
  assert.ok(!serialized.includes('SOURCE-SECRET'), 'per-source hashes must not enter the compact summary');
  assert.ok(!serialized.includes('ISSUE-SOURCE-SECRET'), 'nested issue samples must not leak per-source hashes');
  assert.ok(!serialized.includes('"sourceHash":'), 'issue samples must omit their sourceHash property');
  assert.ok(!serialized.includes('KEEP-ME-SECRET'), 'kept video IDs must not appear in summary JSON');
}

function testExperimentReplaySummaryStaysBelowAppsScriptLogLimit() {
  const ctx = makeExperimentContext();
  const acquiredCandidateIds = Array.from({length: 600}, (_, i) => 'candidate-' + String(i).padStart(4, '0'));
  const keptCandidateIds = acquiredCandidateIds.slice(0, 480).map(id => 'KEPT-SECRET-' + id);
  const classes = ['COMPLETED_LIVE', 'ACTIVE', 'UPCOMING'];
  const rejectedCandidates = Array.from({length: 90}, (_, i) => ({
    videoId: 'rejected-video-' + String(i).padStart(3, '0'),
    reason: 'broadcast_marker',
    classification: classes[i % classes.length],
    liveBroadcastContent: classes[i % classes.length] === 'ACTIVE' ? 'live' : 'none',
    hasLiveStreamingDetails: true
  }));
  const withheldReasons = [
    'live_state_missing_or_unknown',
    'metadata_missing',
    'metadata_batch_failed'
  ];
  const withheldCandidates = Array.from({length: 30}, (_, i) => ({
    videoId: 'withheld-video-' + String(i).padStart(3, '0'),
    reason: withheldReasons[i % withheldReasons.length]
  }));
  const issues = Array.from({length: 60}, (_, i) => ({
    severity: i % 5 === 0 ? 'warning' : 'error',
    stage: 'filter',
    reason: withheldReasons[i % withheldReasons.length],
    sourceColumn: 7 + i,
    sourceHash: 'sha256:' + String(i).padStart(64, 'a'),
    videoId: 'withheld-video-' + String(i % 30).padStart(3, '0')
  }));
  const result = {
    schemaVersion: 1,
    policy: 'strict-documented-broadcast-markers',
    dryRun: true,
    rowNumber: 4,
    timestampReadFromColumnB: '2026-08-19T00:00:00.000Z',
    sourceConfigurationHash: 'sha256:' + 'c'.repeat(64),
    rowSourceHash: 'sha256:' + 'd'.repeat(64),
    sourceCount: 350,
    sourceHashes: Array.from({length: 350}, (_, i) => 'sha256:' + String(i).padStart(64, 'e')),
    filterShorts: true,
    columnFIgnoredByStrictPolicy: true,
    acquiredCandidateIds,
    keptCandidateIds,
    rejectedCandidates,
    withheldCandidates,
    alreadyPresentIds: keptCandidateIds.slice(0, 200),
    wouldInsertIds: keptCandidateIds.slice(200),
    targetReadComplete: true,
    blockingErrorCount: 48,
    warningCount: 12,
    checkpointWouldAdvance: false,
    issues
  };

  const summary = JSON.parse(JSON.stringify(ctx.experimentReplaySummary_(result)));
  const serializedLine = 'STRICT_REPLAY_SUMMARY ' + JSON.stringify(summary);

  assert.strictEqual(summary.rejectedCandidateSamples.length, 25);
  assert.strictEqual(summary.issueSamples.length, 10);
  assert.strictEqual(summary.issueCount, 60);
  assert.deepStrictEqual(summary.rejectionCounts, {
    COMPLETED_LIVE: 30,
    ACTIVE: 30,
    UPCOMING: 30
  });
  assert.deepStrictEqual(summary.withheldCounts, {
    live_state_missing_or_unknown: 10,
    metadata_missing: 10,
    metadata_batch_failed: 10
  });
  assert.strictEqual(summary.acquiredCandidateCount, 600);
  assert.strictEqual(summary.keptCandidateCount, 480);
  assert.strictEqual(summary.rejectedCandidateCount, 90);
  assert.strictEqual(summary.withheldCandidateCount, 30);
  assert.ok(Buffer.byteLength(serializedLine, 'utf8') < 8 * 1024,
    'summary log line must remain below Apps Script\'s roughly 8 KiB per-line limit');
  assert.ok(!serializedLine.includes('"sourceHashes":'), 'summary must omit the per-source hash collection');
  assert.ok(!serializedLine.includes('"sourceHash":'), 'summary samples must remove per-source hashes');
  assert.ok(!serializedLine.includes('KEPT-SECRET-'), 'summary must contain counts, not kept candidate IDs');
}

function testTargetAccessDiagnosticIsReadOnlyTrimmedHashedAndSourceStable() {
  const rawTarget = '  PL_PRIVATE_TARGET_9xYz  ';
  const targetPlaylistId = rawTarget.trim();
  const authenticatedChannelIds = ['UC_PRIVATE_AUTH_CHANNEL_A', 'UC_PRIVATE_AUTH_CHANNEL_B'];
  const paginationItemIds = [
    'PLI_PRIVATE_FULL_PAGE_1A', 'PLI_PRIVATE_FULL_PAGE_1B',
    'PLI_PRIVATE_FULL_PAGE_2A', 'PLI_PRIVATE_FULL_PAGE_2B', 'PLI_PRIVATE_FULL_PAGE_2C'
  ];
  const sourceValues = [
    'UC_PRIVATE_SOURCE_CHANNEL',
    'PL_PRIVATE_SOURCE_PLAYLIST',
    'private-source-email@example.test'
  ];
  const rows = {
    4: [rawTarget, '2026-08-19T00:00:00Z', '', '', 'No', '', ...sourceValues],
    5: ['PL_SECOND_TARGET', '2026-08-19T00:00:00Z', '', '', 'Yes', '', 'UC_SECOND_PRIVATE_SOURCE', '', '']
  };
  let sheetMutationCalls = 0;
  let youtubeMutationCalls = 0;
  let sessionCalls = 0;
  const playlistCalls = [];
  const playlistItemCalls = [];

  function cellValue(row, column) {
    const values = rows[row] || [];
    return values[column - 1] === undefined ? '' : values[column - 1];
  }

  function makeRange(row, column, numRows, numColumns) {
    const height = numRows || 1;
    const width = numColumns || 1;
    const rejectMutation = () => {
      sheetMutationCalls += 1;
      throw new Error('diagnostic attempted to mutate the sheet');
    };
    return {
      getDisplayValue: () => String(cellValue(row, column)),
      getValue: () => cellValue(row, column),
      getDisplayValues: () => Array.from({length: height}, (_, rowOffset) =>
        Array.from({length: width}, (_, columnOffset) =>
          String(cellValue(row + rowOffset, column + columnOffset)))),
      getValues: () => Array.from({length: height}, (_, rowOffset) =>
        Array.from({length: width}, (_, columnOffset) =>
          cellValue(row + rowOffset, column + columnOffset))),
      getFormulas: () => Array.from({length: height}, () => Array.from({length: width}, () => '')),
      setValue: rejectMutation,
      setValues: rejectMutation,
      clear: rejectMutation,
      clearContent: rejectMutation,
      deleteCells: rejectMutation
    };
  }

  const sheet = {
    getLastRow: () => 5,
    getLastColumn: () => 9,
    getRange(row, column, numRows, numColumns) {
      assert.strictEqual(typeof row, 'number');
      return makeRange(row, column, numRows, numColumns);
    }
  };
  const utilities = {
    DigestAlgorithm: {SHA_256: 'SHA_256'},
    Charset: {UTF_8: 'UTF_8'},
    computeDigest(algorithm, text, charset) {
      assert.strictEqual(algorithm, 'SHA_256');
      assert.strictEqual(charset, 'UTF_8');
      return Array.from(crypto.createHash('sha256').update(String(text), 'utf8').digest(), value =>
        value > 127 ? value - 256 : value);
    }
  };
  const scriptApp = {
    AuthMode: {FULL: 'FULL'},
    getAuthorizationInfo(mode) {
      assert.strictEqual(mode, 'FULL');
      return {
        getAuthorizationStatus: () => 'NOT_REQUIRED',
        getAuthorizedScopes: () => ['scope-z', 'scope-a']
      };
    }
  };
  const session = {
    getEffectiveUser() { sessionCalls += 1; throw new Error('diagnostic must not request userinfo.email'); },
    getActiveUser() { sessionCalls += 1; throw new Error('diagnostic must not request userinfo.email'); }
  };
  const youtube = {
    Channels: {
      list(part, options) {
        assert.strictEqual(part, 'id,snippet');
        assert.strictEqual(options.mine, true);
        return {items: [
          {id: authenticatedChannelIds[0], snippet: {title: 'Private Owner Channel A'}},
          {id: authenticatedChannelIds[1], snippet: {title: 'Private Owner Channel B'}}
        ]};
      }
    },
    Playlists: {
      list(part, options) {
        playlistCalls.push({part, options: Object.assign({}, options)});
        if (options.id !== undefined) {
          assert.strictEqual(options.id, targetPlaylistId, 'exact lookup must use the trimmed local target');
          return {items: [{id: targetPlaylistId}]};
        }
        assert.strictEqual(options.mine, true);
        if (!options.pageToken) {
          return {nextPageToken: 'owned-page-2', items: [{id: 'PL_OTHER_PRIVATE_PLAYLIST'}]};
        }
        assert.strictEqual(options.pageToken, 'owned-page-2');
        return {items: [{id: targetPlaylistId}]};
      },
      insert() { youtubeMutationCalls += 1; throw new Error('diagnostic attempted playlist insert'); },
      update() { youtubeMutationCalls += 1; throw new Error('diagnostic attempted playlist update'); },
      remove() { youtubeMutationCalls += 1; throw new Error('diagnostic attempted playlist removal'); }
    },
    PlaylistItems: {
      list(part, options) {
        playlistItemCalls.push({part, options: Object.assign({}, options)});
        assert.strictEqual(options.playlistId, targetPlaylistId, 'item probe must use the trimmed local target');
        if (options.maxResults === 1) {
          if (Object.prototype.hasOwnProperty.call(options, 'pageToken')) {
            assert.strictEqual(options.pageToken, '', 'explicit-empty probe must send an empty pageToken');
            return {items: [{id: 'PLI_PRIVATE_EXPLICIT_EMPTY_ITEM'}]};
          }
          return {items: [{id: 'PLI_PRIVATE_ONE_ITEM'}]};
        }

        assert.strictEqual(options.maxResults, 50);
        if (!Object.prototype.hasOwnProperty.call(options, 'pageToken')) {
          return {
            nextPageToken: 'full-page-2',
            items: paginationItemIds.slice(0, 2).map(id => ({id}))
          };
        }
        if (options.pageToken === 'full-page-2') {
          return {
            nextPageToken: 'full-page-3',
            items: paginationItemIds.slice(2).map(id => ({id}))
          };
        }
        assert.strictEqual(options.pageToken, 'full-page-3');
        const error = new Error('private target pagination failed for ' + targetPlaylistId);
        error.details = {
          code: 403,
          errors: [{reason: 'playlistItemsNotAccessible'}]
        };
        throw error;
      },
      insert() { youtubeMutationCalls += 1; throw new Error('diagnostic attempted item insert'); },
      remove() { youtubeMutationCalls += 1; throw new Error('diagnostic attempted item removal'); }
    }
  };
  const ctx = makeExperimentContext(youtube, {
    Utilities: utilities,
    ScriptApp: scriptApp,
    Session: session
  });

  const fingerprintBefore = ctx.sourceConfigurationFingerprint(sheet);
  const report = JSON.parse(JSON.stringify(ctx.diagnoseTargetAccessReadOnly(4, sheet)));
  const fingerprintAfter = ctx.sourceConfigurationFingerprint(sheet);
  const serialized = JSON.stringify(report);
  const logged = ctx.__logs.join('\n');

  assert.strictEqual(rows[4][0], rawTarget, 'trimming must not write the normalized target back to A4');
  assert.strictEqual(sheetMutationCalls, 0);
  assert.strictEqual(youtubeMutationCalls, 0);
  assert.strictEqual(report.readOnly, true);
  assert.strictEqual(report.mutationPerformed, false);
  assert.strictEqual(report.rawTargetLength, rawTarget.length);
  assert.strictEqual(report.trimmedTargetLength, targetPlaylistId.length);
  assert.strictEqual(report.hadOuterWhitespace, true);
  assert.strictEqual(report.sourceConfigurationHash, fingerprintBefore);
  assert.strictEqual(fingerprintAfter, fingerprintBefore, 'G+ source fingerprint must survive the diagnostic exactly');
  assert.strictEqual(report.targetPlaylistHash,
    ctx.experimentSha256_('target-playlist-v1\n' + targetPlaylistId));
  assert.strictEqual(sessionCalls, 0, 'diagnostic must not broaden OAuth by probing Session e-mail identities');
  assert.ok(!Object.prototype.hasOwnProperty.call(report, 'effectiveUserHash'));
  assert.ok(!Object.prototype.hasOwnProperty.call(report, 'activeUserHash'));
  assert.deepStrictEqual(report.authenticatedChannels.map(channel => channel.idHash),
    authenticatedChannelIds.map(id => ctx.experimentSha256_('oauth-channel-v1\n' + id)));
  report.authenticatedChannels.forEach(channel => {
    assert.ok(!Object.prototype.hasOwnProperty.call(channel, 'id'));
  });
  assert.deepStrictEqual(report.authorizedScopes, ['scope-a', 'scope-z']);
  assert.deepStrictEqual(report.exactTargetLookup, {itemCount: 1, ok: true});
  assert.deepStrictEqual(report.targetInAuthenticatedUsersPlaylists, {
    inspectedPlaylistCount: 2,
    targetPresent: true,
    ok: true
  });
  assert.deepStrictEqual(report.targetItemsLookup, {itemCount: 1, ok: true});
  assert.deepStrictEqual(report.targetItemsWithExplicitEmptyPageToken, {itemCount: 1, ok: true});
  assert.deepStrictEqual(report.fullTargetPagination, {
    ok: false,
    reason: 'api_error',
    pageNumberAttempted: 3,
    pagesCompleted: 2,
    itemCount: 5,
    apiCode: 403,
    apiReason: 'playlistItemsNotAccessible'
  });
  assert.strictEqual(playlistCalls.filter(call => call.options.id !== undefined).length, 1);
  assert.strictEqual(playlistCalls.filter(call => call.options.mine === true).length, 2);
  const oneItemCalls = playlistItemCalls.filter(call => call.options.maxResults === 1);
  const fullPageCalls = playlistItemCalls.filter(call => call.options.maxResults === 50);
  assert.strictEqual(oneItemCalls.length, 2);
  assert.ok(!Object.prototype.hasOwnProperty.call(oneItemCalls[0].options, 'pageToken'),
    'ordinary one-item probe must omit pageToken');
  assert.ok(Object.prototype.hasOwnProperty.call(oneItemCalls[1].options, 'pageToken'));
  assert.strictEqual(oneItemCalls[1].options.pageToken, '');
  assert.strictEqual(fullPageCalls.length, 3);
  assert.ok(!Object.prototype.hasOwnProperty.call(fullPageCalls[0].options, 'pageToken'),
    'the first full-pagination request must omit pageToken entirely');
  assert.deepStrictEqual(fullPageCalls.slice(1).map(call => call.options.pageToken),
    ['full-page-2', 'full-page-3']);

  [rawTarget, targetPlaylistId]
    .concat(authenticatedChannelIds, sourceValues, paginationItemIds, [
      'UC_SECOND_PRIVATE_SOURCE', 'PL_OTHER_PRIVATE_PLAYLIST',
      'PLI_PRIVATE_ONE_ITEM', 'PLI_PRIVATE_EXPLICIT_EMPTY_ITEM'
    ])
    .forEach(secret => {
      assert.ok(!serialized.includes(secret), 'report must not serialize raw private value: ' + secret);
      assert.ok(!logged.includes(secret), 'diagnostic log must not serialize raw private value: ' + secret);
    });
}

function testPremiereExperimentTargetVerificationIsExactReadOnlyAndPrivate() {
  const targetPlaylistId = 'PL_PRIVATE_VERIFICATION_TARGET';
  const sourceId = 'UC_PRIVATE_VERIFICATION_SOURCE';
  const unrelatedVideoId = 'unrelated-target-member';
  const rows = {
    4: [targetPlaylistId, '2026-08-19T00:00:00Z', '', '', 'No', '', sourceId]
  };
  let sheetMutationCalls = 0;
  let youtubeMutationCalls = 0;
  const pageTokens = [];
  function cellValue(row, column) {
    const values = rows[row] || [];
    return values[column - 1] === undefined ? '' : values[column - 1];
  }
  const sheet = {
    getLastRow: () => 4,
    getLastColumn: () => 7,
    getRange(row, column, numRows, numColumns) {
      const height = numRows || 1;
      const width = numColumns || 1;
      const rejectMutation = () => {
        sheetMutationCalls += 1;
        throw new Error('verification attempted to mutate the sheet');
      };
      return {
        getDisplayValue: () => String(cellValue(row, column)),
        getValues: () => Array.from({length: height}, (_, rowOffset) =>
          Array.from({length: width}, (_, columnOffset) =>
            cellValue(row + rowOffset, column + columnOffset))),
        getDisplayValues: () => Array.from({length: height}, (_, rowOffset) =>
          Array.from({length: width}, (_, columnOffset) =>
            String(cellValue(row + rowOffset, column + columnOffset)))),
        getFormulas: () => Array.from({length: height}, () =>
          Array.from({length: width}, () => '')),
        setValue: rejectMutation,
        setValues: rejectMutation,
        clear: rejectMutation,
        clearContent: rejectMutation
      };
    }
  };
  const utilities = {
    DigestAlgorithm: {SHA_256: 'SHA_256'},
    Charset: {UTF_8: 'UTF_8'},
    computeDigest(algorithm, text, charset) {
      assert.strictEqual(algorithm, 'SHA_256');
      assert.strictEqual(charset, 'UTF_8');
      return Array.from(crypto.createHash('sha256').update(String(text), 'utf8').digest(), value =>
        value > 127 ? value - 256 : value);
    }
  };
  const ctx = makeExperimentContext({
    PlaylistItems: {
      list(part, options) {
        assert.strictEqual(part, 'contentDetails');
        assert.strictEqual(options.playlistId, targetPlaylistId);
        pageTokens.push(options.pageToken);
        if (!options.pageToken) {
          return {nextPageToken: 'verification-page-2', items: [
            {contentDetails: {videoId: 'CkmIANn_xZY'}},
            {contentDetails: {videoId: unrelatedVideoId}}
          ]};
        }
        assert.strictEqual(options.pageToken, 'verification-page-2');
        return {items: [
          {contentDetails: {videoId: 'SE7aCzUaUdY'}},
          {contentDetails: {videoId: 'CkmIANn_xZY'}}
        ]};
      },
      insert() { youtubeMutationCalls += 1; throw new Error('verification attempted insert'); },
      remove() { youtubeMutationCalls += 1; throw new Error('verification attempted removal'); }
    }
  }, {Utilities: utilities});

  const fingerprintBefore = ctx.sourceConfigurationFingerprint(sheet);
  const report = JSON.parse(JSON.stringify(
    ctx.verifyRow4PremiereExperimentTargetReadOnly(sheet)
  ));
  const fingerprintAfter = ctx.sourceConfigurationFingerprint(sheet);
  const serialized = JSON.stringify(report);
  const logged = ctx.__logs.join('\n');

  assert.deepStrictEqual(pageTokens, [undefined, 'verification-page-2']);
  assert.strictEqual(report.readOnly, true);
  assert.strictEqual(report.mutationPerformed, false);
  assert.strictEqual(report.targetReadComplete, true);
  assert.strictEqual(report.targetUniqueVideoCount, 3);
  assert.deepStrictEqual(report.membershipByVideoId, {
    CkmIANn_xZY: true,
    SE7aCzUaUdY: true,
    Knnm5_rG89E: false
  });
  assert.strictEqual(report.blockingErrorCount, 0);
  assert.strictEqual(report.warningCount, 0);
  assert.strictEqual(report.sourceConfigurationHash, fingerprintBefore);
  assert.strictEqual(fingerprintAfter, fingerprintBefore);
  assert.strictEqual(sheetMutationCalls, 0);
  assert.strictEqual(youtubeMutationCalls, 0);
  [targetPlaylistId, sourceId].forEach(secret => {
    assert.ok(!serialized.includes(secret), 'verification report leaked private ID: ' + secret);
    assert.ok(!logged.includes(secret), 'verification log leaked private ID: ' + secret);
  });
  assert.ok(logged.includes('PREMIERE_EXPERIMENT_TARGET_VERIFICATION'));
}

function testStrictTargetAuditPaginatesBatchesClassifiesAndNeverMutates() {
  const ids = Array.from({length: 55}, (_, i) => 'audit-video-' + i);
  const playlistPageTokens = [];
  const metadataBatchSizes = [];
  let removeCalls = 0;
  const ctx = makeContext({
    PlaylistItems: {
      list(part, options) {
        playlistPageTokens.push(options.pageToken);
        if (!options.pageToken) {
          return {
            nextPageToken: 'audit-page-2',
            items: ids.slice(0, 50).map((id, index) => ({
              id: 'playlist-item-' + index,
              contentDetails: {videoId: id}
            }))
          };
        }
        assert.strictEqual(options.pageToken, 'audit-page-2');
        return {items: ids.slice(50).map((id, index) => ({
          id: 'playlist-item-' + (index + 50),
          contentDetails: {videoId: id}
        })).concat([{
          id: 'duplicate-playlist-item',
          contentDetails: {videoId: ids[0]}
        }])};
      },
      remove() { removeCalls += 1; }
    },
    Videos: {
      list(part, options) {
        const batch = options.id.split(',');
        metadataBatchSizes.push(batch.length);
        return {items: batch.map(id => {
          if (id === ids[51]) {
            return {
              id,
              snippet: {liveBroadcastContent: 'upcoming'},
              contentDetails: {duration: 'P0D'},
              liveStreamingDetails: {scheduledStartTime: '2026-08-23T16:00:00Z'}
            };
          }
          if (id === ids[52]) {
            return {
              id,
              snippet: {liveBroadcastContent: 'live'},
              contentDetails: {duration: 'P0D'},
              liveStreamingDetails: {actualStartTime: '2026-08-21T18:00:00Z'}
            };
          }
          if (id === ids[53]) {
            return {
              id,
              snippet: {liveBroadcastContent: 'none'},
              contentDetails: {duration: 'PT6H'},
              liveStreamingDetails: {
                actualStartTime: '2026-08-20T10:00:00Z',
                actualEndTime: '2026-08-20T16:00:00Z'
              }
            };
          }
          if (id === ids[54]) {
            return {
              id,
              snippet: {liveBroadcastContent: 'unexpected-state'},
              contentDetails: {duration: 'PT20M'}
            };
          }
          return normalUpload(id, 'PT20M');
        })};
      }
    }
  });
  ctx.currentRowStatus = ctx.createRowStatus();

  const report = JSON.parse(JSON.stringify(ctx.inspectTargetPlaylistStrict('PL_TARGET')));

  assert.deepStrictEqual(playlistPageTokens, [undefined, 'audit-page-2']);
  assert.deepStrictEqual(metadataBatchSizes, [50, 5]);
  assert.strictEqual(report.playlistItemCount, 56);
  assert.strictEqual(report.uniqueVideoCount, 55);
  assert.deepStrictEqual(report.classifications, {
    NORMAL_UPLOAD: 51,
    UPCOMING: 1,
    ACTIVE: 1,
    COMPLETED_LIVE: 1,
    UNKNOWN: 1
  });
  assert.strictEqual(report.admittedHeuristicCompletedBroadcastCount, 0);
  assert.strictEqual(report.forbiddenCount, 3,
    'all documented broadcast states are permanent strict rejections');
  assert.strictEqual(report.withheldCount, 1,
    'only unknown metadata remains retryable');
  assert.strictEqual(report.unknownCount, 1);
  assert.strictEqual(report.mutationPerformed, false);
  assert.strictEqual(ctx.currentRowStatus.policyErrors, 1);
  assert.strictEqual(removeCalls, 0, 'v5 target audit must remain inspect-only');
}

function testStrictTargetAuditMetadataBatchFailureIsUnknownAndBlocking() {
  const ids = Array.from({length: 60}, (_, i) => 'audit-failure-video-' + i);
  const metadataBatchSizes = [];
  let removeCalls = 0;
  const ctx = makeContext({
    PlaylistItems: {
      list() {
        return {items: ids.map((id, index) => ({
          id: 'playlist-item-' + index,
          contentDetails: {videoId: id}
        }))};
      },
      remove() { removeCalls += 1; }
    },
    Videos: {
      list(part, options) {
        const batch = options.id.split(',');
        metadataBatchSizes.push(batch.length);
        if (metadataBatchSizes.length === 2) throw new Error('temporary audit metadata failure');
        return {items: batch.map(id => normalUpload(id, 'PT20M'))};
      }
    }
  });
  ctx.currentRowStatus = ctx.createRowStatus();

  const report = JSON.parse(JSON.stringify(ctx.inspectTargetPlaylistStrict('PL_TARGET')));

  assert.deepStrictEqual(metadataBatchSizes, [50, 10]);
  assert.strictEqual(report.classifications.NORMAL_UPLOAD, 50);
  assert.strictEqual(report.classifications.UNKNOWN, 10);
  assert.strictEqual(report.unknownCount, 10);
  assert.strictEqual(report.withheldCount, 10);
  assert.strictEqual(report.mutationPerformed, false);
  assert.strictEqual(ctx.currentRowStatus.policyErrors, 1);
  assert.strictEqual(ctx.currentRowStatus.errorCount, 1, 'audit read failure must block the checkpoint');
  assert.strictEqual(removeCalls, 0, 'even a failed v5 audit must not mutate the playlist');
}

function testStrictTargetAuditMetadataOmissionIsWithheldAndBlocking() {
  let removeCalls = 0;
  const ctx = makeContext({
    PlaylistItems: {
      list() {
        return {items: [
          {id: 'playlist-item-returned', contentDetails: {videoId: 'audit-returned'}},
          {id: 'playlist-item-omitted', contentDetails: {videoId: 'audit-omitted'}}
        ]};
      },
      remove() { removeCalls += 1; }
    },
    Videos: {
      list() {
        return {items: [normalUpload('audit-returned', 'PT20M')]};
      }
    }
  });
  ctx.currentRowStatus = ctx.createRowStatus();

  const report = JSON.parse(JSON.stringify(ctx.inspectTargetPlaylistStrict('PL_TARGET')));

  assert.strictEqual(report.classifications.NORMAL_UPLOAD, 1);
  assert.strictEqual(report.classifications.UNKNOWN, 1);
  assert.strictEqual(report.unknownCount, 1);
  assert.strictEqual(report.withheldCount, 1);
  assert.strictEqual(report.forbiddenCount, 0);
  assert.strictEqual(ctx.currentRowStatus.policyErrors, 1);
  assert.strictEqual(ctx.currentRowStatus.errorCount, 1,
    'a successful metadata response that omits an ID must block the audit checkpoint');
  assert.strictEqual(removeCalls, 0);
}

function testStrictTargetAuditMalformedPlaylistItemsAreWithheldAndBlocking() {
  const metadataRequests = [];
  let removeCalls = 0;
  const ctx = makeContext({
    PlaylistItems: {
      list() {
        return {items: [
          {id: 'playlist-item-valid-1', contentDetails: {videoId: 'audit-valid'}},
          {id: 'playlist-item-valid-duplicate', contentDetails: {videoId: 'audit-valid'}},
          {id: 'playlist-item-missing-video-id', contentDetails: {}},
          {id: 'playlist-item-blank-video-id', contentDetails: {videoId: '   '}}
        ]};
      },
      remove() { removeCalls += 1; }
    },
    Videos: {
      list(part, options) {
        metadataRequests.push(options.id);
        return {items: [normalUpload('audit-valid', 'PT20M')]};
      }
    }
  });
  ctx.currentRowStatus = ctx.createRowStatus();

  const report = JSON.parse(JSON.stringify(ctx.inspectTargetPlaylistStrict('PL_TARGET')));

  assert.deepStrictEqual(metadataRequests, ['audit-valid'],
    'duplicate valid IDs must retain the existing de-duplication behavior');
  assert.strictEqual(report.playlistItemCount, 4);
  assert.strictEqual(report.uniqueVideoCount, 1);
  assert.strictEqual(report.unidentifiedPlaylistItemCount, 2);
  assert.strictEqual(report.classifications.NORMAL_UPLOAD, 1);
  assert.strictEqual(report.classifications.UNKNOWN, 2);
  assert.strictEqual(report.unknownCount, 2);
  assert.strictEqual(report.withheldCount, 2);
  assert.strictEqual(report.forbiddenCount, 0);
  assert.strictEqual(ctx.currentRowStatus.policyErrors, 2,
    'each malformed target item must record its own blocking policy error');
  assert.strictEqual(ctx.currentRowStatus.errorCount, 2);
  assert.strictEqual(removeCalls, 0);
}

function testTargetAuditCountsEveryCompletedBroadcastAsForbidden() {
  const ctx = makeContext({
    PlaylistItems: {
      list() {
        return {items: [
          {id: 'item-normal', contentDetails: {videoId: 'normal'}},
          {id: 'item-premiere', contentDetails: {videoId: 'premiere-like'}}
        ]};
      },
      remove() { throw new Error('read-only audit must never remove'); }
    },
    Videos: {
      list() {
        return {items: [
          normalUpload('normal', 'PT2H'),
          completedBroadcast(
            'premiere-like', 'PT1H8M1S', '2026-08-20T19:00:06Z', '2026-08-20T20:09:06Z'
          )
        ]};
      }
    }
  });
  ctx.currentRowStatus = ctx.createRowStatus();

  const report = JSON.parse(JSON.stringify(ctx.inspectTargetPlaylistStrict('PL_TARGET')));

  assert.strictEqual(report.classifications.NORMAL_UPLOAD, 1);
  assert.strictEqual(report.classifications.COMPLETED_LIVE, 1);
  assert.strictEqual(report.admittedHeuristicCompletedBroadcastCount, 0);
  assert.strictEqual(report.forbiddenCount, 1);
  assert.strictEqual(report.withheldCount, 0);
  assert.strictEqual(report.mutationPerformed, false);
}

function testPreInsertRevalidationRejectsUpcomingWithoutBlocking() {
  let insertCalls = 0;
  const ctx = makeContext({
    Videos: {
      list() {
        return {items: [{
          id: 'changed-before-insert',
          snippet: {liveBroadcastContent: 'upcoming'},
          contentDetails: {duration: 'P0D'},
          liveStreamingDetails: {scheduledStartTime: '2026-08-22T16:00:00Z'}
        }]};
      }
    },
    PlaylistItems: {
      insert() { insertCalls += 1; }
    }
  });
  ctx.currentRowStatus = ctx.createRowStatus();
  ctx.targetPlaylistVideoCache = {'PL_TARGET': {}};
  ctx.maxPlaylistWriteOperationsPerRun = 10;
  ctx.playlistWriteOperationsUsed = 0;

  ctx.addVideosToPlaylist('PL_TARGET', ['changed-before-insert']);

  assert.strictEqual(insertCalls, 0, 'a candidate that becomes upcoming before insertion must never be written');
  assert.strictEqual(ctx.playlistWriteOperationsUsed, 0);
  assert.strictEqual(ctx.currentRowStatus.policyErrors, 0,
    'a known broadcast state is a permanent rejection, not a retryable failure');
  assert.ok(ctx.__logs.some(line => line.includes('pre-insert') && line.includes('UPCOMING')));
}

function testPreInsertRevalidationRejectsCompletedBroadcastAtAnyDuration() {
  let insertCalls = 0;
  const ctx = makeContext({
    Videos: {
      list() {
        return {items: [completedBroadcast(
          'changed-to-long-completed',
          'PT7H1M43S',
          '2026-08-20T10:00:00Z',
          '2026-08-20T17:11:48Z'
        )]};
      }
    },
    PlaylistItems: {insert() { insertCalls += 1; }}
  });
  ctx.currentRowStatus = ctx.createRowStatus();
  ctx.targetPlaylistVideoCache = {'PL_TARGET': {}};
  ctx.maxPlaylistWriteOperationsPerRun = 10;
  ctx.playlistWriteOperationsUsed = 0;

  ctx.addVideosToPlaylist('PL_TARGET', ['changed-to-long-completed']);

  assert.strictEqual(insertCalls, 0);
  assert.strictEqual(ctx.playlistWriteOperationsUsed, 0);
  assert.strictEqual(ctx.currentRowStatus.errorCount, 0,
    'a completed broadcast is a known rejection, not a metadata failure');
  assert.ok(ctx.__logs.some(line => line.includes('completed_broadcast_rejected_by_strict_policy')));
}

function testPreInsertCompletedBroadcastNeedsNoDurationOrTimestampEvidence() {
  let insertCalls = 0;
  const ctx = makeContext({
    Videos: {
      list() {
        return {items: [completedBroadcast(
          'preinsert-missing-end',
          'PT30M',
          '2026-08-20T10:00:00Z',
          undefined
        )]};
      }
    },
    PlaylistItems: {insert() { insertCalls += 1; }}
  });
  ctx.currentRowStatus = ctx.createRowStatus();
  ctx.targetPlaylistVideoCache = {'PL_TARGET': {}};
  ctx.maxPlaylistWriteOperationsPerRun = 10;
  ctx.playlistWriteOperationsUsed = 0;

  ctx.addVideosToPlaylist('PL_TARGET', ['preinsert-missing-end']);

  assert.strictEqual(insertCalls, 0);
  assert.strictEqual(ctx.playlistWriteOperationsUsed, 0);
  assert.strictEqual(ctx.currentRowStatus.policyErrors, 0);
  assert.strictEqual(ctx.currentRowStatus.errorCount, 0,
    'the documented completed-broadcast marker is sufficient for rejection');
}

function testCompletedBroadcastNeverReachesInsertion() {
  let metadataCalls = 0;
  const inserted = [];
  const removed = [];
  const candidate = completedBroadcast(
    'known-premiere', 'PT1H8M1S', '2026-08-20T19:00:06Z', '2026-08-20T20:09:06Z'
  );
  const ctx = makeContext({
    Videos: {list() { metadataCalls += 1; return {items: [candidate]}; }},
    PlaylistItems: {
      insert(resource) {
        inserted.push(resource.snippet.resourceId.videoId);
        return {id: 'playlist-item-premiere'};
      },
      remove(id) { removed.push(id); }
    }
  });
  ctx.currentRowStatus = ctx.createRowStatus();
  ctx.targetPlaylistVideoCache = {'PL_TARGET': {}};
  ctx.maxPlaylistWriteOperationsPerRun = 10;
  ctx.playlistWriteOperationsUsed = 0;

  ctx.addVideosToPlaylist('PL_TARGET', ['known-premiere']);

  assert.deepStrictEqual(inserted, []);
  assert.deepStrictEqual(removed, []);
  assert.strictEqual(metadataCalls, 1);
  assert.strictEqual(ctx.playlistWriteOperationsUsed, 0);
  assert.strictEqual(ctx.currentRowStatus.errorCount, 0);
}

function testPostInsertCompletedBroadcastMarkerRollsBackWithoutBlocking() {
  let metadataCall = 0;
  const inserted = [];
  const removed = [];
  const ctx = makeContext({
    Videos: {
      list() {
        metadataCall += 1;
        if (metadataCall === 1) {
          return {items: [normalUpload('postinsert-missing-end', 'PT30M')]};
        }
        return {items: [completedBroadcast(
          'postinsert-missing-end',
          'PT30M',
          '2026-08-20T10:00:00Z',
          undefined
        )]};
      }
    },
    PlaylistItems: {
      insert(resource) {
        inserted.push(resource.snippet.resourceId.videoId);
        return {id: 'playlist-item-missing-end'};
      },
      remove(id) { removed.push(id); }
    }
  });
  ctx.currentRowStatus = ctx.createRowStatus();
  ctx.targetPlaylistVideoCache = {'PL_TARGET': {}};
  ctx.maxPlaylistWriteOperationsPerRun = 10;
  ctx.playlistWriteOperationsUsed = 0;

  ctx.addVideosToPlaylist('PL_TARGET', ['postinsert-missing-end']);

  assert.deepStrictEqual(inserted, ['postinsert-missing-end']);
  assert.deepStrictEqual(removed, ['playlist-item-missing-end']);
  assert.strictEqual(metadataCall, 2);
  assert.strictEqual(ctx.playlistWriteOperationsUsed, 2);
  assert.strictEqual(ctx.currentRowStatus.policyWarnings, 1);
  assert.strictEqual(ctx.currentRowStatus.policyErrors, 0);
  assert.strictEqual(ctx.currentRowStatus.errorCount, 0,
    'a known completed-broadcast transition must roll back without freezing the checkpoint');
}

function testPostInsertTransitionFromUploadToCompletedBroadcastRollsBack() {
  let metadataCall = 0;
  const inserted = [];
  const removed = [];
  const ctx = makeContext({
    Videos: {
      list() {
        metadataCall += 1;
        if (metadataCall === 1) {
          return {items: [normalUpload('grows-after-insert', 'PT1H')]};
        }
        return {items: [completedBroadcast(
          'grows-after-insert', 'PT1H', '2026-08-20T10:00:00Z', '2026-08-20T11:00:00Z'
        )]};
      }
    },
    PlaylistItems: {
      insert(resource) {
        inserted.push(resource.snippet.resourceId.videoId);
        return {id: 'playlist-item-growing-stream'};
      },
      remove(id) { removed.push(id); }
    }
  });
  ctx.currentRowStatus = ctx.createRowStatus();
  ctx.targetPlaylistVideoCache = {'PL_TARGET': {}};
  ctx.maxPlaylistWriteOperationsPerRun = 10;
  ctx.playlistWriteOperationsUsed = 0;

  ctx.addVideosToPlaylist('PL_TARGET', ['grows-after-insert']);

  assert.deepStrictEqual(inserted, ['grows-after-insert']);
  assert.deepStrictEqual(removed, ['playlist-item-growing-stream']);
  assert.strictEqual(metadataCall, 2);
  assert.strictEqual(ctx.playlistWriteOperationsUsed, 2);
  assert.strictEqual(ctx.currentRowStatus.policyWarnings, 1);
  assert.strictEqual(ctx.currentRowStatus.policyErrors, 0);
}

function testPostInsertTransitionIsRolledBack() {
  let metadataCall = 0;
  const inserted = [];
  const removed = [];
  const ctx = makeContext({
    Videos: {
      list() {
        metadataCall += 1;
        if (metadataCall === 1) {
          return {items: [normalUpload('changed-after-insert', 'PT20M')]};
        }
        return {items: [{
          id: 'changed-after-insert',
          snippet: {liveBroadcastContent: 'live'},
          contentDetails: {duration: 'P0D'},
          liveStreamingDetails: {actualStartTime: '2026-08-21T20:00:00Z'}
        }]};
      }
    },
    PlaylistItems: {
      insert(resource) {
        inserted.push(resource.snippet.resourceId.videoId);
        return {id: 'playlist-item-1'};
      },
      remove(playlistItemId) { removed.push(playlistItemId); }
    }
  });
  ctx.currentRowStatus = ctx.createRowStatus();
  ctx.targetPlaylistVideoCache = {'PL_TARGET': {}};
  ctx.maxPlaylistWriteOperationsPerRun = 10;
  ctx.playlistWriteOperationsUsed = 0;

  ctx.addVideosToPlaylist('PL_TARGET', ['changed-after-insert']);

  assert.deepStrictEqual(inserted, ['changed-after-insert']);
  assert.deepStrictEqual(removed, ['playlist-item-1']);
  assert.strictEqual(metadataCall, 2, 'the inserted item must be checked both before and after insertion');
  assert.strictEqual(ctx.playlistWriteOperationsUsed, 2);
  assert.strictEqual(ctx.currentRowStatus.policyWarnings, 1);
  assert.strictEqual(ctx.currentRowStatus.policyErrors, 0,
    'a known active-broadcast transition is rolled back without freezing the checkpoint');
  assert.strictEqual(ctx.targetPlaylistVideoCache.PL_TARGET['changed-after-insert'], undefined);
}

function runPartialTargetReadInsertScenario(candidateIds, insertBehavior, existingOnUnreadPages, scenarioOptions) {
  const targetPlaylistId = 'PL_PARTIAL_TARGET';
  const knownOnFirstPage = 'known-on-first-target-page';
  const inserted = [];
  const removed = [];
  const targetListPageTokens = [];
  const targetListPageTokenPresence = [];
  const candidateProbeIds = [];
  const reconciliationProbeIds = [];
  const fallbackExisting = new Set(existingOnUnreadPages || []);
  const probeFailures = new Set((scenarioOptions && scenarioOptions.probeFailures) || []);
  const quotaFailureProbe = scenarioOptions && scenarioOptions.quotaFailureProbe;
  const malformedProbeResponses = new Set((scenarioOptions && scenarioOptions.malformedProbeResponses) || []);
  const failFirstTargetPage = !!(scenarioOptions && scenarioOptions.failFirstTargetPage);
  const completeTargetInventory = !!(scenarioOptions && scenarioOptions.completeTargetInventory);
  const malformedTargetInventoryPage = !!(scenarioOptions && scenarioOptions.malformedTargetInventoryPage);
  const completeInventoryIds = scenarioOptions && scenarioOptions.completeInventoryIds;
  let timestampWrites = 0;
  const ctx = makeContext({
    Channels: {
      list() {
        return {items: [{contentDetails: {relatedPlaylists: {uploads: 'UU_HEALTHY'}}}]};
      }
    },
    PlaylistItems: {
      list(part, options) {
        if (options.playlistId === 'UU_HEALTHY') {
          // The production source reader reverses newest-first upload pages into
          // ascending insertion order, so reverse the fixture here.
          return {items: candidateIds.slice().reverse().map(id => ({
            contentDetails: {
              videoId: id,
              videoPublishedAt: '2026-08-21T08:00:00Z'
            }
          }))};
        }
        if (options.playlistId === targetPlaylistId) {
          if (options.videoId) {
            if (options.maxResults === 50) {
              reconciliationProbeIds.push(options.videoId);
            } else {
              candidateProbeIds.push(options.videoId);
              assert.strictEqual(options.maxResults, 1,
                'partial target fallback must probe one candidate at a time');
            }
            if (probeFailures.has(options.videoId)) {
              const error = new Error('membership probe failed for ' + options.videoId);
              error.details = {code: 503, errors: [{reason: 'backendError'}]};
              throw error;
            }
            if (options.videoId === quotaFailureProbe) {
              const error = new Error('membership quota exhausted for ' + options.videoId);
              error.details = {code: 403, errors: [{reason: 'quotaExceeded'}]};
              throw error;
            }
            if (malformedProbeResponses.has(options.videoId)) {
              return {items: {truthyButNotAnArray: true}};
            }
            return {
              items: fallbackExisting.has(options.videoId)
                ? [{id: 'existing-playlist-item-for-' + options.videoId}]
                : []
            };
          }
          targetListPageTokens.push(options.pageToken);
          targetListPageTokenPresence.push(Object.prototype.hasOwnProperty.call(options, 'pageToken'));
          if (!options.pageToken) {
            if (failFirstTargetPage) {
              const error = new Error('target first page inaccessible');
              error.details = {code: 503, errors: [{reason: 'backendError'}]};
              throw error;
            }
            if (completeTargetInventory) {
              return {
                items: (completeInventoryIds || [knownOnFirstPage]).map(videoId => ({
                  contentDetails: {videoId}
                }))
              };
            }
            if (malformedTargetInventoryPage) {
              return {items: [{contentDetails: {}}]};
            }
            return {
              nextPageToken: 'unreadable-target-page-2',
              items: [{contentDetails: {videoId: knownOnFirstPage}}]
            };
          }
          const error = new Error('later target page temporarily inaccessible');
          error.details = {code: 503, errors: [{reason: 'backendError'}]};
          throw error;
        }
        throw new Error('unexpected playlist lookup ' + options.playlistId + ' / ' + part);
      },
      insert(resource) {
        const videoId = resource.snippet.resourceId.videoId;
        inserted.push(videoId);
        return insertBehavior(videoId);
      },
      remove(playlistItemId) { removed.push(playlistItemId); }
    },
    Videos: {
      list(part, options) {
        return {items: options.id.split(',').map(id => normalUpload(id, 'PT20M'))};
      }
    }
  });
  const sheet = {
    getLastColumn: () => 7,
    getRange(row, column) {
      return {
        getValue: () => (column === 5 ? 'Yes' : ''),
        setValue: () => { timestampWrites += 1; }
      };
    }
  };
  const data = [[], [], [], [
    targetPlaylistId, '2026-08-20T00:00:00Z', 0, 0, 'Yes', '', 'UC_HEALTHY_12345'
  ]];

  ctx.currentRowStatus = ctx.createRowStatus();
  ctx.targetPlaylistVideoCache = {};
  ctx.maxPlaylistWriteOperationsPerRun = scenarioOptions && scenarioOptions.maxWriteOperations !== undefined
    ? scenarioOptions.maxWriteOperations
    : 20;
  ctx.playlistWriteOperationsUsed = 0;
  ctx.processPlaylistRow(sheet, data, 3, targetPlaylistId);

  return {
    ctx,
    knownOnFirstPage,
    inserted,
    removed,
    targetListPageTokens,
    targetListPageTokenPresence,
    candidateProbeIds,
    reconciliationProbeIds,
    timestampWrites
  };
}

function testFirstTargetPageFailureBlocksWithoutProbesOrInserts() {
  const candidate = 'candidate-never-probed-or-inserted';
  const run = runPartialTargetReadInsertScenario(
    [candidate],
    videoId => ({id: 'unexpected-insert-' + videoId}),
    [],
    {failFirstTargetPage: true}
  );

  assert.deepStrictEqual(run.targetListPageTokens, [undefined]);
  assert.deepStrictEqual(run.targetListPageTokenPresence, [false]);
  assert.deepStrictEqual(run.candidateProbeIds, [],
    'without even one target page there is no safe basis for fallback membership probes');
  assert.deepStrictEqual(run.inserted, []);
  assert.strictEqual(run.ctx.playlistWriteOperationsUsed, 0);
  assert.strictEqual(run.ctx.currentRowStatus.writeWarnings, 0);
  assert.strictEqual(run.ctx.currentRowStatus.writeErrors, 1);
  assert.strictEqual(run.ctx.currentRowStatus.errorCount, 1);
  assert.strictEqual(run.ctx.currentRowStatus.timestampUpdated, false);
  assert.strictEqual(run.timestampWrites, 0);
}

function testPartialTargetReadUsesCandidateProbesAndContinues() {
  const known = 'known-on-first-target-page';
  const duplicate = 'duplicate-on-unread-target-page';
  const fresh = 'fresh-valid-candidate';
  const run = runPartialTargetReadInsertScenario(
    [known, duplicate, fresh],
    videoId => ({id: 'playlist-item-for-' + videoId}),
    [duplicate]
  );

  assert.deepStrictEqual(run.targetListPageTokens, [undefined, 'unreadable-target-page-2']);
  assert.deepStrictEqual(run.targetListPageTokenPresence, [false, true],
    'the initial full target-list request must omit pageToken entirely');
  assert.deepStrictEqual(run.candidateProbeIds, [duplicate, fresh],
    'unresolved candidates must receive exact playlistItems.list(videoId) probes');
  assert.deepStrictEqual(run.inserted, [fresh],
    'first-page and exact-probe matches must be suppressed while a proven-absent candidate proceeds');
  assert.deepStrictEqual(run.removed, []);
  assert.strictEqual(run.ctx.currentRowStatus.writeWarnings, 1,
    'partial target pagination is a non-blocking optimization warning');
  assert.strictEqual(run.ctx.currentRowStatus.writeErrors, 0);
  assert.strictEqual(run.ctx.currentRowStatus.errorCount, 0,
    'successful exact target probes make the partial-read warning safe and non-blocking');
  assert.strictEqual(run.ctx.currentRowStatus.timestampUpdated, true);
  assert.strictEqual(run.timestampWrites, 1, 'safe partial-read run should advance its checkpoint');
  assert.strictEqual(run.ctx.playlistWriteOperationsUsed, 1);
  const summary = run.ctx.__logs.find(line => line.includes('Sequential target progress:'));
  assert.ok(summary, 'sequential candidate processing must emit one explicit progress summary');
  assert.ok(summary.includes('present=2'),
    'a first-page match and an exact-probe match must both count as already present');
  assert.ok(summary.includes('insert attempts=1') && summary.includes('added=1'));
  assert.ok(summary.includes('failed=0') && summary.includes('stoppedEarly=false'));
  assert.ok(!run.ctx.__logs.some(line => line.includes('probe limit of')),
    'the retired membership-probe ceiling must never appear during ordinary sequential processing');
}

function testUnverifiableMembershipStopsSequentialProgressAndRetainsCheckpoint() {
  const unverifiable = 'candidate-with-failed-membership-probe';
  const knownAbsent = 'candidate-proven-absent';
  const run = runPartialTargetReadInsertScenario(
    [unverifiable, knownAbsent],
    videoId => ({id: 'playlist-item-for-' + videoId}),
    [],
    {probeFailures: [unverifiable]}
  );

  assert.deepStrictEqual(run.targetListPageTokens, [undefined, 'unreadable-target-page-2']);
  assert.deepStrictEqual(run.candidateProbeIds, [unverifiable],
    'the sequential walk stops at the first candidate whose membership cannot be decided');
  assert.deepStrictEqual(run.inserted, [],
    'no later candidate may be mutated once one candidate is left unresolved');
  assert.deepStrictEqual(run.removed, []);
  assert.strictEqual(run.ctx.playlistWriteOperationsUsed, 0);
  assert.strictEqual(run.ctx.currentRowStatus.writeWarnings, 1,
    'later target-page failure remains a non-blocking optimization warning');
  assert.strictEqual(run.ctx.currentRowStatus.writeErrors, 1,
    'the unverifiable candidate must retain the checkpoint for retry');
  assert.strictEqual(run.ctx.currentRowStatus.errorCount, 1);
  assert.strictEqual(run.ctx.currentRowStatus.timestampUpdated, false);
  assert.strictEqual(run.timestampWrites, 0);
  const summary = run.ctx.__logs.find(line => line.includes('Sequential target progress:'));
  assert.ok(summary && summary.includes('checked=1') && summary.includes('stoppedEarly=true'),
    'the summary must disclose exactly how far the sequential walk got');
}

function testMalformedTargetInventoryItemForcesExactMembershipProbe() {
  const candidate = 'candidate-after-malformed-complete-looking-target-page';
  const run = runPartialTargetReadInsertScenario(
    [candidate],
    videoId => ({id: 'playlist-item-for-' + videoId}),
    [],
    {malformedTargetInventoryPage: true}
  );

  assert.deepStrictEqual(run.targetListPageTokens, [undefined]);
  assert.deepStrictEqual(run.targetListPageTokenPresence, [false]);
  assert.deepStrictEqual(run.candidateProbeIds, [candidate],
    'a target page with an unidentifiable item cannot establish complete inventory');
  assert.deepStrictEqual(run.inserted, [candidate],
    'candidate proven absent by exact membership probe should still insert');
  assert.strictEqual(run.ctx.currentRowStatus.writeWarnings, 1);
  assert.strictEqual(run.ctx.currentRowStatus.writeErrors, 0);
  assert.strictEqual(run.ctx.currentRowStatus.errorCount, 0);
  assert.strictEqual(run.ctx.currentRowStatus.timestampUpdated, true);
  assert.strictEqual(run.timestampWrites, 1);
  assert.ok(run.ctx.__logs.some(line => line.includes('without a video ID')));
}

function testMalformedTargetMembershipItemsWithholdsCandidate() {
  const candidate = 'candidate-with-malformed-membership-response';
  const run = runPartialTargetReadInsertScenario(
    [candidate],
    videoId => ({id: 'unexpected-insert-' + videoId}),
    [],
    {malformedProbeResponses: [candidate]}
  );

  assert.deepStrictEqual(run.candidateProbeIds, [candidate]);
  assert.deepStrictEqual(run.inserted, [],
    'truthy non-array membership.items cannot prove absence and must not reach insertion');
  assert.strictEqual(run.ctx.playlistWriteOperationsUsed, 0);
  assert.strictEqual(run.ctx.currentRowStatus.writeWarnings, 1);
  assert.strictEqual(run.ctx.currentRowStatus.writeErrors, 1);
  assert.strictEqual(run.ctx.currentRowStatus.errorCount, 1);
  assert.strictEqual(run.ctx.currentRowStatus.timestampUpdated, false);
  assert.strictEqual(run.timestampWrites, 0);
}

function testExactLegacyDuplicateReasonMaySafeSkip() {
  const candidate = 'candidate-with-explicit-legacy-duplicate-reason';
  const run = runPartialTargetReadInsertScenario([candidate], videoId => {
    const error = new Error('legacy duplicate detail for ' + videoId);
    error.details = {
      code: 409,
      errors: [{reason: 'videoAlreadyInPlaylist'}]
    };
    throw error;
  });

  assert.deepStrictEqual(run.candidateProbeIds, [candidate]);
  assert.deepStrictEqual(run.inserted, [candidate]);
  assert.strictEqual(run.ctx.currentRowStatus.writeWarnings, 1);
  assert.strictEqual(run.ctx.currentRowStatus.writeErrors, 0,
    'only the exact legacy duplicate reason is eligible for idempotent handling');
  assert.strictEqual(run.ctx.currentRowStatus.errorCount, 0);
  assert.strictEqual(run.ctx.currentRowStatus.timestampUpdated, true);
  assert.strictEqual(run.timestampWrites, 1);
  assert.strictEqual(run.ctx.playlistWriteOperationsUsed, 1);
  assert.ok(run.ctx.__logs.some(line => line.includes('Skipped video already present in playlist: ' + candidate)));
  const summary = run.ctx.__logs.find(line => line.includes('Sequential target progress:'));
  assert.ok(summary && summary.includes('added=0') && summary.includes('insert-race skips=1'),
    'an insert-race duplicate resolves the candidate without being reported as an added video');
}

function testInsertTimeVideoNotFoundBlocksCheckpoint() {
  const candidate = 'validated-candidate-that-disappears-at-insert';
  const run = runPartialTargetReadInsertScenario(
    [candidate],
    videoId => {
      const error = new Error('video disappeared at insertion: ' + videoId);
      error.details = {code: 404, errors: [{reason: 'videoNotFound'}]};
      throw error;
    },
    [],
    {completeTargetInventory: true}
  );

  assert.deepStrictEqual(run.targetListPageTokens, [undefined]);
  assert.deepStrictEqual(run.targetListPageTokenPresence, [false]);
  assert.deepStrictEqual(run.candidateProbeIds, [],
    'a complete target inventory needs no membership fallback');
  assert.deepStrictEqual(run.inserted, [candidate],
    'fixture must reach insert after successful filter and pre-insert metadata validation');
  assert.strictEqual(run.ctx.currentRowStatus.writeWarnings, 0);
  assert.strictEqual(run.ctx.currentRowStatus.writeErrors, 1,
    'insert-time videoNotFound is retryable candidate loss, not an idempotent skip');
  assert.strictEqual(run.ctx.currentRowStatus.errorCount, 1);
  assert.strictEqual(run.ctx.currentRowStatus.timestampUpdated, false);
  assert.strictEqual(run.timestampWrites, 0);
  assert.strictEqual(run.ctx.playlistWriteOperationsUsed, 1);
}

function testGeneric409AfterPartialTargetProbeBlocksCheckpoint() {
  const candidate = 'candidate-with-generic-insert-conflict';
  const run = runPartialTargetReadInsertScenario([candidate], videoId => {
    const error = new Error('generic insert conflict for ' + videoId);
    error.details = {code: 409, errors: [{reason: 'conflict'}]};
    throw error;
  });

  assert.deepStrictEqual(run.targetListPageTokens, [undefined, 'unreadable-target-page-2']);
  assert.deepStrictEqual(run.targetListPageTokenPresence, [false, true]);
  assert.deepStrictEqual(run.candidateProbeIds, [candidate]);
  assert.deepStrictEqual(run.inserted, [candidate],
    'the candidate must reach insertion despite the later target-page failure');
  assert.strictEqual(run.ctx.currentRowStatus.writeWarnings, 1);
  assert.strictEqual(run.ctx.currentRowStatus.writeErrors, 1);
  assert.strictEqual(run.ctx.currentRowStatus.errorCount, 1,
    'a generic 409 is not proof of a duplicate and must retain the retry checkpoint');
  assert.strictEqual(run.ctx.currentRowStatus.timestampUpdated, false);
  assert.strictEqual(run.timestampWrites, 0);
  assert.deepStrictEqual(run.reconciliationProbeIds, [],
    'a definite 4xx rejection must not be mistaken for an uncertain committed mutation');
  assert.ok(run.ctx.__logs.some(line => line.includes('failed=1')),
    'a generic 409 must be reported as a failure, not an idempotent skip, in the progress summary');
}

function testConstructorVideoIdIsNotMistakenForTargetMembership() {
  const targetListCalls = [];
  const metadataCalls = [];
  const inserted = [];
  const removed = [];
  const ctx = makeContext({
    PlaylistItems: {
      list(part, options) {
        targetListCalls.push(Object.assign({}, options));
        return {items: []};
      },
      insert(resource) {
        const videoId = resource.snippet.resourceId.videoId;
        inserted.push(videoId);
        return {id: 'playlist-item-' + videoId};
      },
      remove(playlistItemId) {
        removed.push(playlistItemId);
      }
    },
    Videos: {
      list(part, options) {
        metadataCalls.push(options.id);
        return {items: options.id.split(',').map(id => normalUpload(id, 'PT20M'))};
      }
    }
  });
  ctx.currentRowStatus = ctx.createRowStatus();
  ctx.targetPlaylistVideoCache = Object.create(null);
  ctx.maxPlaylistWriteOperationsPerRun = 10;
  ctx.playlistWriteOperationsUsed = 0;

  ctx.addVideosToPlaylist('PL_TARGET', ['constructor']);

  assert.strictEqual(targetListCalls.length, 1);
  assert.ok(!Object.prototype.hasOwnProperty.call(targetListCalls[0], 'pageToken'));
  assert.deepStrictEqual(inserted, ['constructor'],
    'an empty target inventory must not inherit a phantom constructor membership');
  assert.deepStrictEqual(metadataCalls, ['constructor', 'constructor'],
    'the inherited-key candidate must pass both pre- and post-insert strict validation');
  assert.deepStrictEqual(removed, []);
  assert.strictEqual(ctx.playlistWriteOperationsUsed, 1);
  assert.strictEqual(ctx.currentRowStatus.writeErrors, 0);
  assert.strictEqual(ctx.currentRowStatus.errorCount, 0);
}

function testWriteBudgetRequiresRollbackCapacity() {
  let insertCalls = 0;
  const ctx = makeContext({
    Videos: {
      list(part, options) {
        return {items: options.id.split(',').map(id => normalUpload(id, 'PT10M'))};
      }
    },
    PlaylistItems: {insert: () => { insertCalls += 1; }}
  });
  ctx.currentRowStatus = ctx.createRowStatus();
  ctx.targetPlaylistVideoCache = {'PL_TARGET': {}};
  ctx.maxPlaylistWriteOperationsPerRun = 1;
  ctx.playlistWriteOperationsUsed = 0;

  ctx.addVideosToPlaylist('PL_TARGET', ['a', 'b', 'c']);
  assert.strictEqual(insertCalls, 0, 'one remaining write is unsafe because no rollback write can be reserved');
  assert.strictEqual(ctx.playlistWriteOperationsUsed, 0);
  assert.strictEqual(ctx.currentRowStatus.writeErrors, 1);
}

function testLoggerFailureDuringPostInsertMetadataFailureStillRollsBack() {
  let metadataCalls = 0;
  const removed = [];
  const ctx = makeContext({
    Videos: {
      list(part, options) {
        metadataCalls += 1;
        if (metadataCalls === 1) {
          return {items: options.id.split(',').map(id => normalUpload(id, 'PT20M'))};
        }
        throw new Error('post-insert metadata unavailable');
      }
    },
    PlaylistItems: {
      insert() { return {id: 'playlist-item-before-postcheck-failure'}; },
      remove(playlistItemId) { removed.push(playlistItemId); }
    }
  });
  ctx.Logger.log = () => { throw new Error('logger unavailable'); };
  ctx.currentRowStatus = ctx.createRowStatus();
  ctx.targetPlaylistVideoCache = {'PL_TARGET': {}};
  ctx.maxPlaylistWriteOperationsPerRun = 10;
  ctx.playlistWriteOperationsUsed = 0;

  ctx.addVideosToPlaylist('PL_TARGET', ['candidate-before-postcheck-failure']);

  assert.strictEqual(metadataCalls, 2);
  assert.deepStrictEqual(removed, ['playlist-item-before-postcheck-failure'],
    'a logger outage must not preempt mandatory rollback after metadata failure');
  assert.strictEqual(ctx.currentRowStatus.policyErrors, 1,
    'blocking state must be recorded before best-effort logging');
  assert.strictEqual(ctx.currentRowStatus.errorCount, 1);
  assert.strictEqual(ctx.playlistWriteOperationsUsed, 2);
}

function testLoggerFailureDuringLaterDuplicateStillPostValidatesEarlierInsert() {
  let metadataCalls = 0;
  const insertAttempts = [];
  const removed = [];
  const ctx = makeContext({
    Videos: {
      list(part, options) {
        metadataCalls += 1;
        // V5.8 revalidates each candidate immediately before its own insertion, so
        // the first two calls are the per-candidate pre-insert revalidations and
        // only the third call is the post-insert validation of the earlier success.
        if (metadataCalls <= 2) {
          return {items: options.id.split(',').map(id => normalUpload(id, 'PT20M'))};
        }
        throw new Error('post-insert metadata unavailable after duplicate');
      }
    },
    PlaylistItems: {
      insert(resource) {
        const videoId = resource.snippet.resourceId.videoId;
        insertAttempts.push(videoId);
        if (videoId === 'later-duplicate') {
          const error = new Error('already present');
          error.details = {code: 409, errors: [{reason: 'videoAlreadyInPlaylist'}]};
          throw error;
        }
        return {id: 'playlist-item-earlier-success'};
      },
      remove(playlistItemId) { removed.push(playlistItemId); }
    }
  });
  ctx.Logger.log = () => { throw new Error('logger unavailable'); };
  ctx.currentRowStatus = ctx.createRowStatus();
  ctx.targetPlaylistVideoCache = {'PL_TARGET': {}};
  ctx.maxPlaylistWriteOperationsPerRun = 10;
  ctx.playlistWriteOperationsUsed = 0;

  ctx.addVideosToPlaylist('PL_TARGET', ['earlier-success', 'later-duplicate']);

  assert.deepStrictEqual(insertAttempts, ['earlier-success', 'later-duplicate']);
  assert.strictEqual(metadataCalls, 3,
    'two per-candidate pre-insert revalidations plus one post-insert check must all run despite the duplicate-branch log failure');
  assert.deepStrictEqual(removed, ['playlist-item-earlier-success']);
  assert.strictEqual(ctx.currentRowStatus.policyErrors, 1);
  assert.strictEqual(ctx.currentRowStatus.errorCount, 1);
  assert.strictEqual(ctx.playlistWriteOperationsUsed, 3);
}

function testLoggerOutagePersistsInMemoryRowEvidenceAndKeepsAggregate() {
  const persistedRows = [];
  let lockReleased = false;
  const data = [
    [],
    [],
    ['Playlist ID'],
    ['PL_TARGET', 'not-a-checkpoint', 0, 0, '', '']
  ];
  const sheet = {
    toString: () => 'Sheet',
    getDataRange: () => ({getValues: () => data}),
    getLastRow: () => data.length,
    getLastColumn: () => 6,
    getRange(row, column) {
      if (row === 'A3') return {getValue: () => 'Playlist ID'};
      return {
        getValue: () => data[row - 1][column - 1],
        setValue() { throw new Error('invalid checkpoint row must never write'); }
      };
    }
  };
  const debugSheet = {
    getRange() {
      return {
        setValues(rows) { persistedRows.push(...rows); },
        setValue() {}
      };
    }
  };
  const debugViewer = {};
  const spreadsheet = {
    getSheets: () => [sheet],
    getSheetByName(name) {
      if (name === 'VideoRetries') return {getDataRange: () => ({getValues: () => [ctx.videoRetryHeaders]})};
      if (name === 'DebugData') return debugSheet;
      if (name === 'Debug') return debugViewer;
      return null;
    }
  };
  const ctx = makeContext({});
  ctx.Logger.log = () => { throw new Error('logger write unavailable'); };
  ctx.Logger.clear = () => { throw new Error('logger clear unavailable'); };
  ctx.Logger.getLog = () => { throw new Error('logger read unavailable'); };
  ctx.LockService = {
    getScriptLock() {
      return {
        tryLock: () => true,
        releaseLock: () => { lockReleased = true; }
      };
    }
  };
  ctx.PropertiesService = {
    getScriptProperties() {
      return {getProperty: () => 'sheet-id'};
    }
  };
  ctx.SpreadsheetApp = {openById: () => spreadsheet};
  ctx.getNextDebugCol = () => 0;
  ctx.getNextDebugRow = () => 0;
  ctx.initDebugEntry = () => {};
  ctx.loadLastDebugLog = () => {};

  assert.throws(
    () => ctx.updatePlaylists(sheet),
    error => error && /1 error\(s\) occurred/.test(error.message),
    'the row aggregate, not the broken logger, must remain the terminal error'
  );
  assert.ok(persistedRows.some(row => String(row[1]).includes('invalid checkpoint timestamp')),
    'DebugData must receive substantive row evidence from the in-memory fallback');
  assert.ok(persistedRows.some(row => String(row[1]).includes('using complete in-memory row evidence')),
    'the persisted evidence should disclose why the Logger stream was bypassed');
  assert.strictEqual(ctx.totalErrorCount, 1);
  assert.strictEqual(lockReleased, true);
}

function testInsertCapacityBoundsWritesWhileMembershipReadsKeepGoing() {
  const candidates = Array.from({length: 10}, (_, index) => 'bounded-candidate-' + index);
  const run = runPartialTargetReadInsertScenario(
    candidates,
    videoId => ({id: 'playlist-item-for-' + videoId}),
    [],
    {maxWriteOperations: 6}
  );

  assert.deepStrictEqual(run.inserted, candidates.slice(0, 3),
    'the rollback-safe insert capacity still bounds mutation attempts per execution');
  assert.strictEqual(run.ctx.playlistWriteOperationsUsed, 3);
  assert.deepStrictEqual(run.candidateProbeIds, candidates.slice(0, 4),
    'membership reads are no longer tied to the write budget; only the capacity stop ends the walk');
  assert.strictEqual(run.ctx.targetMembershipProbesUsed, 4);
  assert.strictEqual(run.ctx.currentRowStatus.writeErrors, 1,
    'the withheld backlog must create a blocking retry condition');
  assert.strictEqual(run.ctx.currentRowStatus.timestampUpdated, false);
  assert.strictEqual(run.timestampWrites, 0,
    'a bounded partial pass must retain the row checkpoint');
  const summary = run.ctx.__logs.find(line => line.includes('Sequential target progress:'));
  assert.ok(summary && summary.includes('checked=4') && summary.includes('added=3') &&
    summary.includes('stoppedEarly=true'));
}

function testQuotaExhaustedMembershipProbeStopsAndKeepsResolvedCandidates() {
  const candidates = ['resolved-before-quota', 'quota-failure', 'withheld-after-quota-1', 'withheld-after-quota-2'];
  const run = runPartialTargetReadInsertScenario(
    candidates,
    videoId => ({id: 'playlist-item-for-' + videoId}),
    [],
    {maxWriteOperations: 10, quotaFailureProbe: 'quota-failure'}
  );

  assert.deepStrictEqual(run.candidateProbeIds, candidates.slice(0, 2),
    'quota exhaustion must stop all later exact probes immediately');
  assert.deepStrictEqual(run.inserted, ['resolved-before-quota'],
    'a candidate proven absent before quota exhaustion must not be discarded');
  assert.strictEqual(run.ctx.targetMembershipProbesUsed, 2);
  assert.ok(run.ctx.targetMembershipQuotaFailure,
    'quota exhaustion must latch for the rest of the execution');
  assert.strictEqual(run.ctx.currentRowStatus.writeErrors, 1);
  assert.strictEqual(run.ctx.currentRowStatus.timestampUpdated, false);
  assert.strictEqual(run.timestampWrites, 0);
}

function testMembershipReadsAreNoLongerCappedByTheExecutionWriteBudget() {
  const probes = [];
  const inserted = [];
  const ctx = makeContext({
    PlaylistItems: {
      list(part, options) {
        assert.ok(options.videoId, 'pre-seeded partial inventories should only require exact probes');
        probes.push(options.videoId);
        return {
          items: options.videoId.indexOf('present-') === 0
            ? [{id: 'playlist-item-' + options.videoId}]
            : []
        };
      },
      insert(resource) {
        const videoId = resource.snippet.resourceId.videoId;
        inserted.push(videoId);
        return {id: 'playlist-item-' + videoId};
      },
      remove() {}
    },
    Videos: {
      list(part, options) {
        return {items: options.id.split(',').map(id => normalUpload(id, 'PT20M'))};
      }
    }
  });
  ctx.currentRowStatus = ctx.createRowStatus();
  ctx.targetPlaylistVideoCache = {
    PL_ONE: {videoSet: Object.create(null), complete: false, pagesRead: 1},
    PL_TWO: {videoSet: Object.create(null), complete: false, pagesRead: 1}
  };
  ctx.maxPlaylistWriteOperationsPerRun = 6;
  ctx.playlistWriteOperationsUsed = 0;
  ctx.targetMembershipProbesUsed = 0;

  ctx.addVideosToPlaylist('PL_ONE', ['present-one', 'present-two']);
  ctx.addVideosToPlaylist('PL_TWO', ['fresh-one', 'fresh-two', 'fresh-three']);

  assert.deepStrictEqual(probes, ['present-one', 'present-two', 'fresh-one', 'fresh-two', 'fresh-three'],
    'every candidate is resolved in order; reads are never withheld to protect the write budget');
  assert.deepStrictEqual(inserted, ['fresh-one', 'fresh-two', 'fresh-three'],
    'writes stay bounded by the rollback-safe capacity, which is large enough for this pair of rows');
  assert.strictEqual(ctx.targetMembershipProbesUsed, 5);
  assert.strictEqual(ctx.currentRowStatus.writeErrors, 0,
    'five membership reads across two rows must not create a blocking read ceiling');
  assert.ok(!ctx.__logs.some(line => line.includes('probe limit of')),
    'the execution-wide probe ceiling must be gone from ordinary sequential processing');
}

function testBlankCheckpointBypassesLongFrequencyAndHonorsSuppression() {
  const fixedNowMillis = Date.parse('2026-03-29T12:00:00Z');
  function runBlank(mode, sourceFailure) {
    const timestampWrites = [];
    let sourceReads = 0;
    let playlistMutations = 0;
    const ctx = makeContext({
      PlaylistItems: {
        list(part, options) {
          sourceReads += 1;
          assert.strictEqual(options.playlistId, 'PL_BLANK_CHECKPOINT_SOURCE');
          if (sourceFailure) {
            const error = new Error('first blank-row source read failed');
            error.details = {code: 503, errors: [{reason: 'backendError'}]};
            throw error;
          }
          return {items: []};
        },
        insert() { playlistMutations += 1; },
        remove() { playlistMutations += 1; }
      }
    });
    class ControlledDate extends Date {
      constructor(...args) {
        super(...(args.length ? args : [fixedNowMillis]));
      }
      static now() { return fixedNowMillis; }
      setHours() {
        throw new Error('blank retry horizon must use elapsed milliseconds, not wall-clock setHours');
      }
    }
    ctx.Date = ControlledDate;
    ctx.currentRowStatus = ctx.createRowStatus();
    ctx.experimentDryRun = mode === 'dry-run';
    ctx.debugFlag_dontUpdateTimestamp = mode === 'timestamp-flag';
    const sheet = {
      getLastColumn: () => 7,
      getRange() {
        return {
          getValue: () => '',
          setValue: value => { timestampWrites.push(value); }
        };
      }
    };
    const data = [[], [], [], [
      'PL_TARGET', '', 48, 0, '', '', 'PL_BLANK_CHECKPOINT_SOURCE'
    ]];
    ctx.processPlaylistRow(sheet, data, 3, 'PL_TARGET');
    return {ctx, timestampWrites, sourceReads, playlistMutations};
  }

  const dryRun = runBlank('dry-run', false);
  assert.strictEqual(dryRun.timestampWrites.length, 0,
    'strict dry run must keep a blank default checkpoint entirely in memory');
  assert.strictEqual(dryRun.sourceReads, 1,
    'a blank 48-hour dry-run row must be eligible immediately');
  assert.strictEqual(dryRun.playlistMutations, 0);
  assert.strictEqual(dryRun.ctx.currentRowStatus.timestampUpdated, false);
  assert.ok(dryRun.ctx.__logs.some(line => line.includes('Timestamp and playlist were not modified')));
  assert.ok(!dryRun.ctx.__logs.some(line => line.includes('Skipped: Not time yet')),
    'a synthetic blank-row horizon must not make a 48-hour dry run permanently ineligible');

  const timestampFlag = runBlank('timestamp-flag', false);
  assert.strictEqual(timestampFlag.timestampWrites.length, 0);
  assert.strictEqual(timestampFlag.sourceReads, 0,
    'without a durable retry floor, timestamp-suppressed mutation mode must stop before source APIs');
  assert.strictEqual(timestampFlag.playlistMutations, 0);
  assert.strictEqual(timestampFlag.ctx.currentRowStatus.timestampUpdated, false);
  assert.strictEqual(timestampFlag.ctx.currentRowStatus.sourceErrors, 1);
  assert.ok(timestampFlag.ctx.__logs.some(line => line.includes('Set a real checkpoint timestamp')));

  const normalBootstrap = runBlank('normal', false);
  assert.strictEqual(normalBootstrap.timestampWrites.length, 2,
    'normal bootstrap must persist a retry floor before reads and the frozen cutoff after success');
  assert.strictEqual(
    fixedNowMillis - Date.parse(normalBootstrap.timestampWrites[0]),
    24 * 60 * 60 * 1000,
    'the retry floor must be exactly 24 elapsed hours even across the spring DST transition'
  );
  assert.strictEqual(normalBootstrap.sourceReads, 1,
    'a blank 48-hour normal row must bypass its first frequency gate');
  assert.strictEqual(normalBootstrap.playlistMutations, 0);
  assert.strictEqual(normalBootstrap.ctx.currentRowStatus.checkpointSeeded, true);
  assert.strictEqual(normalBootstrap.ctx.currentRowStatus.timestampUpdated, true);
  assert.ok(!normalBootstrap.ctx.__logs.some(line => line.includes('Skipped: Not time yet')));

  const failedBootstrap = runBlank('normal', true);
  assert.strictEqual(failedBootstrap.timestampWrites.length, 1,
    'a failed first run must retain exactly the conservative seed for a stable retry floor');
  assert.strictEqual(failedBootstrap.sourceReads, 1);
  assert.strictEqual(failedBootstrap.playlistMutations, 0);
  assert.strictEqual(failedBootstrap.ctx.currentRowStatus.checkpointSeeded, true);
  assert.strictEqual(failedBootstrap.ctx.currentRowStatus.timestampUpdated, false);
  assert.strictEqual(failedBootstrap.ctx.currentRowStatus.sourceErrors, 1);
}

function testMissingOrInvalidInsertResponseIdBlocksAndRequiresManualReview() {
  const invalidResponses = [undefined, {}, {id: '   '}, {id: 12345}];
  invalidResponses.forEach((invalidResponse, index) => {
    const candidate = 'candidate-with-invalid-insert-response-' + index;
    const run = runPartialTargetReadInsertScenario(
      [candidate],
      () => invalidResponse,
      [],
      {completeTargetInventory: true}
    );

    assert.deepStrictEqual(run.inserted, [candidate]);
    assert.deepStrictEqual(run.removed, [],
      'without an unambiguous reconciliation handle production must not delete an arbitrary item');
    assert.ok(run.ctx.currentRowStatus.writeErrors >= 2,
      'the malformed insert response and failed reconciliation must both remain blocking');
    assert.strictEqual(run.ctx.currentRowStatus.timestampUpdated, false);
    assert.strictEqual(run.timestampWrites, 0,
      'a likely but untracked insertion must never advance the checkpoint');
    assert.ok(run.ctx.__logs.some(line => line.includes('manual target-playlist review is required')));
    assert.ok(run.ctx.__logs.some(line =>
      line.includes('Sequential target progress:') && line.includes('added=0') && line.includes('failed=1')),
      'a malformed response must not be reported as a successful add');
  });
}

function testMissingInsertResponseIdReconcilesUniqueItemAndRollsBack() {
  const candidate = 'candidate-with-recoverable-insert-handle';
  const run = runPartialTargetReadInsertScenario(
    [candidate],
    () => ({}),
    [candidate],
    {completeTargetInventory: true}
  );

  assert.deepStrictEqual(run.inserted, [candidate]);
  assert.deepStrictEqual(run.removed, ['existing-playlist-item-for-' + candidate],
    'an exact single-item reconciliation should consume the reserved rollback operation');
  assert.strictEqual(run.ctx.playlistWriteOperationsUsed, 2);
  assert.strictEqual(run.ctx.currentRowStatus.writeErrors, 1,
    'even a recovered rollback must retain the checkpoint after a malformed insert response');
  assert.strictEqual(run.ctx.currentRowStatus.timestampUpdated, false);
  assert.strictEqual(run.timestampWrites, 0);
}

function testMissingInsertIdReconciliationQuotaLatchesLaterProbes() {
  const candidate = 'candidate-with-quota-blocked-reconciliation';
  const run = runPartialTargetReadInsertScenario(
    [candidate],
    () => ({}),
    [],
    {
      completeTargetInventory: true,
      quotaFailureProbe: candidate
    }
  );

  assert.deepStrictEqual(run.reconciliationProbeIds, [candidate]);
  assert.ok(run.ctx.targetMembershipQuotaFailure,
    'quota exhaustion during rollback-handle recovery must latch execution-wide');
  const probeCountBeforeLaterRow = run.candidateProbeIds.length + run.reconciliationProbeIds.length;
  const laterResult = run.ctx.checkTargetVideoMembership(
    'PL_LATER_TARGET',
    'later-row-candidate',
    {videoSet: Object.create(null), complete: false, pagesRead: 1}
  );
  const probeCountAfterLaterRow = run.candidateProbeIds.length + run.reconciliationProbeIds.length;

  assert.strictEqual(probeCountAfterLaterRow, probeCountBeforeLaterRow,
    'a latched quota failure must prevent later-row membership requests');
  assert.strictEqual(laterResult, 'unknown',
    'a latched quota failure makes every later membership question undecidable');
  assert.strictEqual(run.ctx.currentRowStatus.timestampUpdated, false);
  assert.strictEqual(run.timestampWrites, 0);
}

function testZeroWriteCapacityStillAdvancesWhenTargetProvesAllPresent() {
  const candidate = 'already-present-with-zero-write-capacity';
  const run = runPartialTargetReadInsertScenario(
    [candidate],
    () => { throw new Error('known-present candidate must not be inserted'); },
    [],
    {
      completeTargetInventory: true,
      completeInventoryIds: [candidate],
      maxWriteOperations: 1
    }
  );

  assert.deepStrictEqual(run.inserted, []);
  assert.deepStrictEqual(run.candidateProbeIds, []);
  assert.strictEqual(run.ctx.playlistWriteOperationsUsed, 0);
  assert.strictEqual(run.ctx.currentRowStatus.writeErrors, 0,
    'zero mutation capacity is harmless when complete inventory proves every candidate present');
  assert.strictEqual(run.ctx.currentRowStatus.timestampUpdated, true);
  assert.strictEqual(run.timestampWrites, 1);
}

function testDeletionReadsAllPagesBeforeMutation() {
  const events = [];
  const listOptions = [];
  const ctx = makeContext({
    PlaylistItems: {
      list(part, options) {
        events.push('list');
        listOptions.push(Object.assign({}, options));
        if (!options.pageToken) {
          return {
            nextPageToken: 'page-2',
            items: [
              {id: 'old-item', contentDetails: {videoId: 'a', videoPublishedAt: '2020-01-01T00:00:00Z'}},
              {id: 'keep-item', contentDetails: {videoId: 'b', videoPublishedAt: '2026-07-18T00:00:00Z'}}
            ]
          };
        }
        return {items: [
          {id: 'duplicate-item', contentDetails: {videoId: 'b', videoPublishedAt: '2026-07-18T00:00:00Z'}}
        ]};
      },
      remove(itemId) { events.push('remove:' + itemId); }
    }
  });
  ctx.currentRowStatus = ctx.createRowStatus();
  ctx.playlistWriteOperationsUsed = 0;
  ctx.maxPlaylistWriteOperationsPerRun = 10;
  ctx.deletePlaylistItems('PL_TARGET', '2026-01-01T00:00:00Z');

  assert.deepStrictEqual(events, ['list', 'list', 'remove:old-item', 'remove:duplicate-item']);
  listOptions.forEach(options => {
    assert.ok(!Object.prototype.hasOwnProperty.call(options, 'order'));
    assert.ok(!Object.prototype.hasOwnProperty.call(options, 'publishedBefore'));
  });
}

function testConstructorFirstCleanupOccurrenceIsNotDuplicate() {
  const listOptions = [];
  const removed = [];
  const ctx = makeContext({
    PlaylistItems: {
      list(part, options) {
        listOptions.push(Object.assign({}, options));
        return {items: [{
          id: 'playlist-item-constructor',
          contentDetails: {
            videoId: 'constructor',
            videoPublishedAt: '2026-08-22T00:00:00Z'
          }
        }]};
      },
      remove(playlistItemId) {
        removed.push(playlistItemId);
      }
    }
  });
  ctx.currentRowStatus = ctx.createRowStatus();
  ctx.maxPlaylistWriteOperationsPerRun = 10;
  ctx.playlistWriteOperationsUsed = 0;

  ctx.deletePlaylistItems('PL_TARGET', '2026-01-01T00:00:00Z');

  assert.strictEqual(listOptions.length, 1);
  assert.ok(!Object.prototype.hasOwnProperty.call(listOptions[0], 'pageToken'));
  assert.deepStrictEqual(removed, [],
    'the first non-old constructor video must not be mistaken for an inherited duplicate');
  assert.strictEqual(ctx.playlistWriteOperationsUsed, 0);
  assert.strictEqual(ctx.currentRowStatus.maintenanceWarnings, 0);
  assert.strictEqual(ctx.currentRowStatus.errorCount, 0);
}

const tests = [
  testExplicitPlaylistUsesSupportedPagination,
  testMissingSourceWarnsHealthyInsertAndAdvancesTimestamp,
  testMissingUploadsPlaylistWarnsHealthyInsertAndAdvancesTimestamp,
  testTransientSourceErrorStillBlocksCheckpoint,
  testMixedKnownBroadcastsRejectNormalUploadInsertsAndCheckpointAdvances,
  testInvalidCheckpointTimestampBlocksBeforeAnyApiOrWrite,
  testAggregateRowFailureDoesNotStopLaterRowCheckpoint,
  testDebugSetupFailuresDoNotBlockValidPlaylistRows,
  testBufferedDebugEvidenceChunksOversizedLines,
  testRowWritesFrozenCutoffCapturedBeforeSourceRead,
  testExplicitSourceIncludesItemEqualToSecondResolutionCheckpoint,
  testUploadsSourceIncludesItemEqualToSecondResolutionCheckpoint,
  testExplicitSourceLaterPage404BlocksCheckpointButKeepsCandidates,
  testUploadsSourceLaterPage404BlocksCheckpointButKeepsCandidates,
  testMalformedUploadsItemBlocksAndPreventsAllOldEarlyStop,
  testExperimentFirstPageMissingWarnsForUploadsAndExplicit,
  testExperimentLaterPageMissingBlocksForUploadsAndExplicit,
  testExperimentAllSubscriptionFailuresAndMalformedItemsAreBlocking,
  testExperimentMissingTargetReadIsBlocking,
  testExperimentMalformedTargetItemBlocksReplayCheckpoint,
  testExperimentReplayRejectsKnownBroadcastsWithoutBlockingCheckpoint,
  testExperimentVideoMetadata404IsBlocking,
  testExperimentVideoMetadataBatchesOmitUnsupportedMaxResults,
  testCleanupFailureWarnsButDoesNotFreezeIngestionCheckpoint,
  testStrictClassificationOracle,
  testStrictAdmissionRejectsEveryKnownBroadcastWithoutDurationException,
  testStrictCompletedBroadcastGoldenCorpusIsUniformlyRejected,
  testStrictYoutubeTimestampGrammarAndExperimentParity,
  testStrictFilterUsesSharedAdmissionDecision,
  testCompletedBroadcastEvidenceQualityDoesNotCreateAnAdmissionException,
  testConstructorVideoIdSurvivesDedupeAndStrictFilter,
  testUnknownMetadataIsFailClosedAndBlocksCheckpoint,
  testSuccessfulMetadataResponseOmissionIsWithheld,
  testStrictShortFilterRemainsIndependent,
  testFilterBatchFailureDoesNotCancelLaterBatch,
  testVideoMetadataUsesOneRequestPerFiftyIds,
  testExperimentAdmissionFallbackMatchesProductionPolicy,
  testExperimentReplaySummaryAggregatesAndOmitsSensitiveLists,
  testExperimentReplaySummaryStaysBelowAppsScriptLogLimit,
  testTargetAccessDiagnosticIsReadOnlyTrimmedHashedAndSourceStable,
  testPremiereExperimentTargetVerificationIsExactReadOnlyAndPrivate,
  testStrictTargetAuditPaginatesBatchesClassifiesAndNeverMutates,
  testStrictTargetAuditMetadataBatchFailureIsUnknownAndBlocking,
  testStrictTargetAuditMetadataOmissionIsWithheldAndBlocking,
  testStrictTargetAuditMalformedPlaylistItemsAreWithheldAndBlocking,
  testTargetAuditCountsEveryCompletedBroadcastAsForbidden,
  testPreInsertRevalidationRejectsUpcomingWithoutBlocking,
  testPreInsertRevalidationRejectsCompletedBroadcastAtAnyDuration,
  testPreInsertCompletedBroadcastNeedsNoDurationOrTimestampEvidence,
  testCompletedBroadcastNeverReachesInsertion,
  testPostInsertCompletedBroadcastMarkerRollsBackWithoutBlocking,
  testPostInsertTransitionFromUploadToCompletedBroadcastRollsBack,
  testPostInsertTransitionIsRolledBack,
  testFirstTargetPageFailureBlocksWithoutProbesOrInserts,
  testPartialTargetReadUsesCandidateProbesAndContinues,
  testUnverifiableMembershipStopsSequentialProgressAndRetainsCheckpoint,
  testMalformedTargetInventoryItemForcesExactMembershipProbe,
  testMalformedTargetMembershipItemsWithholdsCandidate,
  testExactLegacyDuplicateReasonMaySafeSkip,
  testInsertTimeVideoNotFoundBlocksCheckpoint,
  testGeneric409AfterPartialTargetProbeBlocksCheckpoint,
  testConstructorVideoIdIsNotMistakenForTargetMembership,
  testWriteBudgetRequiresRollbackCapacity,
  testLoggerFailureDuringPostInsertMetadataFailureStillRollsBack,
  testLoggerFailureDuringLaterDuplicateStillPostValidatesEarlierInsert,
  testLoggerOutagePersistsInMemoryRowEvidenceAndKeepsAggregate,
  testInsertCapacityBoundsWritesWhileMembershipReadsKeepGoing,
  testQuotaExhaustedMembershipProbeStopsAndKeepsResolvedCandidates,
  testMembershipReadsAreNoLongerCappedByTheExecutionWriteBudget,
  testBlankCheckpointBypassesLongFrequencyAndHonorsSuppression,
  testMissingOrInvalidInsertResponseIdBlocksAndRequiresManualReview,
  testMissingInsertResponseIdReconcilesUniqueItemAndRollsBack,
  testMissingInsertIdReconciliationQuotaLatchesLaterProbes,
  testZeroWriteCapacityStillAdvancesWhenTargetProvesAllPresent,
  testDeletionReadsAllPagesBeforeMutation,
  testConstructorFirstCleanupOccurrenceIsNotDuplicate
];
const failures = [];
for (const test of tests) {
  try {
    test();
    console.log('PASS', test.name);
  } catch (error) {
    failures.push({test: test.name, error});
    console.error('FAIL', test.name);
    console.error(error && error.stack ? error.stack : error);
  }
}
if (failures.length) {
  console.error(`FAIL ${failures.length} of ${tests.length} tests`);
  process.exitCode = 1;
} else {
  console.log(`PASS ${tests.length} tests`);
}
