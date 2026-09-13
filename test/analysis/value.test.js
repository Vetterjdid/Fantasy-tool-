import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  remainingWeeks,
  availabilityFactor,
  restOfSeasonValues,
  positionalDemand,
  replacementLevels,
  valueOverReplacement,
  marginalOut,
  marginalIn,
} from '../../src/analysis/value.js';

const P = (id, position, extra = {}) => ({ id, position, status: 'Active', nflTeam: 'KC', ...extra });

function lookups(rows, ranks = {}) {
  return {
    projectionFor: (p) => rows[p.id],
    rankingFor: (p) => (ranks[p.id] ? { rank: ranks[p.id], position: p.position } : null),
  };
}

test('remainingWeeks counts the current week and never goes below 1', () => {
  assert.equal(remainingWeeks(4), 14);
  assert.equal(remainingWeeks(17), 1);
  assert.equal(remainingWeeks(25), 1);
});

test('availabilityFactor discounts by injury status', () => {
  assert.equal(availabilityFactor('Active', 10), 1);
  assert.equal(availabilityFactor(undefined, 10), 1);
  assert.equal(availabilityFactor('Questionable', 10), 0.92);
  assert.equal(availabilityFactor('Doubtful', 10), 0.6);
  assert.equal(availabilityFactor('Injured Reserve', 10), 0);
  assert.equal(availabilityFactor('Out', 10), 0.9);
});

test('a star on bye is imputed from the nearest-ranked healthy peer, not zeroed', () => {
  const players = [P('star', 'RB'), P('peer', 'RB'), P('scrub', 'RB')];
  const rows = {
    star: { projectedPoints: 0, bye: true },
    peer: { projectedPoints: 18, bye: false },
    scrub: { projectedPoints: 4, bye: false },
  };
  const ranks = { star: 1, peer: 2, scrub: 40 };

  const values = restOfSeasonValues(players, { ...lookups(rows, ranks), weeks: 10 });
  const star = values.get('star');

  assert.equal(star.quality, 'bye-imputed');
  assert.equal(star.base, 18, 'should borrow the adjacent rank, not the scrub');
  assert.equal(star.ros, 180);
  assert.ok(star.ros > values.get('scrub').ros, 'a bye must not make a star worthless');
});

test('bye imputation falls back to the positional median without rankings', () => {
  const players = [P('a', 'WR'), P('b', 'WR'), P('c', 'WR')];
  const rows = {
    a: { projectedPoints: 0, bye: true },
    b: { projectedPoints: 10, bye: false },
    c: { projectedPoints: 20, bye: false },
  };
  const values = restOfSeasonValues(players, { ...lookups(rows), weeks: 1 });
  assert.equal(values.get('a').base, 15);
  assert.equal(values.get('a').quality, 'bye-imputed');
});

test('a missing projection stays null and never silently becomes zero', () => {
  const players = [P('ghost', 'TE')];
  const values = restOfSeasonValues(players, { ...lookups({}), weeks: 10 });
  assert.equal(values.get('ghost').ros, null);
  assert.equal(values.get('ghost').base, null);
  assert.equal(values.get('ghost').quality, 'missing');
});

test('IR players carry zero rest-of-season value but still exist', () => {
  const players = [P('hurt', 'RB', { status: 'Injured Reserve' })];
  const values = restOfSeasonValues(players, {
    ...lookups({ hurt: { projectedPoints: 20, bye: false } }),
    weeks: 10,
  });
  assert.equal(values.get('hurt').ros, 0);
  assert.equal(values.get('hurt').quality, 'observed');
});

test('positionalDemand splits FLEX evenly across eligible positions', () => {
  const league = { totalRosters: 10, rosterPositions: ['QB', 'RB', 'RB', 'WR', 'WR', 'TE', 'FLEX', 'BN'] };
  const demand = positionalDemand(league);
  assert.equal(demand.QB, 10);
  assert.ok(Math.abs(demand.RB - (2 + 1 / 3) * 10) < 1e-9);
  assert.ok(Math.abs(demand.TE - (1 + 1 / 3) * 10) < 1e-9);
});

test('replacement level uses the waiver pool when it has a player there', () => {
  const league = { totalRosters: 2, rosterPositions: ['RB', 'BN'] };
  const all = [P('r1', 'RB'), P('r2', 'RB'), P('free', 'RB')];
  const ros = { r1: 30, r2: 20, free: 25 };
  const levels = replacementLevels({
    league,
    allPlayers: all,
    available: [all[2]],
    rosFor: (p) => ros[p.id],
  });
  assert.equal(levels.RB, 25, 'the only free player is what a replacement costs');
});

test('one outlier free agent does not set replacement level for the whole position', () => {
  // Only one team can claim the 186; everyone else gets the next tier. Using
  // the max would drag replacement up and erase every WR's tradeable value.
  const league = { totalRosters: 6, rosterPositions: ['WR', 'WR', 'BN'] };
  const free = [P('a', 'WR'), P('b', 'WR'), P('c', 'WR'), P('d', 'WR')];
  const ros = { a: 186, b: 139, c: 133, d: 127 };
  const levels = replacementLevels({
    league,
    allPlayers: free,
    available: free,
    rosFor: (p) => ros[p.id],
  });
  assert.equal(levels.WR, 139, 'median of the top few, not the lucky maximum');
  assert.ok(levels.WR < 186);
});

test('a rostered player never sets replacement level, however deep the position', () => {
  // Demand-rank would name the 3rd best RB (36) as "replacement", but he is on
  // a roster and cannot be had for free. Overriding the waiver pool that way
  // erases the surplus that makes trades possible.
  const league = { totalRosters: 2, rosterPositions: ['RB', 'FLEX', 'BN'] };
  const all = [P('r1', 'RB'), P('r2', 'RB'), P('r3', 'RB'), P('free', 'RB')];
  const ros = { r1: 40, r2: 38, r3: 36, free: 8 };
  const levels = replacementLevels({
    league,
    allPlayers: all,
    available: [all[3]],
    rosFor: (p) => ros[p.id],
  });
  assert.equal(levels.RB, 8);
});

test('replacement level falls back to demand rank when the waiver pool is empty', () => {
  const league = { totalRosters: 2, rosterPositions: ['TE', 'BN'] };
  const all = [P('t1', 'TE'), P('t2', 'TE'), P('t3', 'TE')];
  const ros = { t1: 14, t2: 9, t3: 3 };
  const levels = replacementLevels({
    league,
    allPlayers: all,
    available: [],
    rosFor: (p) => ros[p.id],
  });
  assert.equal(levels.TE, 9, '2 teams must start a TE, so the 2nd best is replacement');
});

test('valueOverReplacement subtracts the positional baseline', () => {
  const levels = { RB: 10 };
  assert.equal(valueOverReplacement(P('a', 'RB'), () => 25, levels), 15);
  assert.equal(valueOverReplacement(P('b', 'RB'), () => undefined, levels), null);
});

// ---- the thesis: abstract value != value to a roster ----

test('a surplus player costs his own team almost nothing to lose', () => {
  const val = (p) => p.value;
  const slots = ['RB', 'BN', 'BN'];
  const stacked = [
    { id: 'rb1', position: 'RB', value: 30 },
    { id: 'rb2', position: 'RB', value: 29 },
    { id: 'rb3', position: 'RB', value: 28 },
  ];
  // rb2 is excellent in the abstract but only one RB can start.
  assert.equal(marginalOut(stacked, 'rb2', slots, val), 0);
  assert.equal(marginalOut(stacked, 'rb1', slots, val), 1, 'losing the starter only costs the gap to rb2');
});

test('the same player is worth far more to a team with a hole — this is why trades exist', () => {
  const val = (p) => p.value;
  const slots = ['RB', 'BN'];
  const stacked = [
    { id: 'rb1', position: 'RB', value: 30 },
    { id: 'rb2', position: 'RB', value: 29 },
  ];
  const thin = [{ id: 'weak', position: 'RB', value: 4 }];
  const rb2 = stacked[1];

  const cost = marginalOut(stacked, 'rb2', slots, val);
  const gain = marginalIn(thin, rb2, slots, val);

  assert.equal(cost, 0);
  assert.equal(gain, 25);
  assert.ok(gain > cost, 'the gap between these two numbers is the trade surplus');
});
