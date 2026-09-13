import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildContext } from '../../src/analysis/index.js';
import { waiverMoves, waiverBoard, waiverOrder, UNRANKABLE } from '../../src/analysis/waivers.js';

const SLOTS = ['QB', 'RB', 'RB', 'WR', 'WR', 'TE', 'FLEX', 'K', 'DEF', 'BN', 'BN'];

/**
 * Two teams, a full roster for the team under test, and a free-agent pool.
 * `points` is per-week; rest-of-season multiplies it by the weeks remaining.
 */
function world({ mine, theirs, free }) {
  const league = {
    id: 'L', name: 'T', season: '2026', scoringType: 'ppr',
    totalRosters: 2, rosterPositions: SLOTS, status: 'in_season',
  };
  const teams = [
    { id: 'me', leagueId: 'L', externalId: '1', ownerId: 'u1', ownerName: 'Me', teamName: 'Mine',
      wins: 0, losses: 0, ties: 0, pointsFor: 0, pointsAgainst: 0, waiverPosition: 2, waiverBudgetUsed: 0 },
    { id: 'them', leagueId: 'L', externalId: '2', ownerId: 'u2', ownerName: 'Them', teamName: 'Theirs',
      wins: 0, losses: 0, ties: 0, pointsFor: 0, pointsAgainst: 0, waiverPosition: 1, waiverBudgetUsed: 0 },
  ];
  const playersById = {};
  const rosterSlots = [];
  const projections = [];

  const add = (spec, teamId) => {
    const player = {
      id: spec.id, fullName: spec.id, position: spec.position,
      nflTeam: 'KC', status: spec.status || 'Active',
    };
    playersById[spec.id] = player;
    if (teamId) rosterSlots.push({ leagueId: 'L', teamId, playerId: spec.id, slot: spec.slot || 'bench' });
    projections.push({ playerId: spec.id, leagueId: 'L', season: '2026', week: 1,
      projectedPoints: spec.points, bye: false, opponent: null, source: 'test' });
  };
  mine.forEach((p) => add(p, 'me'));
  (theirs || []).forEach((p) => add(p, 'them'));
  free.forEach((p) => add(p, null));

  return buildContext({ league, teams, rosterSlots, playersById, projections, rankings: [], currentWeek: 1 });
}

/** A complete, unremarkable roster: fills every slot, nothing spare. */
const BASE = [
  { id: 'qb1', position: 'QB', points: 20 },
  { id: 'rb1', position: 'RB', points: 15 }, { id: 'rb2', position: 'RB', points: 12 },
  { id: 'wr1', position: 'WR', points: 14 }, { id: 'wr2', position: 'WR', points: 11 },
  { id: 'te1', position: 'TE', points: 9 },
  { id: 'flexrb', position: 'RB', points: 10 },
  { id: 'k1', position: 'K', points: 8 }, { id: 'def1', position: 'DEF', points: 7 },
  { id: 'benchwr', position: 'WR', points: 3 },
  { id: 'benchte', position: 'TE', points: 2 },
];

test('a free agent better than my worst starter is a recommended pickup', () => {
  const ctx = world({
    mine: BASE,
    theirs: [{ id: 'x1', position: 'QB', points: 18 }],
    free: [{ id: 'star', position: 'WR', points: 25 }],
  });
  const { moves } = waiverMoves(ctx, 'me');
  assert.ok(moves.length > 0, 'should find a move');
  const top = moves[0];
  assert.equal(top.add.playerId, 'star');
  assert.ok(top.gain > 0);
  assert.ok(top.add.startsAfter, 'the point of adding him is that he starts');
  // The gain must reconcile with the slot changes that produced it.
  const fromChanges = top.lineupChanges.reduce((sum, c) => sum + c.delta, 0);
  assert.ok(Math.abs(fromChanges - top.gain) < 0.5, `changes sum to ${fromChanges}, gain ${top.gain}`);
});

test('the dropped player is the one who costs least, not the lowest scorer', () => {
  // benchwr scores 3 and benchte 2, but both are benched and cost 0 either way.
  // What must NOT happen is dropping a starter while a free bench spot exists.
  const ctx = world({
    mine: BASE,
    theirs: [],
    free: [{ id: 'star', position: 'WR', points: 25 }],
  });
  const { moves } = waiverMoves(ctx, 'me');
  const top = moves[0];
  assert.equal(top.drop.marginalCost, 0, 'a costless drop was available');
  assert.ok(!top.drop.startedBefore, 'never drop a starter when a bench player costs nothing');
});

test('nothing is recommended when the waiver pool is worse than what I have', () => {
  const ctx = world({
    mine: BASE,
    theirs: [],
    free: [{ id: 'scrub', position: 'WR', points: 1 }, { id: 'scrub2', position: 'RB', points: 2 }],
  });
  const { moves } = waiverMoves(ctx, 'me');
  assert.equal(moves.length, 0, 'a pickup that does not improve the lineup is not a pickup');
});

test('an injured-reserve player is never offered as the drop', () => {
  // This is the failure the exclusion exists for: IR carries an availability
  // factor of zero, so his value reads as zero and dropping him looks free.
  const ctx = world({
    mine: BASE.concat([{ id: 'hurtstar', position: 'RB', points: 30, status: 'Injured Reserve', slot: 'ir' }]),
    theirs: [],
    free: [{ id: 'star', position: 'WR', points: 25 }],
  });
  const { moves } = waiverMoves(ctx, 'me');
  assert.ok(moves.length > 0);
  for (const move of moves) {
    assert.notEqual(move.drop.playerId, 'hurtstar', 'must not advise cutting an injured stash');
  }
});

test('kickers and defenses are browsable but never recommended', () => {
  const ctx = world({
    mine: BASE,
    theirs: [],
    free: [{ id: 'bigk', position: 'K', points: 40 }, { id: 'bigd', position: 'DEF', points: 40 }],
  });
  const { moves } = waiverMoves(ctx, 'me');
  assert.equal(moves.length, 0, 'the projection cannot tell two kickers apart, so it must not rank them');

  const { board } = waiverBoard(ctx, 'me');
  assert.ok(board.some((e) => e.playerId === 'bigk'), 'but they still appear on the board');
  assert.deepEqual(UNRANKABLE, ['K', 'DEF']);
});

test('each free agent is recommended at most once, paired with his best drop', () => {
  const ctx = world({
    mine: BASE,
    theirs: [],
    free: [{ id: 'star', position: 'WR', points: 25 }, { id: 'star2', position: 'RB', points: 24 }],
  });
  const { moves } = waiverMoves(ctx, 'me');
  const added = moves.map((m) => m.add.playerId);
  assert.equal(new Set(added).size, added.length, 'no duplicate add suggestions');
});

test('a free agent with no projection is never recommended', () => {
  const ctx = world({ mine: BASE, theirs: [], free: [] });
  // A rookie with no prior-season line: present in the catalogue, no projection row.
  ctx.playersById.rookie = { id: 'rookie', fullName: 'rookie', position: 'WR', nflTeam: 'KC', status: 'Active' };
  ctx.available.push(ctx.playersById.rookie);
  const { board } = waiverBoard(ctx, 'me');
  assert.ok(!board.some((e) => e.playerId === 'rookie'), 'unknown is not the same as good');
});

test('mvIn is zero for a free agent who would not crack the lineup', () => {
  const ctx = world({
    mine: BASE, theirs: [],
    free: [{ id: 'meh', position: 'WR', points: 4 }],
  });
  const { board } = waiverBoard(ctx, 'me');
  const entry = board.find((e) => e.playerId === 'meh');
  assert.equal(entry.mvIn, 0);
  assert.equal(entry.wouldStart, false);
  assert.ok(entry.ros > 0, 'he still has abstract value — that is the distinction');
});

// ---- waiver order ----

test('waiver order sorts by position and reports completeness', () => {
  const teams = [
    { id: 'a', waiverPosition: 3, waiverBudgetUsed: 0 },
    { id: 'b', waiverPosition: 1, waiverBudgetUsed: 0 },
    { id: 'c', waiverPosition: 2, waiverBudgetUsed: 0 },
  ];
  const { order, complete, budgetInUse } = waiverOrder(teams);
  assert.deepEqual(order.map((t) => t.id), ['b', 'c', 'a']);
  assert.equal(complete, true);
  assert.equal(budgetInUse, false);
});

test('a league missing waiver positions reports itself incomplete rather than half a list', () => {
  const teams = [
    { id: 'a', waiverPosition: 1, waiverBudgetUsed: 0 },
    { id: 'b', waiverPosition: null, waiverBudgetUsed: 0 },
  ];
  const { order, complete } = waiverOrder(teams);
  assert.equal(order.length, 1);
  assert.equal(complete, false, 'a partial order is not an order');
});

test('spent FAAB budget is detected', () => {
  const { budgetInUse } = waiverOrder([
    { id: 'a', waiverPosition: 1, waiverBudgetUsed: 0 },
    { id: 'b', waiverPosition: 2, waiverBudgetUsed: 17 },
  ]);
  assert.equal(budgetInUse, true);
});
