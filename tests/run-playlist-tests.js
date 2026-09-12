// Local failure injection only: these suites use fake YouTube/Sheets services.
const {spawnSync} = require('child_process');
const path = require('path');
let failures = 0;
for (const file of ['current.test.js','retry-queue.test.js','hybrid-dedup.test.js','playlist-diagnostics.test.js']) {
  const result = spawnSync(process.execPath, [path.join(__dirname,file)], {stdio:'inherit'});
  if (result.error || result.status !== 0) failures++;
}
if(failures) process.exitCode=1;
console.log(failures ? failures+' suites failed' : 'All four playlist suites passed');
