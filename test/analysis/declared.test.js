import { test } from 'node:test';
import assert from 'node:assert/strict';
import { declaredLineup, optimalLineup } from '../../src/analysis/lineup.js';
import { normalizeRosterSlots } from '../../src/integrations/sleeper.js';
import { buildContext } from '../../src/analysis/index.js';

const SLOTS = ['QB', 'RB', 'RB', 'WR', 'WR', 'TE', 'FLEX', 'K', 'DEF', 'BN', 'BN'];
const P = (id, position, value) => ({ id, position, fullName: id, status: 'Active', value });
const val = (p) => p.value;

const ROSTER = [
  P('qb', 'QB', 300),
  P('rb1', 'RB', 250), P('rb2', 'RB', 200), P('rb3', 'RB', 190),
  P('wr1', 'WR', 240), P('wr2', 'WR', 210), P('wr3', 'WR', 120),
  P('te', 'TE', 150),
  P('k', 'K', 100), P('def', 'DEF', 90),
];
/** Slot indexes: 0 QB, 1 RB, 2 RB, 3 WR, 4 WR, 5 TE, 6 FLEX, 7 K, 8 DEF */
const declared = (map) => declaredLineup(ROSTER, SLOTS, val, (id) => (id in map ? map[id] : null));

test('a declared lineup is taken at face value, even when it is not optimal', () => {
  // The manager flexed his weakest receiver over his third running back.
  const mine = declared({ qb: 0, rb1: 1, rb2: 2, wr1: 3, wr2: 4, te: 5, wr3: 6, k: 7, def: 8 });
  const best = optimalLineup(ROSTER, SLOTS, val);

  assert.equal(mine.assignments.find((a) => a.slot === 'FLEX').playerId, 'wr3');
  assert.equal(best.assignments.find((a) => a.slot === 'FLEX').playerId, 'rb3',
    'the solver would flex the better player');
  assert.equal(mine.total, 1660);
  assert.equal(best.total, 1730);
  assert.ok(best.total > mine.total, 'the gap is the whole point of showing both');
});

test('a slot the manager left empty is reported, not silently filled', () => {
  const mine = declared({ qb: 0, rb1: 1, rb2: 2, wr1: 3, wr2: 4, te: 5, k: 7, def: 8 });
  assert.deepEqual(mine.unfilled, [{ slot: 'FLEX', slotIndex: 6 }]);
  assert.ok(mine.benched.includes('rb3'), 'unassigned players are benched, not lost');
});

test('an ineligible declared assignment is flagged rather than quietly moved', () => {
  // A quarterback in the flex is not legal in this league.
  const mine = declaredLineup(ROSTER, SLOTS, val, (id) => (id === 'qb' ? 6 : null));
  assert.equal(mine.illegal.length, 1);
  assert.equal(mine.illegal[0].slot, 'FLEX');
  assert.equal(mine.illegal[0].playerId, 'qb');
  assert.equal(mine.assignments[0].playerId, 'qb', 'still reported as declared');
});

test('two players claiming one slot does not double-count', () => {
  const mine = declaredLineup(ROSTER, SLOTS, val, (id) => (id === 'rb1' || id === 'rb2' ? 1 : null));
  const inSlotOne = mine.assignments.filter((a) => a.slotIndex === 1);
  assert.equal(inSlotOne.length, 1);
  assert.equal(mine.total, inSlotOne[0].value);
});

test('an optimal declaration equals the solver exactly', () => {
  const best = optimalLineup(ROSTER, SLOTS, val);
  const map = Object.fromEntries(best.assignments.map((a) => [a.playerId, a.slotIndex]));
  assert.equal(declared(map).total, best.total);
});

// ---- the Sleeper shape this reads ----

test('Sleeper starter order survives normalization', () => {
  // `starters` is positional. Collapsing it to a set of ids — which this used
  // to do — loses which slot each player occupies.
  const raw = [{
    roster_id: 1,
    owner_id: 'u1',
    starters: ['qb', 'rb1', 'rb2', 'wr1', 'wr2', 'te', 'wr3', 'k', 'MIN'],
    players: ['qb', 'rb1', 'rb2', 'wr1', 'wr2', 'te', 'wr3', 'k', 'MIN', 'rb3'],
    reserve: [], taxi: [], settings: {},
  }];
  const slots = normalizeRosterSlots(raw, 'L');
  const byId = Object.fromEntries(slots.map((s) => [s.playerId, s]));

  assert.equal(byId.qb.lineupSlot, 0);
  assert.equal(byId.wr3.lineupSlot, 6, 'the flex is index 6');
  assert.equal(byId.MIN.lineupSlot, 8);
  assert.equal(byId.rb3.lineupSlot, null, 'a bench player has no lineup slot');
  assert.equal(byId.rb3.slot, 'bench');
});

test('an empty Sleeper slot does not shift the indexes after it', () => {
  // '0' marks a slot the manager left empty. Filtering it out before indexing
  // would move every later player up one slot.
  const raw = [{
    roster_id: 1, owner_id: 'u1',
    starters: ['qb', '0', 'rb2', 'wr1', 'wr2', 'te', 'wr3', 'k', 'MIN'],
    players: ['qb', 'rb2', 'wr1', 'wr2', 'te', 'wr3', 'k', 'MIN'],
    reserve: [], taxi: [], settings: {},
  }];
  const byId = Object.fromEntries(normalizeRosterSlots(raw, 'L').map((s) => [s.playerId, s]));
  assert.equal(byId.rb2.lineupSlot, 2, 'still the second RB slot, not the first');
  assert.equal(byId.MIN.lineupSlot, 8);
});

test('buildContext exposes the declared lineup and says when it has none', () => {
  const league = {
    id: 'L', name: 'T', season: '2026', scoringType: 'ppr',
    totalRosters: 1, rosterPositions: SLOTS, status: 'in_season',
  };
  const teams = [{ id: 'L:1', leagueId: 'L', externalId: '1', ownerId: 'u1',
    ownerName: 'Me', teamName: 'Mine', wins: 0, losses: 0, ties: 0, pointsFor: 0, pointsAgainst: 0 }];
  const playersById = Object.fromEntries(ROSTER.map((p) => [p.id, { ...p, nflTeam: 'KC' }]));
  const projections = ROSTER.map((p) => ({
    playerId: p.id, leagueId: 'L', season: '2026', week: 1,
    projectedPoints: p.value / 10, bye: false, byeWeek: null, opponent: null, source: 'test',
  }));
  const withOrder = ROSTER.map((p, i) => ({
    leagueId: 'L', teamId: 'L:1', playerId: p.id,
    slot: i < 9 ? 'starter' : 'bench', lineupSlot: i < 9 ? i : null,
  }));

  const ctx = buildContext({ league, teams, rosterSlots: withOrder, playersById, projections, rankings: [], currentWeek: 1 });
  assert.equal(ctx.hasDeclaredLineups, true);
  assert.ok(ctx.declaredFor('L:1').total > 0);

  // A snapshot from before lineup order was captured must not fake one.
  const noOrder = withOrder.map(({ lineupSlot, ...rest }) => rest);
  const older = buildContext({ league, teams, rosterSlots: noOrder, playersById, projections, rankings: [], currentWeek: 1 });
  assert.equal(older.hasDeclaredLineups, false);
  assert.equal(older.declaredFor('L:1'), null, 'absent, not an empty lineup');
});
