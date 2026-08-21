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
  assert.strictEqual(timestampWrites, 1, 'permanently missing source must not freeze the row checkpoint');
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

function testStrictFilterKeepsOnlyNormalUploads() {
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
          normalUpload(ids[0], 'PT12H'),
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
  assert.strictEqual(ctx.currentRowStatus.filterErrors, 0, 'known broadcast classes are policy rejections, not read failures');
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
  const ctx = makeContext({
    Videos: {
      list() {
        return {items: [
          normalUpload('ordinary-short', 'PT2M'),
          normalUpload('ordinary-video', 'PT10M')
        ]};
      }
    }
  });
  ctx.currentRowStatus = ctx.createRowStatus();

  assert.deepStrictEqual(
    Array.from(ctx.applyFilters(['ordinary-short', 'ordinary-video'], strictFilterSheet('No'), 3)),
    ['ordinary-video']
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

  assert.deepStrictEqual(playlistPageTokens, ['', 'audit-page-2']);
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
  assert.strictEqual(report.forbiddenCount, 3);
  assert.strictEqual(report.unknownCount, 1);
  assert.strictEqual(report.mutationPerformed, false);
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
  assert.strictEqual(report.mutationPerformed, false);
  assert.strictEqual(ctx.currentRowStatus.policyErrors, 1);
  assert.strictEqual(ctx.currentRowStatus.errorCount, 1, 'audit read failure must block the checkpoint');
  assert.strictEqual(removeCalls, 0, 'even a failed v5 audit must not mutate the playlist');
}

function testPreInsertRevalidationRejectsStateTransition() {
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
  assert.ok(ctx.__logs.some(line => line.includes('pre-insert') && line.includes('UPCOMING')));
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
  assert.strictEqual(ctx.targetPlaylistVideoCache.PL_TARGET['changed-after-insert'], undefined);
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
  testStrictClassificationOracle,
  testStrictFilterKeepsOnlyNormalUploads,
  testUnknownMetadataIsFailClosedAndBlocksCheckpoint,
  testSuccessfulMetadataResponseOmissionIsWithheld,
  testStrictShortFilterRemainsIndependent,
  testFilterBatchFailureDoesNotCancelLaterBatch,
  testVideoMetadataUsesOneRequestPerFiftyIds,
  testStrictTargetAuditPaginatesBatchesClassifiesAndNeverMutates,
  testStrictTargetAuditMetadataBatchFailureIsUnknownAndBlocking,
  testPreInsertRevalidationRejectsStateTransition,
  testPostInsertTransitionIsRolledBack,
  testWriteBudgetRequiresRollbackCapacity,
  testDeletionReadsAllPagesBeforeMutation
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
