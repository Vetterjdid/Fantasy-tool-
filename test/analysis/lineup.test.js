import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  optimalLineup,
  greedyLineup,
  canFill,
  scoringSlots,
} from '../../src/analysis/lineup.js';

const val = (p) => p.value;
const P = (id, position, value) => ({ id, position, value });

test('scoringSlots drops bench, IR and taxi slots', () => {
  assert.deepEqual(
    scoringSlots(['QB', 'RB', 'FLEX', 'BN', 'BN', 'IR', 'TAXI']),
    ['QB', 'RB', 'FLEX']
  );
});

test('canFill honours FLEX families', () => {
  assert.equal(canFill('FLEX', 'RB'), true);
  assert.equal(canFill('FLEX', 'QB'), false);
  assert.equal(canFill('SUPER_FLEX', 'QB'), true);
  assert.equal(canFill('REC_FLEX', 'RB'), false);
  assert.equal(canFill('WRRB_FLEX', 'TE'), false);
});

test('picks the best eligible player for a dedicated slot', () => {
  const out = optimalLineup([P('a', 'QB', 10), P('b', 'QB', 22)], ['QB', 'BN'], val);
  assert.equal(out.total, 22);
  assert.equal(out.assignments[0].playerId, 'b');
  assert.deepEqual(out.benched, ['a']);
});

test('FLEX before a dedicated slot: greedy strands the TE, matching does not', () => {
  // The classic failure case. Slot order puts FLEX first, so a naive fill
  // takes the tight end into FLEX and leaves the TE slot empty.
  const roster = [P('te', 'TE', 10), P('rb', 'RB', 9)];
  const slots = ['FLEX', 'TE', 'BN'];

  assert.equal(greedyLineup(roster, slots, val), 10, 'greedy oracle should lose here');

  const out = optimalLineup(roster, slots, val);
  assert.equal(out.total, 19);
  const bySlot = Object.fromEntries(out.assignments.map((a) => [a.slot, a.playerId]));
  assert.equal(bySlot.FLEX, 'rb');
  assert.equal(bySlot.TE, 'te');
  assert.equal(out.unfilled.length, 0);
});

test('non-nested eligibility (WRRB_FLEX + REC_FLEX) resolves correctly', () => {
  const roster = [P('wr', 'WR', 12), P('rb', 'RB', 8), P('te', 'TE', 7)];
  const out = optimalLineup(roster, ['WRRB_FLEX', 'REC_FLEX'], val);
  // WR can serve either slot; the optimum puts RB in WRRB and WR in REC (12+8=20)
  // or WR in WRRB and TE in REC (12+7=19). Best is 20.
  assert.equal(out.total, 20);
});

test('reports unfilled slots instead of failing on a short roster', () => {
  const out = optimalLineup([P('a', 'QB', 10)], ['QB', 'RB', 'TE'], val);
  assert.equal(out.total, 10);
  assert.equal(out.assignments.length, 1);
  assert.deepEqual(out.unfilled.map((u) => u.slot).sort(), ['RB', 'TE']);
});

test('a player eligible for no slot stays benched and scores nothing', () => {
  const out = optimalLineup([P('k', 'K', 99), P('q', 'QB', 5)], ['QB'], val);
  assert.equal(out.total, 5);
  assert.deepEqual(out.benched, ['k']);
});

test('empty roster and slotless league degrade quietly', () => {
  assert.equal(optimalLineup([], ['QB', 'FLEX'], val).total, 0);
  assert.equal(optimalLineup([P('a', 'QB', 9)], [], val).total, 0);
  assert.equal(optimalLineup([P('a', 'QB', 9)], ['BN', 'BN'], val).total, 0);
});

test('identical values produce a stable assignment across repeated solves', () => {
  const roster = [P('a', 'RB', 10), P('b', 'RB', 10), P('c', 'RB', 10)];
  const first = optimalLineup(roster, ['RB', 'FLEX'], val);
  for (let i = 0; i < 20; i++) {
    const again = optimalLineup(roster.slice().reverse(), ['RB', 'FLEX'], val);
    assert.deepEqual(
      again.assignments.map((a) => a.playerId),
      first.assignments.map((a) => a.playerId)
    );
  }
});

// ---- property tests against brute force ----

function bruteForce(players, rosterPositions, valueFor) {
  const slots = scoringSlots(rosterPositions);
  let best = 0;
  const used = new Array(players.length).fill(false);
  (function place(i, acc) {
    if (i === slots.length) {
      if (acc > best) best = acc;
      return;
    }
    place(i + 1, acc); // leave this slot empty
    for (let j = 0; j < players.length; j++) {
      if (used[j] || !canFill(slots[i], players[j].position)) continue;
      used[j] = true;
      place(i + 1, acc + valueFor(players[j]));
      used[j] = false;
    }
  })(0, 0);
  return best;
}

function mulberry32(seed) {
  return function () {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

test('matches brute-force optimum on randomised rosters', () => {
  const rand = mulberry32(1234);
  const positions = ['QB', 'RB', 'WR', 'TE', 'K', 'DEF'];
  const slotSets = [
    ['QB', 'RB', 'RB', 'WR', 'WR', 'TE', 'FLEX'],
    ['FLEX', 'TE', 'RB', 'WR'],
    ['SUPER_FLEX', 'QB', 'RB', 'WR'],
    ['WRRB_FLEX', 'REC_FLEX', 'FLEX'],
  ];

  for (let trial = 0; trial < 200; trial++) {
    const slots = slotSets[Math.floor(rand() * slotSets.length)];
    const n = 3 + Math.floor(rand() * 6);
    const roster = [];
    for (let i = 0; i < n; i++) {
      roster.push(P(
        'p' + i,
        positions[Math.floor(rand() * positions.length)],
        Math.round(rand() * 200) / 10
      ));
    }
    const got = optimalLineup(roster, slots, val).total;
    const want = bruteForce(roster, slots, val);
    assert.ok(
      Math.abs(got - want) < 1e-6,
      `trial ${trial}: got ${got}, brute force ${want}, slots ${slots.join('/')}`
    );
  }
});

test('greedy never beats the matching', () => {
  const rand = mulberry32(99);
  const positions = ['QB', 'RB', 'WR', 'TE'];
  for (let trial = 0; trial < 200; trial++) {
    const roster = [];
    const n = 3 + Math.floor(rand() * 6);
    for (let i = 0; i < n; i++) {
      roster.push(P('p' + i, positions[Math.floor(rand() * positions.length)], Math.round(rand() * 200) / 10));
    }
    const slots = ['FLEX', 'QB', 'RB', 'TE', 'WR'];
    assert.ok(greedyLineup(roster, slots, val) <= optimalLineup(roster, slots, val).total + 1e-9);
  }
});
