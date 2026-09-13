import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rollingAverage, opponentAdjustment, computeProjections } from '../src/projections/customModel.js';

test('rollingAverage weights recent weeks more heavily and ignores future weeks', () => {
  const history = { p1: { 1: 10, 2: 20, 3: 30 } };
  const result = rollingAverage(history, 'p1', 4, 4);
  // weights are 3,2,1 for weeks 3,2,1 respectively -> (30*3+20*2+10*1)/6 = 23.33
  assert.equal(result.gamesPlayed, 3);
  assert.ok(Math.abs(result.average - 23.3333) < 0.01);
});

test('rollingAverage excludes weeks at/after the projection week', () => {
  const history = { p1: { 1: 10, 5: 999 } };
  const result = rollingAverage(history, 'p1', 5, 4);
  assert.equal(result.gamesPlayed, 1);
  assert.equal(result.average, 10);
});

test('rollingAverage returns null for players with no history', () => {
  assert.equal(rollingAverage({}, 'ghost', 3), null);
});

test('opponentAdjustment clamps extreme values to +/-15%', () => {
  assert.equal(opponentAdjustment(2.0), 1.15);
  assert.equal(opponentAdjustment(0.1), 0.85);
  assert.equal(opponentAdjustment(null), 1);
  assert.equal(opponentAdjustment(1.05), 1.05);
});

test('computeProjections zeroes out bye-week players and applies opponent adjustment otherwise', () => {
  const players = [
    { id: 'p1', position: 'RB', nflTeam: 'KC' },
    { id: 'p2', position: 'WR', nflTeam: 'SF' },
  ];
  const weeklyPointsByPlayer = {
    p1: { 1: 10, 2: 10, 3: 10 },
    p2: { 1: 20, 2: 20, 3: 20 },
  };
  const scheduleLookup = (team, week) =>
    team === 'KC' ? { opponent: null, bye: true } : { opponent: 'DAL', bye: false };
  const defenseStrengthLookup = (position, opponent) => (opponent === 'DAL' ? 1.15 : 1);

  const projections = computeProjections({
    players,
    weeklyPointsByPlayer,
    leagueId: 'sleeper:1',
    season: '2025',
    week: 4,
    scheduleLookup,
    defenseStrengthLookup,
  });

  const p1 = projections.find((p) => p.playerId === 'p1');
  const p2 = projections.find((p) => p.playerId === 'p2');
  assert.equal(p1.bye, true);
  assert.equal(p1.projectedPoints, 0);
  assert.equal(p2.bye, false);
  assert.equal(p2.opponent, 'DAL');
  assert.equal(p2.projectedPoints, 23); // 20 * 1.15
});
