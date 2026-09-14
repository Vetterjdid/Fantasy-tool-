/**
 * Week-1 baseline projections from prior-season production.
 *
 * WHY THIS EXISTS: src/projections/customModel.js averages a league's own
 * weekly scoring, which is the right model once a season is underway and
 * useless in week 1, when no weeks have been played. A new season needs a
 * prior, and the honest one is what these players actually did last year.
 *
 * WHAT THIS IS NOT: a forecast. Prior-season production knows nothing about
 * team changes, depth-chart moves, camp injuries, age curves, or rookies. It
 * is a starting point that should be superseded by observed scoring as weeks
 * accumulate. Treat a large gap between this and reality as expected, not as
 * a bug.
 *
 * Rookies have no prior season by definition. They come back with no
 * projection at all rather than a zero — `restOfSeasonValues` tags those
 * `missing`, and a missing projection must never be read as "worth nothing".
 */

/**
 * Sleeper and nflverse share no reliable key.
 *
 * Sleeper's catalog carries `gsis_id` — nflverse's primary key — but only for
 * about a third of entries, and it is absent for many current starters, so a
 * gsis-only join covers ~20% of a real roster. Joining through nflverse's own
 * player table on a normalized name lifts that to ~87%, where the remainder is
 * almost entirely rookies who correctly have no prior-season line.
 *
 * The normalization has to survive three things seen in the live data:
 * accented characters, generational suffixes, and punctuation.
 */
export function normalizeName(name) {
  return String(name || '')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')      // strip combining accents
    .toLowerCase()
    .replace(/\b(jr|sr|ii|iii|iv|v)\b/g, '')
    .replace(/[^a-z]/g, '');
}

/**
 * Sleeper stores some gsis ids with a leading space (' 00-0034975'). Untrimmed,
 * those joins fail silently — the id is truthy, just never matches.
 */
export function cleanGsisId(value) {
  const trimmed = String(value || '').trim();
  return trimmed || null;
}

/**
 * Build `sleeperPlayerId -> gsisId` for a Sleeper catalog.
 *
 * @param {Record<string, any>} sleeperCatalog  raw /players/nfl response
 * @param {Array<{gsis_id: string, display_name: string, position: string}>} nflversePlayers
 */
export function buildIdBridge(sleeperCatalog, nflversePlayers) {
  const byName = new Map();
  for (const row of nflversePlayers) {
    const gsis = cleanGsisId(row.gsis_id);
    if (!gsis) continue;
    const key = `${normalizeName(row.display_name)}|${String(row.position || '').trim()}`;
    // First writer wins: the table is ordered with established players first,
    // so a later practice-squad namesake cannot displace a starter.
    if (!byName.has(key)) byName.set(key, gsis);
  }

  const bridge = new Map();
  let direct = 0;
  let viaName = 0;
  for (const [playerId, player] of Object.entries(sleeperCatalog)) {
    if (!player) continue;
    const own = cleanGsisId(player.gsis_id);
    if (own) {
      bridge.set(playerId, own);
      direct++;
      continue;
    }
    const key = `${normalizeName(player.full_name || `${player.first_name || ''} ${player.last_name || ''}`)}|${player.position || ''}`;
    const matched = byName.get(key);
    if (matched) {
      bridge.set(playerId, matched);
      viaName++;
    }
  }
  return { bridge, stats: { direct, viaName, total: bridge.size } };
}

/**
 * Per-game fantasy points in a league's scoring, from a season stat line.
 *
 * nflverse publishes both `fantasy_points` (standard) and `fantasy_points_ppr`.
 * Half-PPR is interpolated rather than guessed at: the difference between the
 * two columns is exactly the reception points, so half of it is half-PPR.
 */
export function perGamePoints(statLine, scoringType) {
  const games = Number(statLine.games) || 0;
  if (games <= 0) return null;
  const standard = Number(statLine.fantasy_points) || 0;
  const ppr = Number(statLine.fantasy_points_ppr) || 0;
  let total;
  if (scoringType === 'ppr') total = ppr;
  else if (scoringType === 'half_ppr') total = standard + (ppr - standard) / 2;
  else total = standard;
  return total / games;
}

/**
 * Kickers and team defenses have no nflverse fantasy line, but a lineup that
 * cannot fill K and DEF misreports every team's total. They get a flat
 * positional placeholder — enough to fill the slot, never enough to look like
 * a trade asset (the engine already refuses to trade them).
 */
export const FLAT_BASELINE = { K: 8, DEF: 7 };

/**
 * @param {object} input
 * @param {Record<string, any>} input.sleeperCatalog
 * @param {Array} input.nflversePlayers      rows of nflverse players.csv
 * @param {Array} input.nflverseStats        rows of nflverse stats_player_reg_<year>.csv
 * @param {string[]} input.playerIds         Sleeper ids to project
 * @param {string} input.leagueId
 * @param {string} input.season
 * @param {number} input.week
 * @param {string} input.scoringType
 * @returns {{projections: Array, coverage: object}}
 */
export function baselineProjections({
  sleeperCatalog,
  nflversePlayers,
  nflverseStats,
  playerIds,
  leagueId,
  season,
  week,
  scoringType,
  byeWeeks = {},
}) {
  const { bridge } = buildIdBridge(sleeperCatalog, nflversePlayers);
  const statsByGsis = new Map();
  for (const row of nflverseStats) {
    const gsis = cleanGsisId(row.player_id);
    if (gsis) statsByGsis.set(gsis, row);
  }

  const projections = [];
  const coverage = { observed: 0, flat: 0, missing: 0, missingPlayers: [] };

  for (const playerId of playerIds) {
    const player = sleeperCatalog[playerId];
    if (!player) continue;
    const position = player.position;

    const byeWeek = typeof byeWeeks[player.team] === 'number' ? byeWeeks[player.team] : null;

    if (FLAT_BASELINE[position] !== undefined) {
      projections.push(makeRow(playerId, leagueId, season, week, FLAT_BASELINE[position], 'baseline-flat', byeWeek));
      coverage.flat++;
      continue;
    }

    const statLine = statsByGsis.get(bridge.get(playerId));
    const points = statLine ? perGamePoints(statLine, scoringType) : null;
    if (points === null) {
      // No row at all: a rookie, or someone who did not play last season.
      // Emitting nothing is deliberate — a zero would read as "worthless".
      coverage.missing++;
      coverage.missingPlayers.push({ id: playerId, name: player.full_name, position });
      continue;
    }
    projections.push(makeRow(playerId, leagueId, season, week, round1(points), 'baseline-2025', byeWeek));
    coverage.observed++;
  }

  return { projections, coverage };
}

function round1(n) {
  return Math.round(n * 10) / 10;
}

function makeRow(playerId, leagueId, season, week, projectedPoints, source, byeWeek = null) {
  return {
    playerId,
    leagueId,
    season,
    week,
    // Always the per-game RATE, never zeroed for a bye. Zeroing is what makes a
    // star on bye read as worthless; the bye is expressed as one game fewer in
    // the rest-of-season multiplier instead, which is what it actually costs.
    projectedPoints,
    byeWeek,
    // Whether THIS week is the player's bye. Informational only — the value
    // layer reads `byeWeek`, and only imputes over a bye that was zeroed.
    bye: byeWeek !== null && byeWeek === Number(week),
    opponent: null,
    source,
  };
}
