/**
 * Analysis entry point: turn raw league documents into everything the views
 * and the trade engine need, computed once.
 *
 * Pure — no network, no DOM, no storage. Same code runs in Node tests and in
 * the browser bundle.
 */

import { rosterFor, availablePlayers } from './roster.js';
import { declaredLineup } from './lineup.js';
import {
  remainingWeeks,
  restOfSeasonValues,
  replacementLevels,
  valueOverReplacement,
} from './value.js';
import { leagueProfiles } from './profile.js';
import { ROSTER_SLOT } from '../model/schema.js';

export * from './lineup.js';
export * from './value.js';
export * from './profile.js';
export * from './roster.js';
export * from './explain.js';
export * from './waivers.js';
export { findTrades } from './trades.js';

/**
 * @param {object} input
 * @param {object} input.league
 * @param {Array} input.teams              teams in this league
 * @param {Array} input.rosterSlots        roster slots in this league
 * @param {Object} input.playersById       full player catalogue keyed by id
 * @param {Array} input.projections        projection rows for this league
 * @param {Array} [input.rankings]         positional rankings (used for bye imputation)
 * @param {number} input.currentWeek
 * @param {number} [input.endWeek]
 */
export function buildContext({
  league,
  teams,
  rosterSlots,
  playersById,
  projections,
  rankings = [],
  currentWeek,
  endWeek,
}) {
  const weeks = remainingWeeks(currentWeek, endWeek);

  const projectionByPlayer = new Map();
  for (const row of projections || []) {
    if (!row || row.leagueId !== league.id) continue;
    projectionByPlayer.set(row.playerId, row);
  }
  const rankingByPlayer = new Map();
  for (const row of rankings || []) {
    if (row) rankingByPlayer.set(row.playerId, row);
  }

  const allPlayers = Object.keys(playersById).map((id) => playersById[id]).filter(Boolean);
  const values = restOfSeasonValues(allPlayers, {
    projectionFor: (p) => projectionByPlayer.get(p.id),
    rankingFor: (p) => rankingByPlayer.get(p.id),
    weeks,
    currentWeek,
    endWeek,
  });

  const entryFor = (player) => values.get(player.id) || { ros: null, quality: 'missing' };
  const rosFor = (player) => {
    const entry = entryFor(player);
    return typeof entry.ros === 'number' ? entry.ros : null;
  };
  // The lineup solver needs a number; an unknown player is worth nothing to
  // start, which is the honest floor. Trade code filters them out separately.
  const valueFor = (player) => rosFor(player) || 0;
  const quality = (player) => entryFor(player).quality;
  const byeWeekFor = (player) => entryFor(player).byeWeek ?? null;
  const gamesFor = (player) => entryFor(player).games ?? weeks;

  const rosters = new Map();
  const reserveIds = new Set();
  for (const team of teams) {
    const roster = rosterFor(rosterSlots, team.id, playersById);
    rosters.set(team.id, roster);
    roster.reserve.forEach((p) => reserveIds.add(p.id));
  }

  // The lineup each manager actually set. Sleeper's `starters` array is
  // positional, so `lineupSlot` is an index into the league's scoring slots.
  const lineupSlotByTeam = new Map();
  for (const slot of rosterSlots || []) {
    if (typeof slot.lineupSlot !== 'number') continue;
    if (!lineupSlotByTeam.has(slot.teamId)) lineupSlotByTeam.set(slot.teamId, new Map());
    lineupSlotByTeam.get(slot.teamId).set(slot.playerId, slot.lineupSlot);
  }
  // Snapshots taken before lineup order was captured have none of this. Callers
  // check this rather than rendering an empty lineup as though it were real.
  const hasDeclaredLineups = lineupSlotByTeam.size > 0;

  const declaredFor = (teamId) => {
    const roster = rosters.get(teamId);
    if (!roster || !lineupSlotByTeam.has(teamId)) return null;
    const map = lineupSlotByTeam.get(teamId);
    return declaredLineup(
      roster.active,
      league.rosterPositions,
      valueFor,
      (playerId) => (map.has(playerId) ? map.get(playerId) : null)
    );
  };

  const available = availablePlayers(playersById, rosterSlots);
  const levels = replacementLevels({ league, allPlayers, available, rosFor });
  const vor = (player) => valueOverReplacement(player, rosFor, levels) || 0;

  const { profiles, stats } = leagueProfiles({
    teams,
    rosters,
    league,
    valueFor,
    rosFor,
    levels,
    weeks,
  });

  return {
    league,
    teams,
    rosters,
    reserveIds,
    available,
    playersById,
    weeks,
    levels,
    stats,
    profiles,
    valueFor,
    rosFor,
    vor,
    quality,
    byeWeekFor,
    gamesFor,
    declaredFor,
    hasDeclaredLineups,
    projectionFor: (p) => projectionByPlayer.get(p.id),
  };
}

/** Resolve which roster belongs to a Sleeper user id. Identity is per league. */
export function myTeamIn(teams, sleeperUserId) {
  if (!sleeperUserId) return null;
  const match = (teams || []).find((t) => t.ownerId && t.ownerId === sleeperUserId);
  return match ? match.id : null;
}

export { ROSTER_SLOT };
