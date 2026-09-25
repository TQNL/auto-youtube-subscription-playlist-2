'use strict';
const assert = require('assert');
const fs = require('fs');
const vm = require('vm');
const source = fs.readFileSync(__dirname + '/../sheetScript.gs', 'utf8');
const HOUR = 3600000;
const start = Date.parse('2026-09-07T00:00:00Z');
const normal = (id, duration = 'PT20M') => ({id, snippet: {title: id, liveBroadcastContent: 'none'}, contentDetails: {duration}});

function fixture(existingRows) {
  const state = {now: start, rows: existingRows || [], writes: [], inserts: [], removes: [], metadataCalls: [],
    checkpoints: [], metadata: ids => ids.map(id => normal(id)), failSave: false, failFlush: false};
  class FakeDate extends Date { constructor(...args) { super(...(args.length ? args : [state.now])); } static now() { return state.now; } }
  let ctx;
  const retrySheet = {
    getDataRange: () => ({getValues: () => state.rows.map(row => row.slice())}),
    setFrozenRows() {}, setColumnWidth() {}, setColumnWidths() {},
    getRange(row, column, rowCount, columnCount) {
      return {
        setValues(values) {
          if (state.failSave) throw Error('retry storage unavailable');
          assert.strictEqual(values.length, rowCount);
          values.forEach((valuesRow, offset) => {
            assert.strictEqual(valuesRow.length, columnCount);
            if (!state.rows[row - 1 + offset]) state.rows[row - 1 + offset] = Array(12).fill('');
            valuesRow.forEach((value, col) => {
              state.rows[row - 1 + offset][column - 1 + col] = typeof value === 'string' && value.startsWith("'") ? value.slice(1) : value;
            });
          });
          state.writes.push({row, column, rowCount, columnCount});
          return this;
        },
        setFontWeight() { return this; }, setBackground() { return this; }, setNumberFormat() { return this; }
      };
    }
  };
  const spreadsheet = {
    getSheetByName: name => name === 'VideoRetries' && state.rows.length ? retrySheet : null,
    insertSheet(name) { assert.strictEqual(name, 'VideoRetries'); return retrySheet; }
  };
  ctx = {Date: FakeDate, console, Logger: {log() {}}, SpreadsheetApp: {
    flush() { if (state.failFlush) throw Error('flush failed'); }, openById: () => spreadsheet
  }, PropertiesService: {getScriptProperties: () => ({getProperty: () => 'spreadsheet'})},
  LockService: {getScriptLock: () => ({tryLock: () => true, releaseLock() {}})},
  YouTube: {Videos: {list(part, options) {
    const ids = options.id.split(',');
    assert.ok(ids.length <= 50);
    state.metadataCalls.push(ids);
    return {items: state.metadata(ids)};
  }}, PlaylistItems: {
    insert(resource) { const id = resource.snippet.resourceId.videoId; if (state.insertError) throw state.insertError;
      state.inserts.push(id); return {id: 'item-' + id}; },
    remove(id) { if (state.rollbackError) throw state.rollbackError; state.removes.push(id); }
  }}};
  vm.createContext(ctx);
  vm.runInContext(source, ctx);
  ctx.videoRetryStore = ctx.openVideoRetryStore(spreadsheet, true);
  const row = ['PL_DESTINATION', '2026-09-06T00:00:00Z', 0, 0, 'Yes', '', 'PL_SOURCE_12345'];
  const sheet = {getLastColumn: () => row.length, getRange(r, c) { return {
    getValue: () => row[c - 1],
    setValue(value) { assert.strictEqual(c, 2); row[1] = value; state.checkpoints.push(value); }
  }; }};
  ctx.getPlaylistVideoIds = () => state.discovered || ['missing', 'healthy'];
  // V5.8 resolves membership one candidate at a time against a possibly partial
  // inventory. A complete fixture inventory proves presence without any read.
  ctx.getTargetPlaylistVideoInventory = () => {
    const videoSet = Object.create(null);
    (state.alreadyPresent || []).forEach(id => { videoSet[id] = true; });
    return {videoSet, complete: true, pagesRead: 1};
  };
  state.reset = function(playlist = 'PL_DESTINATION') {
    ctx.videoRetryStore = ctx.openVideoRetryStore(spreadsheet, true); // Reload persisted state each run.
    ctx.currentRetryPlaylistId = playlist;
    ctx.currentRetryRowNumber = 4;
    ctx.currentRowStatus = ctx.createRowStatus();
    ctx.videoRetryFailuresThisRun = Object.create(null);
    ctx.videoRetrySelectionThisRun = Object.create(null);
    ctx.playlistWriteOperationsUsed = 0;
    ctx.currentRowLogBuffer = [];
  };
  state.run = function() { state.reset(); ctx.processPlaylistRow(sheet, [[], [], [], row], 3, 'PL_DESTINATION'); };
  state.entry = id => ctx.videoRetryStore.entries[ctx.videoRetryKey(ctx.currentRetryPlaylistId, id)];
  state.reset();
  return {ctx, state, spreadsheet, sheet};
}

function waitEntry(f, id = 'missing') {
  for (let attempt = 0; attempt < 4; attempt++) {
    f.state.reset();
    f.ctx.recordRetryableVideoFailure(id, 'filter', 'omitted');
    f.state.now += 2 * HOUR;
  }
  return f.state.entry(id);
}

const tests = {
  insertionRetryCapProcessesHealthyTailBeforeAdvancing() {
    for (const finalAttempt of [false, true]) {
      const f = fixture();
      if (finalAttempt) {
        const entry = waitEntry(f); f.state.now = entry.due;
      } else {
        for (let n = 0; n < 3; n++) {
          f.state.reset(); f.ctx.recordRetryableVideoFailure('missing', 'write', 'previous failure');
        }
      }
      f.state.discovered = ['missing', 'healthy', 'healthy2'];
      f.ctx.YouTube.PlaylistItems.insert = resource => {
        const id = resource.snippet.resourceId.videoId;
        if (id === 'missing') {
          const error = Error('video not found');
          error.details = {errors: [{reason: 'videoNotFound'}]}; throw error;
        }
        f.state.inserts.push(id); return {id: 'item-' + id};
      };
      f.state.run();
      assert.strictEqual(f.state.entry('missing').status, finalAttempt ? 'ABANDONED' : 'WAITING_100H');
      assert.deepStrictEqual(f.state.inserts, ['healthy', 'healthy2']);
      assert.strictEqual(f.ctx.currentRowStatus.errorCount, 0);
      assert.strictEqual(f.ctx.currentRowStatus.timestampUpdated, true);
    }
  },
  insertionFailureBeforeRetryCapStillRetainsCheckpoint() {
    const f = fixture();
    f.state.insertError = Object.assign(Error('video not found'), {details: {errors: [{reason: 'videoNotFound'}]}});
    f.state.run();
    assert.strictEqual(f.state.entry('missing').status, 'RETRYING');
    assert.strictEqual(f.ctx.currentRowStatus.timestampUpdated, false);
    assert.deepStrictEqual(f.state.inserts, []);
  },
  fourFailuresReleaseCheckpointAndPreserveHealthyCandidates() {
    const f = fixture(); f.state.metadata = ids => ids.filter(id => id !== 'missing').map(id => normal(id));
    for (let attempt = 1; attempt <= 4; attempt++) {
      f.state.run();
      assert.strictEqual(f.state.entry('missing').failures, attempt);
      assert.strictEqual(f.ctx.currentRowStatus.timestampUpdated, attempt === 4);
      f.state.now += 2 * HOUR;
    }
    assert.strictEqual(f.state.entry('missing').status, 'WAITING_100H');
    assert.strictEqual(f.state.entry('missing').due, start + 106 * HOUR);
    assert.strictEqual(f.state.inserts.length, 4, 'healthy work proceeds during failures');
    assert.strictEqual(f.state.checkpoints.length, 1);
  },
  waitingSuppressesRediscoveryAndFinalAttemptIgnoresCheckpoint() {
    const f = fixture(); const entry = waitEntry(f);
    f.state.now = entry.due - 1; f.state.reset();
    assert.deepStrictEqual(Array.from(f.ctx.selectVideoRetryCandidates('PL_DESTINATION', ['missing', 'new'])), ['new']);
    f.state.now = entry.due; f.state.discovered = []; f.state.run();
    assert.deepStrictEqual(f.state.inserts, ['missing']);
    assert.strictEqual(f.state.entry('missing').status, 'RESOLVED');
    assert.strictEqual(f.ctx.currentRowStatus.timestampUpdated, true);
  },
  finalMissingResponseAbandonsPermanentlyWithoutInsertion() {
    const f = fixture(); const entry = waitEntry(f);
    f.state.now = entry.due; f.state.discovered = []; f.state.metadata = () => []; f.state.run();
    assert.strictEqual(f.state.entry('missing').status, 'ABANDONED');
    assert.strictEqual(f.state.entry('missing').failures, 5);
    assert.strictEqual(f.ctx.currentRowStatus.errorCount, 0);
    const calls = f.state.metadataCalls.length;
    f.state.now += 1000 * HOUR; f.state.discovered = ['missing']; f.state.run();
    assert.strictEqual(f.state.metadataCalls.length, calls);
    assert.strictEqual(f.state.inserts.length, 0);
  },
  batchQuotaFailureDoesNotConsumeFinalRetry() {
    const f = fixture(); const entry = waitEntry(f);
    f.state.now = entry.due; f.state.discovered = []; f.state.metadata = () => { throw Error('quotaExceeded'); }; f.state.run();
    assert.strictEqual(f.state.entry('missing').status, 'WAITING_100H');
    assert.strictEqual(f.state.entry('missing').failures, 4);
    assert.ok(f.ctx.currentRowStatus.errorCount > 0);
    f.state.now += 4 * HOUR; f.state.metadata = ids => ids.map(id => normal(id)); f.state.run();
    assert.strictEqual(f.state.entry('missing').status, 'RESOLVED');
  },
  invalidWholeBatchDoesNotCreateIndividualFailures() {
    const f = fixture(); f.ctx.YouTube.Videos.list = () => ({}); f.state.run();
    assert.strictEqual(Object.keys(f.ctx.videoRetryStore.entries).length, 0);
    assert.ok(f.ctx.currentRowStatus.filterErrors > 0);
  },
  queueWriteFailureMustNeverReleaseCheckpoint() {
    const f = fixture(); f.state.metadata = () => [];
    for (let n = 0; n < 3; n++) { f.state.run(); f.state.now += 2 * HOUR; }
    f.state.failSave = true; f.state.run();
    assert.strictEqual(f.ctx.currentRowStatus.timestampUpdated, false);
    assert.strictEqual(f.state.entry('missing').failures, 3);
    assert.strictEqual(f.state.entry('missing').status, 'RETRYING');
  },
  flushFailureMustNeverReleaseCheckpoint() {
    const f = fixture(); f.state.metadata = () => []; f.state.failFlush = true; f.state.run();
    assert.strictEqual(f.ctx.currentRowStatus.timestampUpdated, false);
    assert.ok(f.ctx.currentRowStatus.errorCount > 0);
  },
  successfulMetadataBeforeCapDoesNotEraseCountBeforePreInsertCheck() {
    const f = fixture(); f.ctx.recordRetryableVideoFailure('missing', 'filter', 'initial omission');
    f.state.reset(); f.state.discovered = ['missing']; let calls = 0;
    f.state.metadata = ids => ++calls === 1 ? ids.map(id => normal(id)) : [];
    f.state.run();
    assert.strictEqual(f.state.entry('missing').failures, 2);
    assert.strictEqual(f.state.inserts.length, 0);
  },
  finalPreInsertOmissionAbandons() {
    const f = fixture(); const entry = waitEntry(f); f.state.now = entry.due; f.state.discovered = [];
    let calls = 0; f.state.metadata = ids => ++calls === 1 ? ids.map(id => normal(id)) : []; f.state.run();
    assert.strictEqual(f.state.entry('missing').status, 'ABANDONED');
    assert.strictEqual(f.state.inserts.length, 0);
    assert.strictEqual(f.ctx.currentRowStatus.timestampUpdated, true);
  },
  finalInsertVideoNotFoundAbandonsButQuotaDoesNot() {
    for (const reason of ['videoNotFound', 'quotaExceeded']) {
      const f = fixture(); const entry = waitEntry(f); f.state.now = entry.due; f.state.discovered = [];
      const error = Error(reason); error.details = {errors: [{reason}]}; f.state.insertError = error; f.state.run();
      assert.strictEqual(f.state.entry('missing').status, reason === 'videoNotFound' ? 'ABANDONED' : 'WAITING_100H');
      assert.strictEqual(f.ctx.currentRowStatus.timestampUpdated, reason === 'videoNotFound');
    }
  },
  postInsertOmissionRequiresSuccessfulRollbackBeforeAbandonment() {
    for (const rollbackFails of [false, true]) {
      const f = fixture(); const entry = waitEntry(f); f.state.now = entry.due; f.state.discovered = [];
      let calls = 0; f.state.metadata = ids => ++calls < 3 ? ids.map(id => normal(id)) : [];
      if (rollbackFails) f.state.rollbackError = Error('remove failed');
      f.state.run();
      assert.strictEqual(f.state.entry('missing').status, rollbackFails ? 'WAITING_100H' : 'ABANDONED');
      assert.strictEqual(f.ctx.currentRowStatus.timestampUpdated, !rollbackFails);
    }
  },
  alreadyPresentResolvesWithoutInsertingAgain() {
    const f = fixture(); const entry = waitEntry(f); f.state.now = entry.due; f.state.discovered = [];
    f.state.alreadyPresent = ['missing']; f.state.run();
    assert.strictEqual(f.state.entry('missing').status, 'RESOLVED');
    assert.strictEqual(f.state.inserts.length, 0);
  },
  finalRetryStillEnforcesBroadcastShortsAndDurationFilters() {
    for (const item of [normal('missing', 'PT10H1S'), normal('missing', 'PT1M'),
      {...normal('missing'), liveStreamingDetails: {}}, {...normal('missing'), snippet: {liveBroadcastContent: 'upcoming'}}]) {
      const f = fixture(); const entry = waitEntry(f); f.state.now = entry.due; f.state.reset();
      f.state.metadata = () => [item];
      assert.strictEqual(f.ctx.applyFilters(['missing'], {getRange: () => ({getValue: () => 'No'})}, 3).length, 0);
      assert.strictEqual(f.state.entry('missing').status, 'ABANDONED');
    }
  },
  countOncePerExecutionAndKeyByDestinationNotRow() {
    const f = fixture();
    f.ctx.recordRetryableVideoFailure('missing', 'filter', 'one');
    f.ctx.currentRetryRowNumber = 8; f.ctx.recordRetryableVideoFailure('missing', 'policy', 'two');
    assert.strictEqual(f.state.entry('missing').failures, 1);
    f.ctx.currentRetryPlaylistId = 'OTHER'; f.ctx.recordRetryableVideoFailure('missing', 'filter', 'other');
    assert.strictEqual(Object.keys(f.ctx.videoRetryStore.entries).length, 2);
    assert.strictEqual(f.state.entry('missing').failures, 1);
  },
  dryRunDoesNotChangeQueueOrSpendAllowance() {
    const f = fixture(); waitEntry(f); const snapshot = JSON.stringify(f.state.rows);
    f.ctx.experimentDryRun = true;
    f.ctx.recordRetryableVideoFailure('missing', 'filter', 'dry run');
    f.ctx.finishVideoRetry('missing', 'RESOLVED', 'dry run');
    assert.strictEqual(JSON.stringify(f.state.rows), snapshot);
  },
  queueKeepsManualNotesAndEscapesApiFormulaText() {
    const f = fixture(); f.ctx.recordRetryableVideoFailure('-bad', 'filter', '=IMPORTXML("bad")', {...normal('-bad'), snippet: {title: '=2+2'}});
    f.state.rows[1][11] = 'User review: keep this note';
    f.state.now += 2 * HOUR; f.state.reset(); f.ctx.recordRetryableVideoFailure('-bad', 'filter', 'still missing');
    assert.strictEqual(f.state.rows[1][11], 'User review: keep this note');
    assert.strictEqual(f.state.entry('-bad').title, '=2+2');
    assert.ok(f.state.writes.filter(w => w.row === 2).every(w => w.columnCount === 11));
  },
  corruptedOrDuplicateQueueFailsClosed() {
    const f = fixture(); f.ctx.recordRetryableVideoFailure('missing', 'filter', 'one');
    const saved = f.state.rows.map(row => row.slice());
    f.state.rows.push(saved[1].slice()); assert.throws(() => f.state.reset(), /Duplicate/);
    f.state.rows.pop(); f.state.rows[1][2] = 'UNKNOWN_STATUS'; assert.throws(() => f.state.reset(), /Invalid/);
    f.state.rows = saved.map(row => row.slice()); f.state.rows[0][0] = 'edited'; assert.throws(() => f.state.reset(), /headers/);
  },
  tenHourBoundaryAndUnknownDuration() {
    const f = fixture();
    for (const duration of ['PT9H59M59S', 'PT10H', 'PT600M']) assert.strictEqual(f.ctx.evaluateVideoAdmissionPolicy(normal('id', duration)).allowed, true);
    for (const duration of ['PT10H0.001S', 'PT10H1S', 'P1D']) {
      const result = f.ctx.evaluateVideoAdmissionPolicy(normal('id', duration));
      assert.strictEqual(result.allowed, false); assert.strictEqual(result.blocking, false);
    }
    for (const duration of ['', 'PT0S', 'garbage']) {
      const result = f.ctx.evaluateVideoAdmissionPolicy(normal('id', duration));
      assert.strictEqual(result.allowed, false); assert.strictEqual(result.blocking, true);
    }
  },
  tenHourCapAppliedAgainBeforeAndAfterInsert() {
    for (const changesAt of [2, 3]) {
      const f = fixture(); f.state.discovered = ['normal']; let calls = 0;
      f.state.metadata = ids => ids.map(id => normal(id, ++calls >= changesAt ? 'PT11H' : 'PT1H'));
      f.state.run();
      assert.strictEqual(f.state.inserts.length, changesAt === 2 ? 0 : 1);
      assert.strictEqual(f.state.removes.length, changesAt === 3 ? 1 : 0);
    }
  },
  fiftyIdBatchingIsPreserved() {
    const f = fixture(); f.state.discovered = Array.from({length: 101}, (_, i) => 'v' + i);
    f.ctx.applyFilters(f.state.discovered, f.sheet, 3);
    assert.deepStrictEqual(f.state.metadataCalls.map(ids => ids.length), [50, 50, 1]);
  },
  setupIsIdempotentAndMakesNoYouTubeCalls() {
    const f = fixture();
    assert.strictEqual(f.ctx.initializeVideoRetries().version, '5.7');
    assert.strictEqual(f.ctx.initializeVideoRetries().retryRecords, 0);
    assert.strictEqual(f.state.metadataCalls.length, 0);
    assert.strictEqual(f.state.inserts.length, 0);
    assert.strictEqual(f.state.checkpoints.length, 0);
  }
};
let failed = 0;
for (const [name, test] of Object.entries(tests)) {
  try { test(); console.log('PASS', name); } catch (error) { failed++; console.error('FAIL', name, error.stack); }
}
console.log(`${Object.keys(tests).length - failed}/${Object.keys(tests).length} retry tests passed`);
process.exitCode = failed ? 1 : 0;
