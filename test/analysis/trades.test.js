import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildContext, findTrades, weakSpots, tradeChips } from '../../src/analysis/index.js';

// A deliberately lopsided two-team league: I am stacked at RB and starving at
// WR; my partner is the mirror image. There is exactly one sensible trade.
const LEAGUE = {
  id: 'sleeper:t1',
  name: 'Test',
  season: '2025',
  scoringType: 'ppr',
  totalRosters: 2,
  rosterPositions: ['QB', 'RB', 'WR', 'TE', 'FLEX', 'BN', 'BN', 'BN'],
  status: 'in_season',
};

const TEAMS = [
  { id: 'me', leagueId: LEAGUE.id, externalId: '1', ownerName: 'Me', teamName: 'Mine', wins: 1, losses: 1, ties: 0, pointsFor: 0, pointsAgainst: 0 },
  { id: 'them', leagueId: LEAGUE.id, externalId: '2', ownerName: 'Them', teamName: 'Theirs', wins: 1, losses: 1, ties: 0, pointsFor: 0, pointsAgainst: 0 },
];

function player(id, position, extra = {}) {
  return { id, platformIds: {}, fullName: `Player ${id}`, position, nflTeam: 'KC', status: 'Active', age: 25, yearsExp: 3, ...extra };
}

const PLAYERS = {
  // mine: three good RBs (only ~2 can play), a dire WR
  rb1: player('rb1', 'RB'), rb2: player('rb2', 'RB'), rb3: player('rb3', 'RB'),
  wrBad: player('wrBad', 'WR'),
  qbMine: player('qbMine', 'QB'), teMine: player('teMine', 'TE'),
  // theirs: three good WRs, a dire RB
  wr1: player('wr1', 'WR'), wr2: player('wr2', 'WR'), wr3: player('wr3', 'WR'),
  rbBad: player('rbBad', 'RB'),
  qbTheirs: player('qbTheirs', 'QB'), teTheirs: player('teTheirs', 'TE'),
  // free agents set replacement level
  faRb: player('faRb', 'RB'), faWr: player('faWr', 'WR'),
  faQb: player('faQb', 'QB'), faTe: player('faTe', 'TE'),
};

const WEEKLY = {
  rb1: 20, rb2: 19, rb3: 18, wrBad: 3,
  wr1: 20, wr2: 19, wr3: 18, rbBad: 3,
  qbMine: 18, qbTheirs: 18, teMine: 9, teTheirs: 9,
  faRb: 4, faWr: 4, faQb: 5, faTe: 2,
};

const ROSTER_SLOTS = [
  ...['rb1', 'rb2', 'rb3', 'wrBad', 'qbMine', 'teMine'].map((playerId, i) => ({
    leagueId: LEAGUE.id, teamId: 'me', playerId, slot: i < 5 ? 'starter' : 'bench',
  })),
  ...['wr1', 'wr2', 'wr3', 'rbBad', 'qbTheirs', 'teTheirs'].map((playerId, i) => ({
    leagueId: LEAGUE.id, teamId: 'them', playerId, slot: i < 5 ? 'starter' : 'bench',
  })),
];

const PROJECTIONS = Object.keys(WEEKLY).map((playerId) => ({
  playerId, leagueId: LEAGUE.id, season: '2025', week: 4,
  projectedPoints: WEEKLY[playerId], opponent: null, bye: false, source: 'test',
}));

function context(overrides = {}) {
  return buildContext({
    league: LEAGUE, teams: TEAMS, rosterSlots: ROSTER_SLOTS,
    playersById: PLAYERS, projections: PROJECTIONS, rankings: [],
    currentWeek: 16, endWeek: 17, // 2 remaining weeks keeps numbers readable
    ...overrides,
  });
}

test('buildContext derives replacement level from the actual free-agent pool', () => {
  const ctx = context();
  // 2 weeks remaining, faRb projects 4/wk -> 8 RoS, and demand-rank agrees it
  // is not the scarce end of the pool.
  assert.ok(ctx.levels.RB >= 8, `RB replacement was ${ctx.levels.RB}`);
  assert.ok(ctx.levels.WR >= 8, `WR replacement was ${ctx.levels.WR}`);
});

test('my third RB is valuable in the abstract but nearly free to give up', () => {
  const ctx = context();
  const profile = ctx.profiles.get('me');
  assert.ok(ctx.vor(PLAYERS.rb3) > 20, 'rb3 clears replacement comfortably');
  assert.ok(profile.byPosition.RB.surplus > 0, 'and shows up as surplus');
  assert.ok(profile.byPosition.WR.z < 0, 'while WR is below league average');
});

test('weakSpots ranks my starving position first', () => {
  const worst = weakSpots(ctx0().profiles.get('me'))[0];
  assert.equal(worst.position, 'WR');
});

test('tradeChips surfaces the surplus running backs', () => {
  const chips = tradeChips(ctx0().profiles.get('me')).map((c) => c.player.id);
  assert.ok(chips.length > 0);
  assert.ok(chips.every((id) => PLAYERS[id].position !== 'WR'));
});

function ctx0() {
  return context();
}

test('finds the obvious RB-for-WR swap and both sides gain', () => {
  const { suggestions } = findTrades(context(), 'me', { limit: 10 });
  assert.ok(suggestions.length > 0, 'expected at least one trade');

  const top = suggestions[0];
  assert.ok(top.myGain > 0 && top.theirGain > 0, 'mutual gain is the whole point');
  assert.equal(top.partnerTeamId, 'them');
  assert.ok(top.send.every((p) => p.position !== 'WR'), 'I should not be shipping WRs');
  assert.ok(top.receive.some((p) => p.position === 'WR'), 'I should be getting a WR');
});

test('every returned trade improves both rosters', () => {
  const { suggestions } = findTrades(context(), 'me', { limit: 50 });
  for (const s of suggestions) {
    assert.ok(s.myGain > s.epsilonUsed, `${s.id} myGain ${s.myGain}`);
    assert.ok(s.theirGain > s.epsilonUsed, `${s.id} theirGain ${s.theirGain}`);
  }
});

test('reported gain reconciles with the lineup changes that produced it', () => {
  const { suggestions } = findTrades(context(), 'me', { limit: 5 });
  for (const s of suggestions) {
    const fromChanges = s.lineupChanges.reduce((sum, c) => sum + c.delta, 0);
    assert.ok(
      Math.abs(fromChanges - s.myGain) < 0.2,
      `${s.id}: changes sum ${fromChanges} vs reported ${s.myGain}`
    );
  }
});

test('kickers and defenses are never traded', () => {
  const players = { ...PLAYERS, k1: player('k1', 'K'), d1: player('d1', 'DEF') };
  const slots = ROSTER_SLOTS.concat([
    { leagueId: LEAGUE.id, teamId: 'me', playerId: 'k1', slot: 'bench' },
    { leagueId: LEAGUE.id, teamId: 'them', playerId: 'd1', slot: 'bench' },
  ]);
  const projections = PROJECTIONS.concat([
    { playerId: 'k1', leagueId: LEAGUE.id, season: '2025', week: 4, projectedPoints: 40, bye: false, opponent: null, source: 'test' },
    { playerId: 'd1', leagueId: LEAGUE.id, season: '2025', week: 4, projectedPoints: 40, bye: false, opponent: null, source: 'test' },
  ]);
  const ctx = buildContext({
    league: LEAGUE, teams: TEAMS, rosterSlots: slots, playersById: players,
    projections, rankings: [], currentWeek: 16, endWeek: 17,
  });
  const { suggestions } = findTrades(ctx, 'me', { limit: 50 });
  for (const s of suggestions) {
    assert.ok(s.send.concat(s.receive).every((p) => p.position !== 'K' && p.position !== 'DEF'));
  }
});

test('shopPlayerId constrains every suggestion to include that player', () => {
  const { suggestions } = findTrades(context(), 'me', { shopPlayerId: 'rb3', limit: 20 });
  assert.ok(suggestions.length > 0, 'rb3 is surplus, someone should want him');
  for (const s of suggestions) {
    assert.ok(s.send.some((p) => p.playerId === 'rb3'), `${s.id} must ship rb3`);
  }
});

test('shopping an unknown player returns nothing rather than throwing', () => {
  const { suggestions } = findTrades(context(), 'me', { shopPlayerId: 'nobody' });
  assert.deepEqual(suggestions, []);
});

test('targetPosition only returns trades bringing that position back', () => {
  const { suggestions } = findTrades(context(), 'me', { targetPosition: 'WR', limit: 20 });
  assert.ok(suggestions.length > 0);
  for (const s of suggestions) {
    assert.ok(s.receive.some((p) => p.position === 'WR'));
  }
});

test('suggestions carry the structured rationale the UI renders', () => {
  const [top] = findTrades(context(), 'me', { limit: 1 }).suggestions;
  const kinds = top.rationale.map((r) => r.kind);
  assert.ok(kinds.includes('surplus') || kinds.includes('myNeed'), `got ${kinds.join(',')}`);
  for (const fact of top.rationale) assert.equal(typeof fact.position, 'string');
  assert.ok(Array.isArray(top.caveats));
  assert.ok(top.myLineupBefore.total < top.myLineupAfter.total);
});

test('a team with nothing to offer produces no suggestions, not a crash', () => {
  const ctx = buildContext({
    league: LEAGUE,
    teams: TEAMS,
    rosterSlots: ROSTER_SLOTS.filter((s) => s.teamId === 'me'),
    playersById: PLAYERS,
    projections: PROJECTIONS,
    rankings: [],
    currentWeek: 16,
    endWeek: 17,
  });
  const { suggestions } = findTrades(ctx, 'me', { limit: 10 });
  assert.deepEqual(suggestions, []);
});

test('an unknown team id returns empty rather than throwing', () => {
  assert.deepEqual(findTrades(context(), 'ghost', {}).suggestions, []);
});

test('respects its time budget instead of hanging', () => {
  let clock = 0;
  const result = findTrades(context(), 'me', { budgetMs: 5, now: () => (clock += 10) });
  assert.equal(result.truncated, true);
});
