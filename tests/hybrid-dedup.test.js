'use strict';
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
  const result = ctx.getTargetPendingVideoIds('target', ['new-a', 'new-b'], inventory, 75);
  assert.deepStrictEqual(Array.from(result.pendingVideoIds), ['new-a', 'new-b']);
  assert.strictEqual(calls.length, 4);
  assert.strictEqual(ctx.currentRowStatus.errorCount, 0);
});
check('deep duplicate and recent duplicate are both excluded', () => {
  const {ctx, calls} = fixture(3300);
  const inventory = ctx.getTargetPlaylistVideoInventory('target');
  const result = ctx.getTargetPendingVideoIds('target', ['video-1', 'video-3299', 'new'], inventory, 75);
  assert.deepStrictEqual(Array.from(result.pendingVideoIds), ['new']);
  assert.strictEqual(result.alreadyPresentCount, 2);
  assert.strictEqual(calls.length, 4);
  assert.strictEqual(ctx.getTargetPlaylistVideoInventory('target'), inventory);
  ctx.getTargetPendingVideoIds('target', ['video-3299'], inventory, 75);
  assert.strictEqual(calls.length, 4, 'reuse positive membership within the execution');
});
check('small complete target needs no exact probes', () => {
  const {ctx, calls} = fixture(75);
  const inventory = ctx.getTargetPlaylistVideoInventory('target');
  assert.strictEqual(inventory.complete, true);
  ctx.getTargetPendingVideoIds('target', ['new-a', 'new-b'], inventory, 75);
  assert.strictEqual(calls.length, 2);
});
check('scan cap does not hide failed exact checks or release checkpoint', () => {
  const {ctx} = fixture(3300, 'uncertain');
  const inventory = ctx.getTargetPlaylistVideoInventory('target');
  const result = ctx.getTargetPendingVideoIds('target', ['uncertain', 'new'], inventory, 75);
  assert.deepStrictEqual(Array.from(result.pendingVideoIds), ['new']);
  assert.strictEqual(result.unresolvedCount, 1);
  assert.strictEqual(ctx.currentRowStatus.writeErrors, 1);
});
check('exact check budget remains bounded with a healthy large destination', () => {
  const {ctx, calls} = fixture(3300);
  const inventory = ctx.getTargetPlaylistVideoInventory('target');
  const result = ctx.getTargetPendingVideoIds('target', ['a', 'b', 'c'], inventory, 2);
  assert.strictEqual(result.unresolvedCount, 1);
  assert.strictEqual(calls.length, 4);
  assert.strictEqual(ctx.currentRowStatus.writeErrors, 1);
});
check('known quota exhaustion prevents even head-page scans', () => {
  const {ctx, calls} = fixture(3300);
  ctx.targetMembershipQuotaFailure = Error('quotaExceeded');
  const inventory = ctx.getTargetPlaylistVideoInventory('target');
  const result = ctx.getTargetPendingVideoIds('target', ['new'], inventory, 75);
  assert.strictEqual(calls.length, 0);
  assert.strictEqual(result.unresolvedCount, 1);
});
check('empty destination is complete after one read', () => {
  const {ctx, calls} = fixture(0);
  const inventory = ctx.getTargetPlaylistVideoInventory('target');
  assert.strictEqual(inventory.complete, true);
  const result = ctx.getTargetPendingVideoIds('target', ['new'], inventory, 75);
  assert.strictEqual(result.pendingVideoIds.length, 1);
  assert.strictEqual(calls.length, 1);
});
console.log('7/7 hybrid deduplication tests passed');
