'use strict';

const assert = require('assert');
const fs = require('fs');
const vm = require('vm');
const source = fs.readFileSync(__dirname + '/../sheetScript.gs', 'utf8');

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
          // Apps Script sometimes exposes only this message, without details.code.
          throw new Error("API call failed: The playlist identified with the request's playlistId parameter cannot be found.");
        }
        if (options.playlistId === 'PL_TARGET_12345') return {items: []};
        throw new Error('unexpected playlist lookup ' + options.playlistId + ' / ' + part);
      },
      insert(resource) {
        inserted.push(resource.snippet.resourceId.videoId);
      },
      remove() {}
    }
  });
  const sheet = {
    getLastColumn: () => 8,
    getRange(row, column) {
      return {
        getValue: () => (column === 5 || column === 6 ? 'Yes' : ''),
        setValue: () => { timestampWrites += 1; }
      };
    }
  };
  const data = [[], [], [], [
    'PL_TARGET_12345', '2026-07-17T00:00:00Z', 0, 0, 'Yes', 'Yes',
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
  assert.strictEqual(timestampWrites, 1, 'permanently missing source must not freeze the row checkpoint');
  assert.strictEqual(ctx.currentRowStatus.timestampUpdated, true);
}

function testTransientSourceErrorStillBlocksCheckpoint() {
  let timestampWrites = 0;
  const ctx = makeContext({
    PlaylistItems: {
      list() {
        const error = new Error('temporary backend failure');
        error.details = {code: 503, errors: [{reason: 'backendError'}]};
        throw error;
      }
    }
  });
  const sheet = {
    getLastColumn: () => 7,
    getRange(row, column) {
      return {
        getValue: () => (column === 5 || column === 6 ? 'Yes' : ''),
        setValue: () => { timestampWrites += 1; }
      };
    }
  };
  const data = [[], [], [], [
    'PL_TARGET_12345', '2026-07-20T00:00:00Z', 0, 0, 'Yes', 'Yes', 'PL_TRANSIENT_12345'
  ]];

  ctx.currentRowStatus = ctx.createRowStatus();
  ctx.processPlaylistRow(sheet, data, 3, 'PL_TARGET_12345');

  assert.strictEqual(ctx.currentRowStatus.sourceErrors, 1);
  assert.strictEqual(ctx.currentRowStatus.sourceWarnings, 0);
  assert.strictEqual(timestampWrites, 0, 'transient source failures must retain the retry checkpoint');
  assert.strictEqual(ctx.currentRowStatus.timestampUpdated, false);
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
function testFilterMetadataIsBatchedAndUpcomingIsKept() {
  const ids = Array.from({length: 50}, (_, i) => 'video-' + i);
  let listCalls = 0;
  const ctx = makeContext({
    Videos: {
      list(part, options) {
        listCalls += 1;
        assert.strictEqual(options.id.split(',').length, 50);
        return {items: ids.map((id, index) => {
          if (index === 0) return {id, snippet: {liveBroadcastContent: 'none'}, contentDetails: {duration: 'PT2M'}};
          if (index === 1) return {
            id,
            snippet: {liveBroadcastContent: 'live'},
            contentDetails: {duration: 'PT3H'},
            liveStreamingDetails: {actualStartTime: '2026-07-18T00:00:00Z'}
          };
          if (index === 2) return {
            id,
            snippet: {liveBroadcastContent: 'upcoming'},
            contentDetails: {duration: 'P0D'},
            liveStreamingDetails: {scheduledStartTime: '2026-07-19T00:00:00Z'}
          };
          if (index === 3) return {
            id,
            snippet: {liveBroadcastContent: 'none'},
            contentDetails: {duration: 'PT3H'},
            liveStreamingDetails: {
              actualStartTime: '2026-07-17T00:00:00Z',
              actualEndTime: '2026-07-17T03:00:01Z'
            }
          };
          return {id, snippet: {liveBroadcastContent: 'none'}, contentDetails: {duration: 'PT10M'}};
        })};
      }
    }
  });
  const sheet = {getRange: () => ({getValue: () => 'No'})};
  ctx.currentRowStatus = ctx.createRowStatus();
  const result = Array.from(ctx.applyFilters(ids, sheet, 3));

  assert.strictEqual(listCalls, 1, '50 videos should require one videos.list call');
  assert.strictEqual(result.length, 47);
  assert.ok(result.includes('video-2'), 'upcoming premiere candidate must remain eligible');
  assert.ok(!result.includes('video-0'));
  assert.ok(!result.includes('video-1'));
  assert.ok(!result.includes('video-3'));
}

function testFilterBatchFailureDoesNotCancelLaterBatch() {
  const ids = Array.from({length: 100}, (_, i) => 'video-' + i);
  let call = 0;
  const ctx = makeContext({
    Videos: {
      list(part, options) {
        call += 1;
        if (call === 1) throw new Error('temporary metadata failure');
        return {items: options.id.split(',').map(id => ({
          id,
          snippet: {liveBroadcastContent: 'none'},
          contentDetails: {duration: 'PT10M'}
        }))};
      }
    }
  });
  const sheet = {getRange: () => ({getValue: () => 'No'})};
  ctx.currentRowStatus = ctx.createRowStatus();
  const result = Array.from(ctx.applyFilters(ids, sheet, 3));

  assert.strictEqual(call, 2);
  assert.strictEqual(result.length, 50);
  assert.strictEqual(result[0], 'video-50');
  assert.strictEqual(ctx.currentRowStatus.filterErrors, 1);
}

function testWriteBudgetRefusesPartialRow() {
  let insertCalls = 0;
  const ctx = makeContext({PlaylistItems: {insert: () => { insertCalls += 1; }}});
  ctx.currentRowStatus = ctx.createRowStatus();
  ctx.targetPlaylistVideoCache = {'PL_TARGET': {}};
  ctx.maxPlaylistWriteOperationsPerRun = 2;
  ctx.playlistWriteOperationsUsed = 0;

  ctx.addVideosToPlaylist('PL_TARGET', ['a', 'b', 'c']);
  assert.strictEqual(insertCalls, 0);
  assert.strictEqual(ctx.playlistWriteOperationsUsed, 0);
  assert.strictEqual(ctx.currentRowStatus.writeErrors, 1);
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

const tests = [
  testExplicitPlaylistUsesSupportedPagination,
  testMissingSourceWarnsHealthyInsertAndAdvancesTimestamp,
  testTransientSourceErrorStillBlocksCheckpoint,
  testCleanupFailureWarnsButDoesNotFreezeIngestionCheckpoint,
  testFilterMetadataIsBatchedAndUpcomingIsKept,
  testFilterBatchFailureDoesNotCancelLaterBatch,
  testWriteBudgetRefusesPartialRow,
  testDeletionReadsAllPagesBeforeMutation
];
for (const test of tests) {
  test();
  console.log('PASS', test.name);
}
console.log(`PASS ${tests.length} tests`);
