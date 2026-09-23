'use strict';
// V5.8 sequential destination progress.
//
// The behaviours under test are the ones the version was written for:
//
//   1. candidates are resolved one at a time, in order;
//   2. an undecidable membership result stops the walk and retains the checkpoint;
//   3. mutation attempts stay bounded by the rollback-safe write capacity;
//   4. a later execution recognizes previously added videos as present and gets
//      farther into the same backlog instead of repeating the same stopping point;
//   5. source discovery honours the frozen [checkpoint, cutoff] interval.
const assert = require('assert');
const fs = require('fs');
const vm = require('vm');
const source = fs.readFileSync(__dirname + '/../sheetScript.gs', 'utf8');

function normalUpload(id, duration) {
  return {
    id,
    snippet: {liveBroadcastContent: 'none'},
    contentDetails: {duration: duration || 'PT10M'}
  };
}

// A target destination whose second inventory page always fails, so every
// candidate beyond the first page must be resolved with an exact read.
function destinationFixture(initialVideoIds) {
  const destination = new Set(initialVideoIds || []);
  const probes = [];
  const inserted = [];
  const ctx = {
    console,
    Logger: {log() {}},
    YouTube: {
      PlaylistItems: {
        list(part, options) {
          if (options.videoId) {
            assert.strictEqual(part, 'id');
            assert.strictEqual(options.maxResults, 1,
              'sequential resolution must read one candidate at a time');
            probes.push(options.videoId);
            return {
              items: destination.has(options.videoId)
                ? [{id: 'item-' + options.videoId}]
                : []
            };
          }
          assert.strictEqual(part, 'contentDetails');
          if (!options.pageToken) {
            return {
              nextPageToken: 'unreadable-target-page-2',
              items: Array.from(destination).slice(0, 50).map(videoId => ({contentDetails: {videoId}}))
            };
          }
          const error = new Error('later target page temporarily inaccessible');
          error.details = {code: 503, errors: [{reason: 'backendError'}]};
          throw error;
        },
        insert(resource) {
          const videoId = resource.snippet.resourceId.videoId;
          inserted.push(videoId);
          destination.add(videoId);
          return {id: 'item-' + videoId};
        },
        remove() {}
      },
      Videos: {
        list(part, options) {
          return {items: options.id.split(',').map(id => normalUpload(id, 'PT20M'))};
        }
      }
    }
  };
  vm.createContext(ctx);
  vm.runInContext(source, ctx);
  return {ctx, destination, probes, inserted};
}

// One row execution: fresh row status, fresh execution-scoped caches.
function executeRow(fixture, videoIds, maxWriteOperations) {
  const logs = [];
  fixture.ctx.Logger.log = line => logs.push(String(line));
  fixture.ctx.currentRowStatus = fixture.ctx.createRowStatus();
  fixture.ctx.targetPlaylistVideoCache = {};
  fixture.ctx.targetMembershipQuotaFailure = null;
  fixture.ctx.targetMembershipProbesUsed = 0;
  fixture.ctx.playlistWriteOperationsUsed = 0;
  fixture.ctx.maxPlaylistWriteOperationsPerRun = maxWriteOperations;
  fixture.ctx.addVideosToPlaylist('PL_TARGET', videoIds);
  const summary = logs.find(line => line.includes('Sequential target progress:')) || '';
  const metric = name => {
    const match = new RegExp(name + '=(\\d+)').exec(summary);
    return match ? Number(match[1]) : 0;
  };
  return {
    status: fixture.ctx.currentRowStatus,
    writes: fixture.ctx.playlistWriteOperationsUsed,
    probes: fixture.ctx.targetMembershipProbesUsed,
    summary: summary,
    logs: logs,
    checked: metric('checked'),
    added: metric('added'),
    stoppedEarly: /stoppedEarly=true/.test(summary)
  };
}

function check(name, fn) { fn(); console.log('PASS ' + name); }

check('consecutive executions move farther through the same backlog', () => {
  const backlog = Array.from({length: 12}, (_, index) => 'backlog-' + index);
  const fixture = destinationFixture([]);

  const firstRun = executeRow(fixture, backlog, 6);
  assert.deepStrictEqual(fixture.inserted, backlog.slice(0, 3),
    'the first execution may only spend its rollback-safe capacity');
  assert.strictEqual(firstRun.status.timestampUpdated, false,
    'a capacity stop must retain the row checkpoint');
  assert.strictEqual(firstRun.writes, 3);
  assert.strictEqual(firstRun.checked, 4,
    'the walk ends as soon as the next absent candidate cannot be written');
  assert.strictEqual(firstRun.stoppedEarly, true);

  fixture.inserted.length = 0;
  fixture.probes.length = 0;
  const secondRun = executeRow(fixture, backlog, 6);

  assert.deepStrictEqual(fixture.inserted, backlog.slice(3, 6),
    'the second execution must skip videos added by the first and continue the backlog');
  assert.strictEqual(secondRun.checked, 7,
    'progress means examining a strictly longer prefix of the backlog');
  assert.ok(fixture.probes.indexOf('backlog-6') !== -1,
    'the second execution must reach candidates the first one never examined');
  assert.strictEqual(fixture.probes.indexOf('backlog-0'), -1,
    'videos captured by the two-page inventory prefix are recognised without another read');
  assert.strictEqual(secondRun.status.timestampUpdated, false,
    'the backlog is still larger than one execution may write');
  assert.strictEqual(new Set(fixture.inserted).size, fixture.inserted.length,
    'no duplicate insertion may be attempted for an already present video');

  fixture.inserted.length = 0;
  const thirdRun = executeRow(fixture, backlog, 6);
  assert.deepStrictEqual(fixture.inserted, backlog.slice(6, 9));
  assert.strictEqual(thirdRun.checked, 10);
  assert.strictEqual(thirdRun.status.timestampUpdated, false);

  fixture.inserted.length = 0;
  const fourthRun = executeRow(fixture, backlog, 6);
  assert.deepStrictEqual(fixture.inserted, backlog.slice(9, 12),
    'the fourth execution must resolve the last of the backlog');
  assert.strictEqual(fourthRun.checked, 12);
  assert.strictEqual(fourthRun.stoppedEarly, false,
    'a fully resolved interval must not stop early');
  assert.strictEqual(fourthRun.status.writeErrors, 0,
    'with every candidate resolved the row has no blocking error left');
  assert.deepStrictEqual(Array.from(fixture.destination).sort(), backlog.slice().sort(),
    'the destination must contain exactly the backlog, with no duplicates');
});

check('an undecidable candidate stops the walk and keeps the checkpoint', () => {
  const fixture = destinationFixture([]);
  const realList = fixture.ctx.YouTube.PlaylistItems.list;
  fixture.ctx.YouTube.PlaylistItems.list = function(part, options) {
    if (options.videoId === 'undecidable') throw new Error('temporary membership outage');
    return realList(part, options);
  };

  fixture.ctx.currentRowStatus = fixture.ctx.createRowStatus();
  fixture.ctx.targetPlaylistVideoCache = {};
  fixture.ctx.playlistWriteOperationsUsed = 0;
  fixture.ctx.maxPlaylistWriteOperationsPerRun = 6;
  fixture.ctx.addVideosToPlaylist('PL_TARGET', ['previous-video', 'undecidable', 'later-video']);

  assert.deepStrictEqual(fixture.inserted, ['previous-video'],
    'candidates resolved before the failure are kept, and nothing after it is touched');
  assert.strictEqual(fixture.ctx.currentRowStatus.writeErrors, 1);
  assert.strictEqual(fixture.ctx.currentRowStatus.timestampUpdated, false);
});

check('the progress summary replaces the retired probe-limit error', () => {
  const fixture = destinationFixture([]);

  const run = executeRow(fixture, ['summary-a', 'summary-b'], 6);

  assert.ok(run.summary, 'the sequential loop must report one summary line per destination');
  assert.ok(run.summary.includes('checked=2') && run.summary.includes('added=2'));
  assert.ok(run.summary.includes('stoppedEarly=false'));
  assert.ok(!run.logs.some(line => line.includes('Target membership probe limit of 75 was reached')),
    'the retired membership-probe ceiling must never be reported again');
  assert.strictEqual(run.status.writeErrors, 0);
});

check('source discovery is frozen to the [checkpoint, cutoff] interval', () => {
  const reads = [];
  const ctx = {
    console,
    Logger: {log() {}},
    YouTube: {
      Channels: {
        list() { return {items: [{contentDetails: {relatedPlaylists: {uploads: 'UU_SOURCE'}}}]}; }
      },
      PlaylistItems: {
        list(part, options) {
          reads.push(options);
          if (!options.pageToken) {
            // Newest-first: a page containing only videos published after the
            // frozen cutoff. It must not end pagination, because older in-window
            // videos can still follow.
            return {
              nextPageToken: 'page-2',
              items: [
                {contentDetails: {videoId: 'after-cutoff', videoPublishedAt: '2026-09-23T00:00:00Z'}}
              ]
            };
          }
          return {
            items: [
              {contentDetails: {videoId: 'in-window', videoPublishedAt: '2026-09-10T00:00:00Z'}},
              {contentDetails: {videoId: 'before-checkpoint', videoPublishedAt: '2026-08-01T00:00:00Z'}}
            ]
          };
        }
      }
    }
  };
  vm.createContext(ctx);
  vm.runInContext(source, ctx);
  ctx.currentRowStatus = ctx.createRowStatus();

  const ids = ctx.getVideoIdsWithLessQueries('UC_CHANNEL', '2026-09-01T00:00:00Z', '2026-09-22T00:00:00Z');

  assert.deepStrictEqual(Array.from(ids), ['in-window'],
    'only videos inside the frozen interval may be discovered');
  assert.strictEqual(reads.length, 2,
    'a page holding only post-cutoff videos must not stop pagination');
  assert.strictEqual(ctx.currentRowStatus.errorCount, 0);
});

console.log('5/5 sequential progress tests passed');
