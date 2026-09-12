const fs = require('fs'), vm = require('vm'), assert = require('assert');
const ctx = {console}; vm.createContext(ctx);
vm.runInContext(fs.readFileSync(__dirname+'/../sheetScript.gs','utf8'),ctx);
vm.runInContext(fs.readFileSync(__dirname+'/../apps-script/PlaylistDiagnostics.gs','utf8'),ctx);
const normal = {id:'video',snippet:{liveBroadcastContent:'none'},contentDetails:{duration:'PT10M'}};
function run(mode) {
  let pages=0, mutations=0;
  const api={Videos:{list:()=> mode==='omitted'?{items:[]}:{items:[normal]}},PlaylistItems:{
    list(part,o) {
      if(o.videoId) { if(mode==='probe') throw Error('membership failed'); return {items:[]}; }
      pages++;
      if(mode==='source') throw Error('playlist not found');
      return {items:[{id:'item'+pages,snippet:{title:'Example',publishedAt:'2026-09-12T00:00:00Z',position:pages-1,resourceId:{videoId:'video'}}}],
        nextPageToken:mode==='repeat'?'same':mode==='endless'?String(pages):undefined};
    },insert(){mutations++;throw Error('NO WRITES');},remove(){mutations++;throw Error('NO WRITES');}}};
  const result=ctx.playlistDiagnosticCore_(api,'source','video',[{row:6,target:'target',checkpoint:'2026-09-11T00:00:00Z'}],()=>{});
  assert.strictEqual(mutations,0); return result;
}
for(const mode of ['normal','omitted','source','repeat','endless','probe']) {
  const r=run(mode);
  assert(r.calls<=20);
  if(mode==='normal') {assert(r.sourceComplete);assert(r.metadata.returned);assert(r.membership[0].sourceDateEligible);}
  if(mode==='omitted') assert.strictEqual(r.metadata.returned,false);
  if(mode==='repeat') {assert.strictEqual(r.pages.length,2);assert(!r.sourceComplete);}
  if(mode==='endless') assert(r.errors.some(e=>e.message==='DIAGNOSTIC_BUDGET_REACHED'));
  if(mode==='source') {assert(r.metadata.returned);assert(!r.sourceComplete);}
  if(mode==='probe') assert.strictEqual(r.membership[0].present,null);
  console.log('PASS diagnostic '+mode);
}
// Replay the actual NOS record: publication after discovery must not lose the
// ID when the row checkpoint advances during its explicitly configured wait.
let now = Date.parse('2026-09-12T18:00:00Z');
class ReplayDate extends Date { static now() { return now; } }
ctx.Date = ReplayDate;
ctx.videoRetryStore = {entries: {nos: {playlistId:'target',videoId:'ozBfToKlFLw',
  status:'WAITING_100H',due:Date.parse('2026-09-16T02:07:28.634Z')}}};
// Use the real durable key shape.
ctx.videoRetryStore.entries = {[ctx.videoRetryKey('target','ozBfToKlFLw')]:ctx.videoRetryStore.entries.nos};
assert.deepStrictEqual(Array.from(ctx.selectVideoRetryCandidates('target',['ozBfToKlFLw'])),[]);
now = Date.parse('2026-09-16T02:07:28.634Z');
assert.deepStrictEqual(Array.from(ctx.selectVideoRetryCandidates('target',[])),['ozBfToKlFLw']);
console.log('PASS real NOS deadline replay retains ID beyond source checkpoint');
