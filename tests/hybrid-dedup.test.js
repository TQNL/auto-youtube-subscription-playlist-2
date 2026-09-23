'use strict';
// Bounded hybrid destination deduplication, as revised by V5.8.
//
// The two-page inventory is only a cheap cache. When it is incomplete, every
// cache miss is resolved with an exact playlistId + videoId read. Those reads
// are deliberately NOT tied to the rollback-safe write budget; only mutations
// stay bounded. An undecidable membership result is always blocking.
const assert = require('assert');
const fs = require('fs');
const vm = require('vm');
const source = fs.readFileSync(__dirname + '/../sheetScript.gs', 'utf8');
function fixture(size, failProbe) {
  const calls = [];
  const ids = Array.from({length: size}, (_, i) => 'video-' + i);
  const ctx = {console, Logger: {log() {}}, YouTube: {PlaylistItems: {
    list(part, options) {
      calls.push(options);
      if (options.videoId) {
        assert.strictEqual(part, 'id');
        assert.strictEqual(options.maxResults, 1);
        if (options.videoId === failProbe) throw Error('temporary network failure');
        return {items: ids.includes(options.videoId) ? [{id: 'item-' + options.videoId}] : []};
      }
      assert.strictEqual(part, 'contentDetails');
      const start = Number(options.pageToken || 0);
      return {items: ids.slice(start, start + 50).map(videoId => ({contentDetails: {videoId}})),
        nextPageToken: start + 50 < size ? String(start + 50) : undefined};
    }
  }}};
  vm.createContext(ctx);
  vm.runInContext(source, ctx);
  ctx.currentRowStatus = ctx.createRowStatus();
  return {ctx, calls};
}
function check(name, fn) { fn(); console.log('PASS ' + name); }
check('3300-item target: two absent candidates cost four reads, not 66', () => {
  const {ctx, calls} = fixture(3300);
  const inventory = ctx.getTargetPlaylistVideoInventory('target');
  assert.strictEqual(inventory.complete, false);
  assert.strictEqual(inventory.pagesRead, 2);
  const verdicts = ['new-a', 'new-b'].map(videoId => ctx.checkTargetVideoMembership('target', videoId, inventory));
  assert.deepStrictEqual(verdicts, ['absent', 'absent']);
  assert.strictEqual(calls.length, 4);
  assert.strictEqual(ctx.currentRowStatus.errorCount, 0);
});
check('deep duplicate and recent duplicate are both excluded', () => {
  const {ctx, calls} = fixture(3300);
  const inventory = ctx.getTargetPlaylistVideoInventory('target');
  assert.strictEqual(ctx.checkTargetVideoMembership('target', 'video-1', inventory), 'present',
    'a first-page match is proven by the inventory alone');
  assert.strictEqual(ctx.checkTargetVideoMembership('target', 'video-3299', inventory), 'present',
    'a match beyond the page cap is proven by one exact read');
  assert.strictEqual(ctx.checkTargetVideoMembership('target', 'new', inventory), 'absent');
  assert.strictEqual(calls.length, 4, 'two inventory pages plus one exact miss');
  assert.strictEqual(ctx.getTargetPlaylistVideoInventory('target'), inventory,
    'the inventory object must be reused within an execution');
  assert.strictEqual(ctx.checkTargetVideoMembership('target', 'video-3299', inventory), 'present');
  assert.strictEqual(calls.length, 4, 'reuse positive membership within the execution');
});
check('small complete target needs no exact probes', () => {
  const {ctx, calls} = fixture(75);
  const inventory = ctx.getTargetPlaylistVideoInventory('target');
  assert.strictEqual(inventory.complete, true);
  assert.strictEqual(ctx.checkTargetVideoMembership('target', 'new-a', inventory), 'absent');
  assert.strictEqual(ctx.checkTargetVideoMembership('target', 'new-b', inventory), 'absent');
  assert.strictEqual(calls.length, 2, 'a complete inventory answers every candidate without a probe');
});
check('a failed exact check is unknown and blocking', () => {
  const {ctx} = fixture(3300, 'uncertain');
  const inventory = ctx.getTargetPlaylistVideoInventory('target');
  assert.strictEqual(ctx.checkTargetVideoMembership('target', 'uncertain', inventory), 'unknown');
  assert.strictEqual(ctx.currentRowStatus.writeErrors, 1,
    'an undecidable candidate must retain the row checkpoint');
});
check('exact reads are not capped by the rollback-safe write ceiling', () => {
  const {ctx, calls} = fixture(3300);
  const inventory = ctx.getTargetPlaylistVideoInventory('target');
  const candidates = Array.from({length: 75}, (_, index) => 'uncapped-' + index);
  const verdicts = candidates.map(videoId => ctx.checkTargetVideoMembership('target', videoId, inventory));
  assert.ok(verdicts.every(verdict => verdict === 'absent'));
  assert.strictEqual(calls.length, 2 + candidates.length,
    'every cache miss is resolved exactly; reads no longer stop at the write budget');
  assert.strictEqual(ctx.targetMembershipProbesUsed, candidates.length);
  assert.strictEqual(ctx.currentRowStatus.writeErrors, 0,
    'unbounded-but-bounded-per-candidate reads must not create a blocking condition');
});
check('known quota exhaustion prevents even head-page scans', () => {
  const {ctx, calls} = fixture(3300);
  ctx.targetMembershipQuotaFailure = Error('quotaExceeded');
  const inventory = ctx.getTargetPlaylistVideoInventory('target');
  assert.strictEqual(calls.length, 0);
  assert.strictEqual(inventory.complete, false);
  assert.strictEqual(ctx.checkTargetVideoMembership('target', 'new', inventory), 'unknown',
    'a latched quota failure must not issue a request');
  assert.strictEqual(calls.length, 0);
  assert.ok(ctx.currentRowStatus.writeErrors > 0);
});
check('empty destination is complete after one read', () => {
  const {ctx, calls} = fixture(0);
  const inventory = ctx.getTargetPlaylistVideoInventory('target');
  assert.strictEqual(inventory.complete, true);
  assert.strictEqual(ctx.checkTargetVideoMembership('target', 'new', inventory), 'absent');
  assert.strictEqual(calls.length, 1);
});
console.log('7/7 hybrid deduplication tests passed');
