/**
 * What a roster is actually made of: where it is strong, where it is thin,
 * and which players are surplus — startable assets beyond what the lineup can
 * use, which is exactly what you trade away.
 */

import { optimalLineup, eligiblePositions, isScoringSlot } from './lineup.js';
import { marginalOut, availabilityFactor } from './value.js';

/** Slots one team must fill at each position, FLEX shared across eligibles. */
export function slotsRequired(league) {
  const out = {};
  for (const slot of (league.rosterPositions || []).filter(isScoringSlot)) {
    const eligible = eligiblePositions(slot);
    for (const position of eligible) {
      out[position] = (out[position] || 0) + 1 / eligible.length;
    }
  }
  return out;
}

/**
 * Lineup slots this team genuinely cannot fill, attributed to every position
 * that could have filled them.
 *
 * This replaces an earlier definition that compared starters against
 * `slotsRequired`, which is fractional because a FLEX slot is shared across
 * the positions it accepts. In a QB/RB/RB/WR/WR/TE/FLEX league, RB demand is
 * 2.33, so a team starting exactly two running backs always measured as 0.33
 * "short" — and the team whose FLEX went to a receiver measured short at RB
 * while its neighbour measured short at WR. Live data made this obvious:
 * every one of twelve teams was short at two of three flex positions, so the
 * weakness ranking was being driven by which position happened to win the
 * FLEX rather than by any real hole.
 *
 * A shortfall now means what the words mean: an empty slot.
 */
export function shortfallByPosition(lineup) {
  const out = {};
  for (const { slot } of lineup.unfilled || []) {
    for (const position of eligiblePositions(slot)) {
      out[position] = (out[position] || 0) + 1;
    }
  }
  return out;
}

/**
 * @returns per-position strength, exposure, injury risk and surplus for one team.
 */
export function teamProfile({ team, roster, league, valueFor, rosFor, levels, weeks }) {
  const active = roster.active || [];
  const lineup = optimalLineup(active, league.rosterPositions, valueFor);
  const starting = new Set(lineup.assignments.map((a) => a.playerId));
  const required = slotsRequired(league);
  const shortfalls = shortfallByPosition(lineup);

  const positions = new Set([
    ...Object.keys(required),
    ...roster.all.map((p) => p.position),
  ]);

  const byPosition = {};
  for (const position of positions) {
    const starters = lineup.assignments.filter((a) => a.position === position);
    const starterStrength = starters.reduce((sum, a) => sum + a.value, 0);

    // Structural exposure: what this position loses if its starters disappear,
    // net of the next man up. Health-agnostic — it measures depth, not luck.
    let exposure = 0;
    let risk = 0;
    for (const starter of starters) {
      const player = active.find((p) => p.id === starter.playerId);
      const cost = marginalOut(active, starter.playerId, league.rosterPositions, valueFor);
      exposure += cost;
      risk += cost * (1 - availabilityFactor(player && player.status, weeks));
    }

    // Surplus: startable value sitting outside the lineup. Bench players below
    // replacement level are not assets, so they contribute nothing.
    const bench = roster.all.filter((p) => p.position === position && !starting.has(p.id));
    const surplusPlayers = bench
      .map((p) => ({ player: p, over: (rosFor(p) || 0) - (levels[position] || 0) }))
      .filter((entry) => entry.over > 0)
      .sort((a, b) => b.over - a.over);

    byPosition[position] = {
      position,
      starterStrength,
      starterCount: starters.length,
      slotsRequired: required[position] || 0,
      shortfall: shortfalls[position] || 0,
      exposure,
      risk,
      surplus: surplusPlayers.reduce((sum, e) => sum + e.over, 0),
      surplusPlayers: surplusPlayers.map((e) => e.player),
      depth: roster.all.filter((p) => p.position === position).length,
    };
  }

  return {
    teamId: team.id,
    teamName: team.teamName,
    ownerName: team.ownerName,
    lineup,
    total: lineup.total,
    unfilled: lineup.unfilled,
    byPosition,
  };
}

/**
 * Profiles for every team plus z-scores, so "weak at RB" is comparable to
 * "weak at TE" — raw point totals are not.
 */
export function leagueProfiles({ teams, rosters, league, valueFor, rosFor, levels, weeks }) {
  const profiles = new Map();
  for (const team of teams) {
    profiles.set(
      team.id,
      teamProfile({
        team,
        roster: rosters.get(team.id) || { active: [], reserve: [], all: [] },
        league,
        valueFor,
        rosFor,
        levels,
        weeks,
      })
    );
  }

  const positions = new Set();
  for (const profile of profiles.values()) {
    Object.keys(profile.byPosition).forEach((p) => positions.add(p));
  }

  const stats = {};
  for (const position of positions) {
    const values = [];
    for (const profile of profiles.values()) {
      values.push(profile.byPosition[position] ? profile.byPosition[position].starterStrength : 0);
    }
    const mean = values.reduce((a, b) => a + b, 0) / (values.length || 1);
    const variance = values.reduce((sum, v) => sum + (v - mean) ** 2, 0) / (values.length || 1);
    const sd = Math.sqrt(variance);
    stats[position] = { mean, sd, flat: sd < 1e-9 };
  }

  for (const profile of profiles.values()) {
    for (const position of positions) {
      if (!profile.byPosition[position]) {
        profile.byPosition[position] = {
          position,
          starterStrength: 0,
          starterCount: 0,
          slotsRequired: 0,
          shortfall: 0,
          exposure: 0,
          risk: 0,
          surplus: 0,
          surplusPlayers: [],
          depth: 0,
        };
      }
      const stat = stats[position];
      // A flat league (every team identical) has SD 0; an unguarded divide
      // yields NaN and silently poisons every downstream ranking.
      profile.byPosition[position].z = stat.flat
        ? 0
        : (profile.byPosition[position].starterStrength - stat.mean) / stat.sd;
    }
  }

  return { profiles, stats };
}

/**
 * A team's positions ordered worst-first. Weakness is relative strength plus
 * how exposed the position is if someone goes down.
 */
export function weakSpots(profile, { positions = ['QB', 'RB', 'WR', 'TE'] } = {}) {
  return positions
    .map((position) => profile.byPosition[position])
    .filter(Boolean)
    .map((entry) => ({
      ...entry,
      severity: -(entry.z || 0) + (entry.shortfall > 0 ? 2 : 0),
    }))
    .sort((a, b) => b.severity - a.severity);
}

/** Startable assets beyond need, best first — the natural outgoing side of a trade. */
export function tradeChips(profile, { positions = ['QB', 'RB', 'WR', 'TE'] } = {}) {
  const chips = [];
  for (const position of positions) {
    const entry = profile.byPosition[position];
    if (!entry) continue;
    for (const player of entry.surplusPlayers) chips.push({ player, position, z: entry.z || 0 });
  }
  return chips;
}
