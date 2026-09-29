// v5.30 guard: scan-animation.js must EXECUTE, not merely parse. `node --check`
// passed the 5.29 build in which a backtick inside the CSS template literal
// terminated it and left the module throwing at load, so the API was never
// exported and every assessment quietly gave up.
const fs = require('fs'), vm = require('vm');
const el = () => ({ style:{}, classList:{add(){},remove(){},contains:()=>false},
  appendChild(){}, removeChild(){}, setAttribute(){}, remove(){}, offsetHeight:0,
  getBoundingClientRect:()=>({top:0,left:0,width:0,height:0}), querySelector:()=>null,
  querySelectorAll:()=>[], addEventListener(){}, textContent:'' });
const sandbox = { console, setTimeout, clearTimeout, setInterval, clearInterval,
  requestAnimationFrame: f => f(), cancelAnimationFrame(){}, Date, Math, JSON,
  document: { getElementById:()=>null, querySelector:()=>null, querySelectorAll:()=>[],
    createElement: el, head: el(), body: el(), addEventListener(){}, documentElement: el() },
  navigator:{ userAgent:'node' }, location:{ href:'https://robograder.app/' },
  innerHeight: 800, innerWidth: 400, visualViewport: null, getComputedStyle: () => ({}) };
sandbox.window = sandbox; sandbox.globalThis = sandbox; sandbox.self = sandbox;
vm.createContext(sandbox);
try { vm.runInContext(fs.readFileSync(__dirname + '/scan-animation.js','utf8'), sandbox, {filename:'scan-animation.js'}); }
catch (e) { console.error('FAIL — threw at load: ' + e.message); console.error(e.stack.split('\n')[1]); process.exit(1); }
const S = sandbox.window.RobograderScan;
if (!S) { console.error('FAIL — window.RobograderScan was never assigned'); process.exit(1); }
const REQUIRED = ['runScanAnimation','revealScannedPhoto','slideTrackerIntoCavity',
  'slideOverlayIntoChest','slideResultsIntoPanel','dismiss','setDebug','debugLog',
  'startGridCycle','stopGridCycle','startNeedlePulse','stopNeedlePulse',
  'sweepNeedleToScore','setNeedleAngle','_resetReveal'];
const missing = REQUIRED.filter(k => typeof S[k] !== 'function');
if (missing.length) { console.error('FAIL — missing from the exported API: ' + missing.join(', ')); process.exit(1); }
console.log('OK — module executed, ' + REQUIRED.length + '/' + REQUIRED.length + ' exports present');
