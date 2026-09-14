import { test } from 'node:test';
import assert from 'node:assert/strict';
import { byeWeeksFromGames, gamesRemaining } from '../../src/projections/schedule.js';
import { restOfSeasonValues } from '../../src/analysis/value.js';
import { baselineProjections } from '../../src/projections/baseline.js';

/** A tiny four-team league: everyone plays every week except their bye. */
function schedule() {
  const games = [];
  const pair = (week, home, away, extra = {}) =>
    games.push({ season: '2026', game_type: 'REG', week: String(week), home_team: home, away_team: away, ...extra });

  // Weeks 1-2: everyone plays. Week 3: AAA and BBB are off. Week 4: CCC, DDD off.
  pair(1, 'AAA', 'BBB'); pair(1, 'CCC', 'DDD');
  pair(2, 'AAA', 'CCC'); pair(2, 'BBB', 'DDD');
  pair(3, 'CCC', 'DDD');
  pair(4, 'AAA', 'BBB');
  return games;
}

test('a bye is inferred from the week a team does not appear', () => {
  const { byeWeeks, weeks, anomalies } = byeWeeksFromGames(schedule(), '2026');
  assert.deepEqual(weeks, [1, 2, 3, 4]);
  assert.deepEqual(byeWeeks, { AAA: 3, BBB: 3, CCC: 4, DDD: 4 });
  assert.deepEqual(anomalies, []);
});

test('preseason and playoff games never contribute to a bye', () => {
  const games = schedule();
  // A playoff game in week 3 must not erase AAA's bye.
  games.push({ season: '2026', game_type: 'POST', week: '3', home_team: 'AAA', away_team: 'BBB' });
  games.push({ season: '2026', game_type: 'PRE', week: '3', home_team: 'AAA', away_team: 'CCC' });
  const { byeWeeks } = byeWeeksFromGames(games, '2026');
  assert.equal(byeWeeks.AAA, 3);
});

test('another season does not leak in', () => {
  const games = schedule();
  games.push({ season: '2025', game_type: 'REG', week: '3', home_team: 'AAA', away_team: 'BBB' });
  assert.equal(byeWeeksFromGames(games, '2026').byeWeeks.AAA, 3);
});

test('a team with no single bye is reported rather than guessed at', () => {
  // A partial schedule where DDD appears in no week at all.
  const games = [
    { season: '2026', game_type: 'REG', week: '1', home_team: 'AAA', away_team: 'BBB' },
    { season: '2026', game_type: 'REG', week: '2', home_team: 'AAA', away_team: 'BBB' },
  ];
  const { byeWeeks, anomalies } = byeWeeksFromGames(games, '2026');
  assert.deepEqual(byeWeeks, {}, 'neither team misses a week, so neither has a bye');
  assert.equal(anomalies.length, 2);
});

// ---- games remaining ----

test('a bye still ahead costs one game; a bye already played costs nothing', () => {
  assert.equal(gamesRemaining({ byeWeek: 9, currentWeek: 4, endWeek: 17, weeks: 14 }), 13);
  assert.equal(gamesRemaining({ byeWeek: 3, currentWeek: 4, endWeek: 17, weeks: 14 }), 14);
  assert.equal(gamesRemaining({ byeWeek: 4, currentWeek: 4, endWeek: 17, weeks: 14 }), 13, 'this week counts');
});

test('an unknown bye credits every remaining week, as before byes were modelled', () => {
  assert.equal(gamesRemaining({ byeWeek: null, currentWeek: 4, endWeek: 17, weeks: 14 }), 14);
});

test('a bye beyond the fantasy season does not reduce anything', () => {
  assert.equal(gamesRemaining({ byeWeek: 18, currentWeek: 4, endWeek: 17, weeks: 14 }), 14);
});

// ---- the failure this exists to prevent ----

test('a star whose bye is this week is not devalued into a sell signal', () => {
  // THE REGRESSION: the previous model zeroed a bye week's points. Read raw,
  // the best player in the league became worth nothing and the engine advised
  // trading and dropping him. He should lose exactly one game of value.
  const players = [
    { id: 'star', position: 'RB', status: 'Active' },
    { id: 'peer', position: 'RB', status: 'Active' },
  ];
  const rows = {
    star: { projectedPoints: 20, byeWeek: 6, bye: true },   // rate kept, bye flagged
    peer: { projectedPoints: 20, byeWeek: 12, bye: false },
  };
  const values = restOfSeasonValues(players, {
    projectionFor: (p) => rows[p.id],
    weeks: 12, currentWeek: 6, endWeek: 17,
  });

  const star = values.get('star');
  assert.equal(star.quality, 'observed', 'a real rate is not imputed over');
  assert.equal(star.games, 11, 'one game lost to the bye');
  assert.equal(star.ros, 220);
  // Both have a bye ahead, so both lose a game and neither is penalised twice.
  assert.equal(values.get('peer').games, 11);
  assert.equal(star.ros, values.get('peer').ros, 'equal players stay equal');
});

test('a player whose bye has passed is worth more than one whose has not', () => {
  const players = [
    { id: 'done', position: 'WR', status: 'Active' },
    { id: 'pending', position: 'WR', status: 'Active' },
  ];
  const rows = {
    done: { projectedPoints: 10, byeWeek: 5, bye: false },
    pending: { projectedPoints: 10, byeWeek: 14, bye: false },
  };
  const values = restOfSeasonValues(players, {
    projectionFor: (p) => rows[p.id], weeks: 8, currentWeek: 10, endWeek: 17,
  });
  assert.equal(values.get('done').games, 8);
  assert.equal(values.get('pending').games, 7);
  assert.ok(values.get('done').ros > values.get('pending').ros,
    'identical rates, but one has a bye still to come');
});

test('a feed that zeroes a bye is still imputed over', () => {
  // The legacy shape has to keep working: some sources report 0 on a bye.
  const players = [
    { id: 'star', position: 'TE', status: 'Active' },
    { id: 'peer', position: 'TE', status: 'Active' },
  ];
  const rows = {
    star: { projectedPoints: 0, bye: true, byeWeek: 6 },
    peer: { projectedPoints: 14, bye: false, byeWeek: 9 },
  };
  const values = restOfSeasonValues(players, {
    projectionFor: (p) => rows[p.id], weeks: 12, currentWeek: 6, endWeek: 17,
  });
  assert.equal(values.get('star').quality, 'bye-imputed');
  assert.equal(values.get('star').base, 14, 'borrowed from the healthy peer');
});

// ---- the baseline carries the bye through ----

test('baseline projections carry the bye week and never zero the rate', () => {
  const catalog = {
    p1: { player_id: 'p1', full_name: 'Bye This Week', position: 'RB', team: 'AAA', gsis_id: '00-0000001' },
    p2: { player_id: 'p2', full_name: 'Playing', position: 'RB', team: 'CCC', gsis_id: '00-0000002' },
  };
  const stats = [
    { player_id: '00-0000001', games: '16', fantasy_points: '160', fantasy_points_ppr: '240' },
    { player_id: '00-0000002', games: '16', fantasy_points: '160', fantasy_points_ppr: '240' },
  ];
  const { projections } = baselineProjections({
    sleeperCatalog: catalog, nflversePlayers: [], nflverseStats: stats,
    playerIds: ['p1', 'p2'], leagueId: 'L', season: '2026', week: 3,
    scoringType: 'ppr', byeWeeks: { AAA: 3, CCC: 4 },
  });

  const onBye = projections.find((p) => p.playerId === 'p1');
  assert.equal(onBye.byeWeek, 3);
  assert.equal(onBye.bye, true, 'week 3 is his bye');
  assert.equal(onBye.projectedPoints, 15, 'the RATE is unchanged — zeroing it is the bug');

  const playing = projections.find((p) => p.playerId === 'p2');
  assert.equal(playing.byeWeek, 4);
  assert.equal(playing.bye, false);
});

test('a player on a team with no known bye gets a null bye week, not a wrong one', () => {
  const catalog = { p: { player_id: 'p', full_name: 'X', position: 'WR', team: 'ZZZ', gsis_id: '00-0000003' } };
  const stats = [{ player_id: '00-0000003', games: '16', fantasy_points: '80', fantasy_points_ppr: '160' }];
  const { projections } = baselineProjections({
    sleeperCatalog: catalog, nflversePlayers: [], nflverseStats: stats,
    playerIds: ['p'], leagueId: 'L', season: '2026', week: 1,
    scoringType: 'ppr', byeWeeks: { AAA: 3 },
  });
  assert.equal(projections[0].byeWeek, null);
  assert.equal(projections[0].bye, false);
});
