#!/usr/bin/env node
/**
 * Builds a self-contained demo dataset shaped exactly like what the real
 * Sleeper pipeline (src/integrations/sleeper.js) produces, so the dashboard
 * can be built and reviewed before a real league is connected (this
 * session's network egress currently blocks api.sleeper.app).
 *
 * Real, well-known NFL players are used (public factual data: name,
 * position, real team) but their assignment to demo fantasy teams and
 * their weekly scoring history are fabricated for demonstration only.
 *
 * Writes db-ready documents to scripts/demo-data.json, grouped by
 * collection path, for the write_db batch calls used to seed the artifact.
 */

import { writeFileSync } from 'node:fs';
import { leagueId as makeLeagueId, teamId as makeTeamId, ROSTER_SLOT } from '../src/model/schema.js';
import { computeWaiverWire } from '../src/integrations/sleeper.js';
import { computeProjections } from '../src/projections/customModel.js';

// Deterministic PRNG so the "demo" data is stable across regenerations.
function mulberry32(seed) {
  return function () {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rand = mulberry32(42);
// Separate stream for free-agent scoring history so adding it never shifts the
// main sequence — rosters, records and rankings stay byte-identical.
const randFA = mulberry32(99);
const pick = (arr) => arr[Math.floor(rand() * arr.length)];
const shuffled = (arr) => arr.map((v) => [rand(), v]).sort((a, b) => a[0] - b[0]).map(([, v]) => v);

// A reasonably deep real-player pool across skill positions.
const PLAYER_POOL = [
  ['QB', 'Patrick Mahomes', 'KC'], ['QB', 'Josh Allen', 'BUF'], ['QB', 'Jalen Hurts', 'PHI'],
  ['QB', 'Lamar Jackson', 'BAL'], ['QB', 'Joe Burrow', 'CIN'], ['QB', 'Justin Herbert', 'LAC'],
  ['QB', 'C.J. Stroud', 'HOU'], ['QB', 'Dak Prescott', 'DAL'],
  ['RB', 'Christian McCaffrey', 'SF'], ['RB', 'Bijan Robinson', 'ATL'], ['RB', 'Breece Hall', 'NYJ'],
  ['RB', 'Jonathan Taylor', 'IND'], ['RB', 'Saquon Barkley', 'PHI'], ['RB', "De'Von Achane", 'MIA'],
  ['RB', 'Kenneth Walker III', 'SEA'], ['RB', 'Jahmyr Gibbs', 'DET'], ['RB', 'Josh Jacobs', 'GB'],
  ['RB', 'Derrick Henry', 'BAL'], ['RB', 'Isiah Pacheco', 'KC'], ['RB', 'James Cook', 'BUF'],
  ['WR', 'CeeDee Lamb', 'DAL'], ['WR', 'Tyreek Hill', 'MIA'], ['WR', "Ja'Marr Chase", 'CIN'],
  ['WR', 'Justin Jefferson', 'MIN'], ['WR', 'Amon-Ra St. Brown', 'DET'], ['WR', 'A.J. Brown', 'PHI'],
  ['WR', 'Puka Nacua', 'LAR'], ['WR', 'Garrett Wilson', 'NYJ'], ['WR', 'Drake London', 'ATL'],
  ['WR', 'DK Metcalf', 'SEA'], ['WR', 'Chris Olave', 'NO'], ['WR', 'Davante Adams', 'LV'],
  ['WR', 'Mike Evans', 'TB'], ['WR', 'Nico Collins', 'HOU'],
  ['TE', 'Travis Kelce', 'KC'], ['TE', 'Sam LaPorta', 'DET'], ['TE', 'Mark Andrews', 'BAL'],
  ['TE', 'Trey McBride', 'ARI'], ['TE', 'George Kittle', 'SF'], ['TE', 'Evan Engram', 'JAX'],
  ['K', 'Justin Tucker', 'BAL'], ['K', 'Harrison Butker', 'KC'], ['K', 'Brandon Aubrey', 'DAL'],
  ['K', 'Jake Moody', 'SF'],
  ['DEF', 'San Francisco 49ers', 'SF'], ['DEF', 'Dallas Cowboys', 'DAL'], ['DEF', 'Baltimore Ravens', 'BAL'],
  ['DEF', 'Buffalo Bills', 'BUF'],
  // depth / waiver-wire-tier players, so demo waiver wires aren't empty
  ['QB', 'Kirk Cousins', 'ATL'], ['QB', 'Kyler Murray', 'ARI'], ['QB', 'Trevor Lawrence', 'JAX'],
  ['QB', 'Matthew Stafford', 'LAR'], ['QB', 'Baker Mayfield', 'TB'], ['QB', 'Geno Smith', 'SEA'],
  ['RB', 'Rhamondre Stevenson', 'NE'], ['RB', 'Javonte Williams', 'DAL'], ['RB', 'Tony Pollard', 'TEN'],
  ['RB', 'Rachaad White', 'TB'], ['RB', 'Zamir White', 'LV'], ['RB', 'Tyjae Spears', 'TEN'],
  ['RB', 'Jaylen Warren', 'PIT'], ['RB', 'Alexander Mattison', 'LV'], ['RB', 'Chuba Hubbard', 'CAR'],
  ['WR', 'Jaylen Waddle', 'MIA'], ['WR', 'Tee Higgins', 'CIN'], ['WR', 'Diontae Johnson', 'CAR'],
  ['WR', 'Terry McLaurin', 'WAS'], ['WR', 'Calvin Ridley', 'TEN'], ['WR', 'Jordan Addison', 'MIN'],
  ['WR', 'Rome Odunze', 'CHI'], ['WR', 'Jameson Williams', 'DET'], ['WR', 'Christian Kirk', 'JAX'],
  ['WR', 'Courtland Sutton', 'DEN'], ['WR', 'Jerry Jeudy', 'CLE'], ['WR', 'Marvin Harrison Jr.', 'ARI'],
  ['TE', 'David Njoku', 'CLE'], ['TE', 'Dalton Kincaid', 'BUF'], ['TE', 'Jake Ferguson', 'DAL'],
  ['TE', 'Cole Kmet', 'CHI'], ['TE', 'Pat Freiermuth', 'PIT'],
  ['K', 'Younghoe Koo', 'ATL'], ['K', 'Tyler Bass', 'BUF'], ['K', 'Chris Boswell', 'PIT'],
  ['DEF', 'New York Jets', 'NYJ'], ['DEF', 'Pittsburgh Steelers', 'PIT'], ['DEF', 'Cleveland Browns', 'CLE'],
  // enough depth that full 14-man rosters still leave a real waiver wire
  ['QB', 'Jordan Love', 'GB'], ['QB', 'Tua Tagovailoa', 'MIA'], ['QB', 'Jared Goff', 'DET'],
  ['QB', 'Brock Purdy', 'SF'], ['QB', 'Bo Nix', 'DEN'], ['QB', 'Caleb Williams', 'CHI'],
  ['QB', 'Sam Darnold', 'MIN'], ['QB', 'Anthony Richardson', 'IND'],
  ['RB', 'Travis Etienne', 'JAX'], ['RB', 'David Montgomery', 'DET'], ['RB', 'Aaron Jones', 'MIN'],
  ['RB', 'Joe Mixon', 'HOU'], ['RB', 'Najee Harris', 'PIT'], ['RB', 'Kyren Williams', 'LAR'],
  ["RB", "D'Andre Swift", 'CHI'], ['RB', 'Brian Robinson Jr.', 'WAS'], ['RB', 'Nick Chubb', 'CLE'],
  ['RB', 'Austin Ekeler', 'WAS'], ['RB', 'James Conner', 'ARI'], ['RB', 'Zach Charbonnet', 'SEA'],
  ['RB', 'Jerome Ford', 'CLE'], ['RB', 'Tank Bigsby', 'JAX'], ['RB', 'Ty Chandler', 'MIN'],
  ['RB', 'Bucky Irving', 'TB'], ['RB', 'Blake Corum', 'LAR'], ['RB', 'Trey Benson', 'ARI'],
  ['RB', 'Ray Davis', 'BUF'], ['RB', 'Braelon Allen', 'NYJ'], ['RB', 'Jaleel McLaughlin', 'DEN'],
  ['WR', 'Amari Cooper', 'BUF'], ['WR', 'Stefon Diggs', 'HOU'], ['WR', 'Deebo Samuel', 'SF'],
  ['WR', 'Brandon Aiyuk', 'SF'], ['WR', 'George Pickens', 'PIT'], ['WR', 'Zay Flowers', 'BAL'],
  ['WR', 'Michael Pittman Jr.', 'IND'], ['WR', 'Keenan Allen', 'CHI'], ['WR', 'DJ Moore', 'CHI'],
  ['WR', 'Tyler Lockett', 'SEA'], ['WR', 'Chris Godwin', 'TB'], ['WR', 'Jakobi Meyers', 'LV'],
  ['WR', 'Khalil Shakir', 'BUF'], ['WR', 'Josh Downs', 'IND'], ["WR", "Wan'Dale Robinson", 'NYG'],
  ['WR', 'Darnell Mooney', 'ATL'], ['WR', 'Romeo Doubs', 'GB'], ['WR', 'Jayden Reed', 'GB'],
  ['WR', 'Xavier Worthy', 'KC'], ['WR', 'Ladd McConkey', 'LAC'], ['WR', 'Brian Thomas Jr.', 'JAX'],
  ['WR', 'Keon Coleman', 'BUF'], ['WR', 'Adam Thielen', 'CAR'], ['WR', 'Tyler Boyd', 'TEN'],
  ['TE', 'Kyle Pitts', 'ATL'], ['TE', 'Dallas Goedert', 'PHI'], ['TE', 'Tucker Kraft', 'GB'],
  ['TE', 'Isaiah Likely', 'BAL'], ['TE', 'Hunter Henry', 'NE'], ['TE', 'Tyler Conklin', 'NYJ'],
  ['TE', 'Noah Fant', 'SEA'], ['TE', 'Juwan Johnson', 'NO'], ['TE', 'Zach Ertz', 'WAS'],
  ['K', 'Cameron Dicker', 'LAC'], ['K', 'Jake Elliott', 'PHI'], ["K", "Ka'imi Fairbairn", 'HOU'],
  ['K', 'Jason Sanders', 'MIA'],
  ['DEF', 'Philadelphia Eagles', 'PHI'], ['DEF', 'Denver Broncos', 'DEN'],
  ['DEF', 'Houston Texans', 'HOU'], ['DEF', 'Green Bay Packers', 'GB'],
];

let nextPlayerId = 1000;
const players = PLAYER_POOL.map(([position, fullName, nflTeam]) => ({
  id: String(nextPlayerId++),
  platformIds: { sleeper: String(nextPlayerId - 1) },
  fullName,
  position,
  nflTeam,
  status: 'Active',
  age: 22 + Math.floor(rand() * 12),
  yearsExp: Math.floor(rand() * 10),
}));
const playersById = Object.fromEntries(players.map((p) => [p.id, p]));

const OWNER_NAMES = ['Alex', 'Jordan', 'Sam', 'Taylor', 'Morgan', 'Casey', 'Riley', 'Jamie', 'Drew', 'Quinn', 'Reese', 'Avery'];
const ROSTER_POSITIONS = ['QB', 'RB', 'RB', 'WR', 'WR', 'TE', 'FLEX', 'DEF', 'K', 'BN', 'BN', 'BN', 'BN', 'BN'];
const ROSTER_SIZE = ROSTER_POSITIONS.length;
const STARTER_COUNT = ROSTER_POSITIONS.filter((slot) => slot !== 'BN').length;

function buildDemoLeague({ externalId, name, season, scoringType, teamCount, playerSubset, currentWeek }) {
  const id = makeLeagueId('sleeper', externalId);
  const league = {
    id, platform: 'sleeper', externalId, name, season, scoringType,
    totalRosters: teamCount, rosterPositions: ROSTER_POSITIONS, status: 'in_season',
  };

  const teams = [];
  const rosterSlots = [];

  for (let t = 1; t <= teamCount; t++) {
    const owner = OWNER_NAMES[(t - 1) % OWNER_NAMES.length];
    const wins = Math.floor(rand() * 6);
    const losses = Math.floor(rand() * (7 - wins));
    teams.push({
      id: makeTeamId(id, String(t)), leagueId: id, externalId: String(t),
      ownerName: owner, teamName: `${owner}'s Team`,
      wins, losses, ties: 0,
      pointsFor: Math.round((800 + rand() * 400) * 10) / 10,
      pointsAgainst: Math.round((800 + rand() * 400) * 10) / 10,
    });
  }

  // Snake draft with position caps. Filling rosters by slicing a shuffled list
  // produced teams with no bench and sometimes no quarterback, which left every
  // roster with zero surplus — and a trade engine needs surplus to work with.
  const MIN_BY_POSITION = { QB: 1, RB: 2, WR: 2, TE: 1, K: 1, DEF: 1 };
  const MAX_BY_POSITION = { QB: 2, RB: 5, WR: 6, TE: 2, K: 1, DEF: 1 };
  const board = shuffled(playerSubset);
  const drafted = new Set();
  const byTeam = new Map(teams.map((team) => [team.id, []]));

  for (let round = 0; round < ROSTER_SIZE; round++) {
    const order = round % 2 === 0 ? teams : teams.slice().reverse();
    for (const team of order) {
      const roster = byTeam.get(team.id);
      const counts = {};
      roster.forEach((p) => { counts[p.position] = (counts[p.position] || 0) + 1; });
      const slotsLeft = ROSTER_SIZE - roster.length;

      // Anything still below its minimum that we no longer have room to defer.
      const urgent = Object.keys(MIN_BY_POSITION).filter((pos) => (counts[pos] || 0) < MIN_BY_POSITION[pos]);
      const mustFillNow = urgent.filter(() => true).length >= slotsLeft ? urgent : null;

      const pick = board.find((p) => {
        if (drafted.has(p.id)) return false;
        if ((counts[p.position] || 0) >= MAX_BY_POSITION[p.position]) return false;
        if (mustFillNow && !mustFillNow.includes(p.position)) return false;
        return true;
      }) || board.find((p) => !drafted.has(p.id) && (counts[p.position] || 0) < MAX_BY_POSITION[p.position]);

      if (!pick) continue;
      drafted.add(pick.id);
      roster.push(pick);
    }
  }

  for (const team of teams) {
    byTeam.get(team.id).forEach((p, i) => {
      rosterSlots.push({
        leagueId: id, teamId: team.id, playerId: p.id,
        slot: i < STARTER_COUNT ? ROSTER_SLOT.STARTER : ROSTER_SLOT.BENCH,
      });
    });
  }

  // Fabricate 1..currentWeek-1 of weekly scoring history per rostered player,
  // shaped like what extractPlayerPoints() would produce from real matchups.
  const rosteredIds = new Set(rosterSlots.map((s) => s.playerId));
  const weeklyPointsByPlayer = {};
  const basePointsByPosition = { QB: 18, RB: 12, WR: 11, TE: 8, K: 7, DEF: 7 };
  for (const playerId of rosteredIds) {
    const player = playersById[playerId];
    const base = basePointsByPosition[player.position] ?? 8;
    weeklyPointsByPlayer[playerId] = {};
    for (let w = 1; w < currentWeek; w++) {
      const noise = (rand() - 0.5) * base * 0.8;
      weeklyPointsByPlayer[playerId][w] = Math.max(0, Math.round((base + noise) * 10) / 10);
    }
  }

  // Unrostered players need history too — a real Sleeper pipeline has scoring
  // for anyone who played, and the waiver wire is useless without projections.
  // They skew lower, which is roughly why they went undrafted.
  for (const player of players) {
    if (weeklyPointsByPlayer[player.id]) continue;
    const base = (basePointsByPosition[player.position] ?? 8) * (0.5 + randFA() * 0.4);
    weeklyPointsByPlayer[player.id] = {};
    for (let w = 1; w < currentWeek; w++) {
      const noise = (randFA() - 0.5) * base * 0.9;
      weeklyPointsByPlayer[player.id][w] = Math.max(0, Math.round((base + noise) * 10) / 10);
    }
  }

  const projections = computeProjections({
    players,
    weeklyPointsByPlayer,
    leagueId: id,
    season,
    week: currentWeek,
  });

  return { league, teams, rosterSlots, projections };
}

const CURRENT_WEEK = 4;
const SEASON = '2025';

const leagueA = buildDemoLeague({
  externalId: 'demo-ppr-001', name: 'Demo PPR League', season: SEASON,
  scoringType: 'ppr', teamCount: 6, playerSubset: players, currentWeek: CURRENT_WEEK,
});
const leagueB = buildDemoLeague({
  externalId: 'demo-std-002', name: 'Demo Standard League', season: SEASON,
  scoringType: 'standard', teamCount: 4, playerSubset: shuffled(players), currentWeek: CURRENT_WEEK,
});

const allRosterSlots = [...leagueA.rosterSlots, ...leagueB.rosterSlots];

// Rankings: honest about their source — a simple rank derived from this
// demo's own rolling averages, NOT a real expert-consensus feed. Labeled as
// such in the UI. One ranking list per position, independent of league.
const positionGroups = {};
for (const p of players) {
  (positionGroups[p.position] ??= []).push(p);
}
const rankings = [];
for (const [position, list] of Object.entries(positionGroups)) {
  shuffled(list).forEach((p, i) => {
    rankings.push({ playerId: p.id, position, rank: i + 1, tier: Math.ceil((i + 1) / 4), source: 'custom-demo', asOf: new Date().toISOString().slice(0, 10) });
  });
}

const waiverWireA = computeWaiverWire(playersById, leagueA.rosterSlots).map((p) => p.id);
const waiverWireB = computeWaiverWire(playersById, leagueB.rosterSlots).map((p) => p.id);

const output = {
  meta: {
    lastRefreshedAt: new Date().toISOString(),
    demoMode: true,
    demoNote: 'Sample data: real player names/positions/teams, fabricated rosters/stats. Connect a real Sleeper league to replace this.',
    connectedLeagueIds: [leagueA.league.id, leagueB.league.id],
    currentWeek: CURRENT_WEEK,
    season: SEASON,
  },
  leagues: [leagueA.league, leagueB.league],
  teams: [...leagueA.teams, ...leagueB.teams],
  rosterSlots: allRosterSlots,
  players,
  projections: [...leagueA.projections, ...leagueB.projections],
  rankings,
  waiverWireByLeague: {
    [leagueA.league.id]: waiverWireA,
    [leagueB.league.id]: waiverWireB,
  },
};

writeFileSync(new URL('./demo-data.json', import.meta.url), JSON.stringify(output, null, 2));
console.log(`Wrote demo data: ${output.leagues.length} leagues, ${output.teams.length} teams, ${output.players.length} players, ${allRosterSlots.length} roster slots, ${output.projections.length} projections.`);
