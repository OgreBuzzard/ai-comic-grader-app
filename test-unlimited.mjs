// test-unlimited.mjs — v6.79. lib/unlimited.js against an in-memory Firestore
// stand-in: the week's start, the 30-day auto-start, the rate limits, grants
// and blocks. No network, no cost. Run: node test-unlimited.mjs
import * as U from './lib/unlimited.js';

let pass = 0, fail = 0;
const ok = (n, c, x) => { if (c) { pass++; console.log('  ok    ' + n); } else { fail++; console.log('  FAIL  ' + n + (x ? '\n        ' + x : '')); } };
const H = 3600e3, now = Date.now();

function fakeDb(uses) {
  const writes = [];
  const usesCol = { where: (f, op, v) => ({ _q: v }), doc: () => ({ id: 'new' }) };
  const uRef = { collection: () => usesCol };
  const tx = {
    get: async q => ({ docs: uses.filter(u => u.at >= q._q).map(u => ({ data: () => u })) }),
    update: (r, d) => writes.push(['update', d]),
    set: (r, d) => writes.push(['set', d])
  };
  return { tx, uRef, writes };
}
const user = (x) => ({ unlimited: { purchasedAt: new Date(now - 1e6).toISOString(), startBy: new Date(now + 29 * 864e5).toISOString(), purchaseId: 'p1', ...x } });

ok('no purchase -> none', U.unlimitedState({}, now).status === 'none');
ok('bought, unused -> pending', U.unlimitedState(user({}), now).status === 'pending');
ok('started 2 days ago -> active', U.unlimitedState(user({ startedAt: new Date(now - 48 * H).toISOString() }), now).status === 'active');
ok('started 8 days ago -> ended', U.unlimitedState(user({ startedAt: new Date(now - 8 * 24 * H).toISOString() }), now).status === 'ended');
ok('unused past day 30 -> auto-started on day 30', (() => { const s = U.unlimitedState(user({ startBy: new Date(now - 2 * 24 * H).toISOString() }), now); return s.status === 'active' && s.autoStarted; })());
ok('refunded -> none', U.unlimitedState(user({ revokedAt: new Date().toISOString() }), now).status === 'none');
ok('sale window', !U.unlimitedOnSale(Date.parse('2026-11-26T12:00:00Z')) && U.unlimitedOnSale(Date.parse('2026-11-27T12:00:00Z')) && U.unlimitedOnSale(Date.parse('2026-12-31T20:00:00Z')) && !U.unlimitedOnSale(Date.parse('2027-01-01T09:00:00Z')));

{
  const f = fakeDb([]);
  const r = await U.unlimitedCoverInTx(f.tx, null, f.uRef, user({}), { kind: 'main', imageHash: 'h1' });
  ok('first covered Main starts the week', r && r.covered && r.started && f.writes.some(w => w[0] === 'update' && w[1]['unlimited.startedAt']));
  ok('and records a use row', f.writes.some(w => w[0] === 'set' && w[1].kind === 'main' && w[1].imageHash === 'h1'));
}
{
  const f = fakeDb([]);
  const r = await U.unlimitedCoverInTx(f.tx, null, f.uRef, user({}), { kind: 'card' });
  ok('cards are not covered', r === null);
}
{
  const f = fakeDb([]);
  const r = await U.unlimitedCoverInTx(f.tx, null, f.uRef, {}, { kind: 'main', imageHash: 'h1' });
  ok('no Unlimited -> not covered (charge normally)', r === null);
}
const startedUser = user({ startedAt: new Date(now - 2 * H).toISOString() });
{
  const uses = [1, 2, 3].map(i => ({ at: now - i * 10 * 60e3, kind: 'main', imageHash: 'h1' }));
  const f = fakeDb(uses);
  const r = await U.unlimitedCoverInTx(f.tx, null, f.uRef, startedUser, { kind: 'main', imageHash: 'h1' });
  ok('same photos: run 4 in the hour is allowed (first + 3 re-runs)', r && r.covered && !r.started);
}
{
  const uses = [1, 2, 3, 4].map(i => ({ at: now - i * 10 * 60e3, kind: 'main', imageHash: 'h1' }));
  const f = fakeDb(uses);
  let err = null; try { await U.unlimitedCoverInTx(f.tx, null, f.uRef, startedUser, { kind: 'main', imageHash: 'h1' }); } catch (e) { err = e; }
  ok('same photos: run 5 in the hour is refused', err && err.reason === 'unlimited_limit' && err.code === 'insufficient_credits' && f.writes.length === 0, err && err.message);
  const f2 = fakeDb(uses);
  const r2 = await U.unlimitedCoverInTx(f2.tx, null, f2.uRef, startedUser, { kind: 'main', imageHash: 'h2' });
  ok('new photos are never limited', r2 && r2.covered);
  const f3 = fakeDb(uses);
  const r3 = await U.unlimitedCoverInTx(f3.tx, null, f3.uRef, startedUser, { kind: 'deep', imageHash: 'h1' });
  ok('the limit is per kind', r3 && r3.covered);
}
{
  const f = fakeDb([{ at: now - 30 * 60e3, kind: 'batch' }]);
  let err = null; try { await U.unlimitedCoverInTx(f.tx, null, f.uRef, startedUser, { kind: 'batch' }); } catch (e) { err = e; }
  ok('batch: 1 per hour', err && err.reason === 'unlimited_limit');
}
{
  const f = fakeDb([2, 5, 9].map(h => ({ at: now - h * H, kind: 'batch' })));
  let err = null; try { await U.unlimitedCoverInTx(f.tx, null, f.uRef, startedUser, { kind: 'batch' }); } catch (e) { err = e; }
  ok('batch: 3 per 24 hours', err && err.reason === 'unlimited_limit' && /24 hours/.test(err.message));
  const f2 = fakeDb([2, 5].map(h => ({ at: now - h * H, kind: 'batch' })));
  const r = await U.unlimitedCoverInTx(f2.tx, null, f2.uRef, startedUser, { kind: 'batch' });
  ok('batch: the 3rd in 24 hours is allowed', r && r.covered);
}
{
  const writes = []; const tx = { update: (r, d) => writes.push(d), set: (r, d) => writes.push(d) };
  const g1 = U.grantUnlimitedInTx(tx, {}, { exists: true, data: () => ({}) }, { purchaseId: 'x', source: 'stripe' });
  ok('grant on a clean account', g1 === 'granted' && writes[0].unlimited.purchaseId === 'x' && !writes[0].unlimited.startedAt);
  ok('grant while pending is blocked', U.grantUnlimitedInTx(tx, {}, { exists: true, data: () => user({}) }, {}) === 'blocked_active');
  ok('grant while running is blocked', U.grantUnlimitedInTx(tx, {}, { exists: true, data: () => startedUser }, {}) === 'blocked_active');
  ok('grant after a refund is blocked', U.grantUnlimitedInTx(tx, {}, { exists: true, data: () => ({ unlimitedBlocked: true }) }, {}) === 'blocked_refund');
  const ended = user({ startedAt: new Date(now - 9 * 24 * H).toISOString(), uses: 40 });
  writes.length = 0;
  ok('a new week after the last one ended', U.grantUnlimitedInTx(tx, {}, { exists: true, data: () => ended }, { purchaseId: 'y' }) === 'granted' && writes[0].unlimitedHistory.length === 1);
}
ok('image hash is stable and distinguishes', U.imageHashOf(['a', 'b']) === U.imageHashOf(['a', 'b']) && U.imageHashOf(['a', 'b']) !== U.imageHashOf(['a', 'c']));

console.log('\n  ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
