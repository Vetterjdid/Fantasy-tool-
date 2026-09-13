/**
 * End-to-end checks over the real demo dataset and a full-size league.
 *
 * These are the tests that catch a silent break in the whole chain — the unit
 * tests above can all pass while the assembled engine returns nonsense.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { buildContext, findTrades, weakSpots } from '../../src/analysis/index.js';

const DEMO = fileURLToPath(new URL('../../scripts/demo-data.json', import.meta.url));
const GENERATOR = fileURLToPath(new URL('../../scripts/build-demo-data.mjs', import.meta.url));

function demoData() {
  // Generated output is not committed; it is deterministic, so rebuild on demand
  // rather than skipping the only end-to-end coverage we have.
  if (!existsSync(DEMO)) execFileSync(process.execPath, [GENERATOR], { stdio: 'ignore' });
  return JSON.parse(readFileSync(DEMO, 'utf8'));
}

function contextForFirstLeague(data) {
  const league = data.leagues[0];
  return buildContext({
    league,
    teams: data.teams.filter((t) => t.leagueId === league.id),
    rosterSlots: data.rosterSlots.filter((s) => s.leagueId === league.id),
    playersById: Object.fromEntries(data.players.map((p) => [p.id, p])),
    projections: data.projections,
    rankings: data.rankings,
    currentWeek: data.meta.currentWeek,
  });
}

test('golden: the demo league produces mutually positive trades for every team', () => {
  const data = demoData();
  const ctx = contextForFirstLeague(data);
  const teams = ctx.teams;
  assert.ok(teams.length >= 4, 'demo league should have several teams');

  let teamsWithOffers = 0;
  for (const team of teams) {
    const { suggestions } = findTrades(ctx, team.id, { limit: 10 });
    if (suggestions.length) teamsWithOffers++;

    for (const s of suggestions) {
      assert.ok(s.myGain > 0, `${team.id}: ${s.id} must gain for me`);
      assert.ok(s.theirGain > 0, `${team.id}: ${s.id} must gain for them`);
      assert.notEqual(s.partnerTeamId, team.id, 'no self-trades');
      assert.ok(s.send.length > 0 && s.receive.length > 0);
      assert.ok(
        s.send.concat(s.receive).every((p) => p.position !== 'K' && p.position !== 'DEF'),
        'kickers and defenses are not trade currency'
      );
    }
  }
  assert.ok(teamsWithOffers > 0, 'at least one team should have a workable trade');
});

test('golden: every team profile is fully populated and free of NaN', () => {
  const ctx = contextForFirstLeague(demoData());
  for (const profile of ctx.profiles.values()) {
    assert.ok(Number.isFinite(profile.total), `${profile.teamId} total`);
    assert.ok(profile.total > 0, `${profile.teamId} should field a scoring lineup`);
    for (const entry of Object.values(profile.byPosition)) {
      assert.ok(Number.isFinite(entry.z), `${profile.teamId} ${entry.position} z is ${entry.z}`);
      assert.ok(Number.isFinite(entry.starterStrength));
      assert.ok(Number.isFinite(entry.surplus));
      assert.ok(Number.isFinite(entry.exposure));
    }
    assert.ok(weakSpots(profile).length > 0);
  }
});

test('golden: a suggestion explains itself — the changes add up to the score', () => {
  const ctx = contextForFirstLeague(demoData());
  for (const team of ctx.teams) {
    const { suggestions } = findTrades(ctx, team.id, { limit: 3 });
    for (const s of suggestions) {
      const fromChanges = s.lineupChanges.reduce((sum, c) => sum + c.delta, 0);
      assert.ok(
        Math.abs(fromChanges - s.myGain) < 0.5,
        `${s.id}: lineup changes sum to ${fromChanges} but gain reported as ${s.myGain}`
      );
      assert.ok(s.rationale.length > 0, `${s.id} must say why`);
      assert.ok(s.myLineupAfter.total > s.myLineupBefore.total);
    }
  }
});

// ---- performance at full league size ----

function mulberry32(seed) {
  return function () {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function bigLeague() {
  const rand = mulberry32(7);
  const league = {
    id: 'big',
    name: 'Twelve',
    season: '2025',
    scoringType: 'ppr',
    totalRosters: 12,
    rosterPositions: ['QB', 'RB', 'RB', 'WR', 'WR', 'TE', 'FLEX', 'K', 'DEF',
      'BN', 'BN', 'BN', 'BN', 'BN', 'BN'],
    status: 'in_season',
  };
  const shape = ['QB', 'QB', 'RB', 'RB', 'RB', 'RB', 'WR', 'WR', 'WR', 'WR', 'TE', 'TE', 'K', 'DEF', 'RB'];
  const teams = [];
  const rosterSlots = [];
  const playersById = {};
  const projections = [];
  let pid = 0;

  for (let t = 0; t < 12; t++) {
    const teamId = 'team' + t;
    teams.push({
      id: teamId, leagueId: league.id, externalId: String(t), ownerName: 'Owner' + t,
      teamName: 'Team ' + t, wins: 0, losses: 0, ties: 0, pointsFor: 0, pointsAgainst: 0,
    });
    shape.forEach((position, i) => {
      const id = 'p' + pid++;
      playersById[id] = { id, fullName: 'Player ' + id, position, nflTeam: 'KC', status: 'Active' };
      rosterSlots.push({ leagueId: league.id, teamId, playerId: id, slot: i < 9 ? 'starter' : 'bench' });
      projections.push({
        playerId: id, leagueId: league.id, season: '2025', week: 4,
        projectedPoints: Math.round(rand() * 220) / 10, bye: false, opponent: null, source: 'test',
      });
    });
  }
  // free agents so replacement level is observed rather than inferred
  for (const position of ['QB', 'RB', 'WR', 'TE', 'K', 'DEF']) {
    for (let i = 0; i < 4; i++) {
      const id = 'fa' + pid++;
      playersById[id] = { id, fullName: 'FA ' + id, position, nflTeam: 'KC', status: 'Active' };
      projections.push({
        playerId: id, leagueId: league.id, season: '2025', week: 4,
        projectedPoints: Math.round(rand() * 70) / 10, bye: false, opponent: null, source: 'test',
      });
    }
  }
  return { league, teams, rosterSlots, playersById, projections };
}

test('a 12-team search finishes inside its time budget', () => {
  const { league, teams, rosterSlots, playersById, projections } = bigLeague();
  const ctx = buildContext({
    league, teams, rosterSlots, playersById, projections, rankings: [], currentWeek: 4,
  });

  const started = Date.now();
  const result = findTrades(ctx, 'team0', { limit: 25, budgetMs: 5000 });
  const elapsed = Date.now() - started;

  // Median on this machine is ~235ms for the full 12-team 2-for-2 search.
  // The bound is a regression guard with room for CI jitter, not a UX target —
  // findTrades already degrades gracefully against its own budgetMs.
  assert.ok(elapsed < 500, `took ${elapsed}ms scanning ${result.scanned} packages`);
  assert.equal(result.truncated, false, 'should complete without hitting the budget');
  for (const s of result.suggestions) {
    assert.ok(s.myGain > 0 && s.theirGain > 0);
  }
});
