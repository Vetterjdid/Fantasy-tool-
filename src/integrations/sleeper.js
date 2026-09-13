/**
 * Sleeper integration: fetch + normalize.
 *
 * Sleeper's public API (https://docs.sleeper.com/) requires no auth and
 * covers league settings, rosters, users, matchups, transactions and the
 * full player catalog. It does NOT provide forward-looking projections —
 * see src/projections/customModel.js, which derives rolling averages from
 * this league's own weekly matchup scoring instead.
 *
 * Only documented, stable v1 endpoints are used here. No undocumented
 * internal Sleeper endpoints (e.g. their own projections/stats routes).
 */

import { leagueId as makeLeagueId, teamId as makeTeamId, ROSTER_SLOT } from '../model/schema.js';

const BASE = 'https://api.sleeper.app/v1';
const PLATFORM = 'sleeper';

/** Sleeper asks integrators not to hit /players/nfl more than ~once/day. */
let playersCatalogCache = null;
let playersCatalogFetchedAt = 0;
const PLAYERS_CATALOG_TTL_MS = 24 * 60 * 60 * 1000;

async function fetchJson(path) {
  const res = await fetch(`${BASE}${path}`);
  if (!res.ok) {
    throw new Error(`Sleeper API ${path} failed: ${res.status} ${res.statusText}`);
  }
  return res.json();
}

/** Current NFL week/season, e.g. { week, season, season_type }. */
export async function fetchState() {
  return fetchJson('/state/nfl');
}

export async function fetchLeague(externalLeagueId) {
  return fetchJson(`/league/${externalLeagueId}`);
}

export async function fetchRosters(externalLeagueId) {
  return fetchJson(`/league/${externalLeagueId}/rosters`);
}

export async function fetchUsers(externalLeagueId) {
  return fetchJson(`/league/${externalLeagueId}/users`);
}

/** Per-league fantasy matchups for a given week (points are in this league's own scoring). */
export async function fetchMatchups(externalLeagueId, week) {
  return fetchJson(`/league/${externalLeagueId}/matchups/${week}`);
}

/** round is typically the week number for waiver/free-agent transactions. */
export async function fetchTransactions(externalLeagueId, round) {
  return fetchJson(`/league/${externalLeagueId}/transactions/${round}`);
}

/**
 * Full NFL player catalog, keyed by Sleeper player_id. Large (~5MB) —
 * cached in-memory for PLAYERS_CATALOG_TTL_MS since Sleeper asks
 * integrators not to poll it more than about once a day.
 */
export async function fetchPlayersCatalog({ force = false } = {}) {
  const stale = Date.now() - playersCatalogFetchedAt > PLAYERS_CATALOG_TTL_MS;
  if (force || !playersCatalogCache || stale) {
    playersCatalogCache = await fetchJson('/players/nfl');
    playersCatalogFetchedAt = Date.now();
  }
  return playersCatalogCache;
}

// ---- normalization: raw Sleeper shapes -> unified schema (src/model/schema.js) ----

/** @returns {import('../model/schema.js').League} */
export function normalizeLeague(raw) {
  return {
    id: makeLeagueId(PLATFORM, raw.league_id),
    platform: PLATFORM,
    externalId: raw.league_id,
    name: raw.name,
    season: raw.season,
    scoringType: inferScoringType(raw.scoring_settings),
    totalRosters: raw.total_rosters,
    rosterPositions: raw.roster_positions ?? [],
    status: raw.status,
  };
}

function inferScoringType(scoringSettings) {
  const rec = scoringSettings?.rec ?? 0;
  if (rec >= 1) return 'ppr';
  if (rec > 0) return 'half_ppr';
  if (rec === 0) return 'standard';
  return 'custom';
}

/**
 * @param {any[]} rawRosters
 * @param {any[]} rawUsers
 * @param {string} internalLeagueId
 * @returns {import('../model/schema.js').Team[]}
 */
export function normalizeTeams(rawRosters, rawUsers, internalLeagueId) {
  const usersById = new Map(rawUsers.map((u) => [u.user_id, u]));
  return rawRosters.map((roster) => {
    const user = usersById.get(roster.owner_id);
    const settings = roster.settings ?? {};
    return {
      id: makeTeamId(internalLeagueId, String(roster.roster_id)),
      leagueId: internalLeagueId,
      externalId: String(roster.roster_id),
      ownerName: user?.display_name ?? 'Unknown Owner',
      teamName: user?.metadata?.team_name || user?.display_name || `Team ${roster.roster_id}`,
      wins: settings.wins ?? 0,
      losses: settings.losses ?? 0,
      ties: settings.ties ?? 0,
      pointsFor: (settings.fpts ?? 0) + (settings.fpts_decimal ?? 0) / 100,
      pointsAgainst: (settings.fpts_against ?? 0) + (settings.fpts_against_decimal ?? 0) / 100,
    };
  });
}

/**
 * @param {any[]} rawRosters
 * @param {string} internalLeagueId
 * @returns {import('../model/schema.js').RosterSlot[]}
 */
export function normalizeRosterSlots(rawRosters, internalLeagueId) {
  /** @type {import('../model/schema.js').RosterSlot[]} */
  const slots = [];
  for (const roster of rawRosters) {
    const teamId = makeTeamId(internalLeagueId, String(roster.roster_id));
    const starters = new Set((roster.starters ?? []).filter((p) => p && p !== '0'));
    const reserve = new Set(roster.reserve ?? []);
    const taxi = new Set(roster.taxi ?? []);
    const allPlayers = roster.players ?? [];
    for (const playerId of allPlayers) {
      let slot = ROSTER_SLOT.BENCH;
      if (starters.has(playerId)) slot = ROSTER_SLOT.STARTER;
      else if (reserve.has(playerId)) slot = ROSTER_SLOT.IR;
      else if (taxi.has(playerId)) slot = ROSTER_SLOT.TAXI;
      slots.push({ leagueId: internalLeagueId, teamId, playerId, slot });
    }
  }
  return slots;
}

/** @returns {import('../model/schema.js').Player} */
export function normalizePlayer(raw) {
  return {
    id: raw.player_id,
    platformIds: { sleeper: raw.player_id },
    fullName: raw.full_name || `${raw.first_name ?? ''} ${raw.last_name ?? ''}`.trim(),
    position: raw.position,
    nflTeam: raw.team ?? null,
    status: raw.status ?? 'Unknown',
    age: raw.age ?? null,
    yearsExp: raw.years_exp ?? null,
  };
}

/**
 * @param {Record<string, any>} rawCatalog
 * @returns {Record<string, import('../model/schema.js').Player>}
 */
export function normalizePlayersCatalog(rawCatalog) {
  /** @type {Record<string, import('../model/schema.js').Player>} */
  const out = {};
  for (const [id, raw] of Object.entries(rawCatalog)) {
    out[id] = normalizePlayer(raw);
  }
  return out;
}

/**
 * Players in the catalog not rostered by any team in this league.
 * Filters to skill positions relevant to fantasy since the catalog includes
 * thousands of inactive/practice-squad/no-position entries.
 *
 * @param {Record<string, import('../model/schema.js').Player>} playersCatalog
 * @param {import('../model/schema.js').RosterSlot[]} rosterSlots
 * @returns {import('../model/schema.js').Player[]}
 */
export function computeWaiverWire(playersCatalog, rosterSlots) {
  const rosteredIds = new Set(rosterSlots.map((s) => s.playerId));
  const relevant = new Set(['QB', 'RB', 'WR', 'TE', 'K', 'DEF']);
  return Object.values(playersCatalog).filter(
    (p) => !rosteredIds.has(p.id) && relevant.has(p.position) && p.nflTeam
  );
}

/**
 * Extracts per-player fantasy points scored in this league's own scoring
 * settings for one week, from the raw /matchups/{week} response. Used as
 * the ground truth history for the custom rolling-average projection model
 * (see src/projections/customModel.js) since Sleeper has no projections API.
 *
 * @param {any[]} rawMatchups
 * @returns {Record<string, number>} playerId -> points scored that week
 */
export function extractPlayerPoints(rawMatchups) {
  /** @type {Record<string, number>} */
  const points = {};
  for (const matchup of rawMatchups) {
    const playersPoints = matchup.players_points ?? {};
    for (const [playerId, pts] of Object.entries(playersPoints)) {
      points[playerId] = pts;
    }
  }
  return points;
}

/**
 * Fetches and normalizes everything needed for one league in one call.
 * @param {string} externalLeagueId
 */
export async function loadLeague(externalLeagueId) {
  const [rawLeague, rawRosters, rawUsers] = await Promise.all([
    fetchLeague(externalLeagueId),
    fetchRosters(externalLeagueId),
    fetchUsers(externalLeagueId),
  ]);
  const league = normalizeLeague(rawLeague);
  const teams = normalizeTeams(rawRosters, rawUsers, league.id);
  const rosterSlots = normalizeRosterSlots(rawRosters, league.id);
  return { league, teams, rosterSlots };
}
