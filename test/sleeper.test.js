import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeLeague,
  normalizeTeams,
  normalizeRosterSlots,
  normalizePlayer,
  normalizePlayersCatalog,
  computeWaiverWire,
  extractPlayerPoints,
} from '../src/integrations/sleeper.js';

// Fixtures shaped after Sleeper's documented v1 API (docs.sleeper.com).

const rawLeague = {
  league_id: '111111111111111111',
  name: 'Test League',
  season: '2025',
  status: 'in_season',
  total_rosters: 2,
  roster_positions: ['QB', 'RB', 'WR', 'TE', 'FLEX', 'DEF', 'K', 'BN', 'BN', 'BN'],
  scoring_settings: { rec: 0.5, pass_td: 4 },
};

const rawUsers = [
  { user_id: 'u1', display_name: 'Alice', metadata: { team_name: "Alice's Aces" } },
  { user_id: 'u2', display_name: 'Bob', metadata: {} },
];

const rawRosters = [
  {
    roster_id: 1,
    owner_id: 'u1',
    starters: ['4046', '0'],
    players: ['4046', '5849'],
    reserve: [],
    taxi: [],
    settings: { wins: 3, losses: 1, ties: 0, fpts: 450, fpts_decimal: 25, fpts_against: 400, fpts_against_decimal: 10 },
  },
  {
    roster_id: 2,
    owner_id: 'u2',
    starters: ['1234'],
    players: ['1234', '9999'],
    reserve: ['9999'],
    taxi: [],
    settings: { wins: 1, losses: 3, ties: 0, fpts: 300, fpts_decimal: 0, fpts_against: 350, fpts_against_decimal: 0 },
  },
];

const rawPlayersCatalog = {
  '4046': { player_id: '4046', first_name: 'Patrick', last_name: 'Mahomes', full_name: 'Patrick Mahomes', position: 'QB', team: 'KC', age: 29, years_exp: 8, status: 'Active' },
  '5849': { player_id: '5849', first_name: 'Tom', last_name: 'Brady', full_name: 'Tom Brady', position: 'QB', team: null, age: 47, years_exp: 22, status: 'Inactive' },
  '1234': { player_id: '1234', first_name: 'A', last_name: 'Back', full_name: 'A Back', position: 'RB', team: 'SF', age: 25, years_exp: 3, status: 'Active' },
  '9999': { player_id: '9999', first_name: 'B', last_name: 'Hurt', full_name: 'B Hurt', position: 'WR', team: 'DAL', age: 27, years_exp: 5, status: 'Injured Reserve' },
  '5555': { player_id: '5555', first_name: 'C', last_name: 'FreeAgent', full_name: 'C FreeAgent', position: 'WR', team: 'MIA', age: 24, years_exp: 2, status: 'Active' },
};

test('normalizeLeague maps id, scoring type, and roster positions', () => {
  const league = normalizeLeague(rawLeague);
  assert.equal(league.id, 'sleeper:111111111111111111');
  assert.equal(league.platform, 'sleeper');
  assert.equal(league.scoringType, 'half_ppr');
  assert.equal(league.totalRosters, 2);
  assert.deepEqual(league.rosterPositions, rawLeague.roster_positions);
});

test('normalizeTeams pulls team name from user metadata, falls back to display name', () => {
  const league = normalizeLeague(rawLeague);
  const teams = normalizeTeams(rawRosters, rawUsers, league.id);
  assert.equal(teams.length, 2);
  assert.equal(teams[0].teamName, "Alice's Aces");
  assert.equal(teams[1].teamName, 'Bob');
  assert.equal(teams[0].pointsFor, 450.25);
  assert.equal(teams[0].id, `${league.id}:1`);
});

test('normalizeRosterSlots classifies starter/bench/ir correctly and drops empty slot markers', () => {
  const league = normalizeLeague(rawLeague);
  const slots = normalizeRosterSlots(rawRosters, league.id);
  // roster 1: 4046 starter, 5849 bench (the '0' starter placeholder is dropped)
  const team1Slots = slots.filter((s) => s.teamId === `${league.id}:1`);
  assert.equal(team1Slots.length, 2);
  assert.equal(team1Slots.find((s) => s.playerId === '4046').slot, 'starter');
  assert.equal(team1Slots.find((s) => s.playerId === '5849').slot, 'bench');

  // roster 2: 9999 is in `reserve` -> ir
  const team2Slots = slots.filter((s) => s.teamId === `${league.id}:2`);
  assert.equal(team2Slots.find((s) => s.playerId === '9999').slot, 'ir');
});

test('normalizePlayer handles missing full_name and null team', () => {
  const p = normalizePlayer({ player_id: '1', first_name: 'X', last_name: 'Y', position: 'RB', team: null });
  assert.equal(p.fullName, 'X Y');
  assert.equal(p.nflTeam, null);
  assert.equal(p.status, 'Unknown');
});

test('computeWaiverWire excludes rostered players and irrelevant/teamless entries', () => {
  const league = normalizeLeague(rawLeague);
  const slots = normalizeRosterSlots(rawRosters, league.id);
  const catalog = normalizePlayersCatalog(rawPlayersCatalog);
  const waivers = computeWaiverWire(catalog, slots);

  const waiverIds = waivers.map((p) => p.id);
  assert.ok(waiverIds.includes('5555'), 'unrostered active player should be on waivers');
  assert.ok(!waiverIds.includes('4046'), 'rostered player should not be on waivers');
  assert.ok(!waiverIds.includes('5849'), 'teamless player should be excluded even if unrostered');
});

test('extractPlayerPoints reads players_points across all matchups in a week', () => {
  const rawMatchups = [
    { roster_id: 1, players_points: { '4046': 24.5, '5849': 2 } },
    { roster_id: 2, players_points: { '1234': 11.2 } },
  ];
  const points = extractPlayerPoints(rawMatchups);
  assert.equal(points['4046'], 24.5);
  assert.equal(points['1234'], 11.2);
  assert.equal(Object.keys(points).length, 3);
});
