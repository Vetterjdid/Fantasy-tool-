/**
 * Turning a one-week projection into something you can trade on.
 *
 * Two distinct notions of value live here, and conflating them is the classic
 * way to build a trade tool nobody trusts:
 *
 *   VOR      — value over replacement. Scarcity-aware but team-independent.
 *              Used for pruning and tie-breaks ONLY.
 *   marginal — what a player actually adds to (or costs) one specific roster's
 *              optimal lineup. Zero for anyone who doesn't crack it.
 *
 * Trades are mutually positive exactly when each side ships a player whose
 * marginal cost at home is far below his marginal value away.
 */

import { optimalLineup, eligiblePositions, isScoringSlot } from './lineup.js';
import { gamesRemaining } from '../projections/schedule.js';

export const DEFAULT_FANTASY_END_WEEK = 17;

/** Weeks of fantasy value left, including the current one. */
export function remainingWeeks(currentWeek, endWeek = DEFAULT_FANTASY_END_WEEK) {
  return Math.max(1, endWeek - (Number(currentWeek) || 1) + 1);
}

/** Fraction of the remaining season we expect this player to be available. */
export function availabilityFactor(status, weeks) {
  if (!status || /^active$/i.test(status)) return 1;
  if (/injured reserve|^ir$/i.test(status)) return 0;
  if (/questionable/i.test(status)) return 0.92;
  if (/doubtful/i.test(status)) return 0.6;
  if (/^out/i.test(status)) return weeks > 0 ? Math.max(0, (weeks - 1) / weeks) : 0;
  return 1;
}

function median(values) {
  if (!values.length) return null;
  const sorted = values.slice().sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/**
 * Rest-of-season value per player.
 *
 * `base` is a per-game rate; the multiplier is GAMES remaining, not weeks. When
 * a projection carries the player's bye week and that bye is still ahead, he is
 * credited with one game fewer — which is the difference between a model that
 * knows a bye costs you a week and one that quietly bills for a game nobody
 * plays. Without a known bye week the multiplier is the full remaining count,
 * the same as before byes were modelled.
 *
 * HONESTY NOTE: the multiplier is near-constant, so it changes little ordering
 * beyond separating players whose byes have passed from those whose have not.
 * The real content here is still bye handling and availability discounting.
 * It does NOT model schedule strength, injury-return timing, usage trend, or
 * playoff matchups.
 *
 * Bye handling is the highest-severity correctness issue in the whole engine.
 * A feed that reports a bye week as zero points makes every star on bye look
 * worthless, and the engine then screams "sell" about exactly the players you
 * should keep — so a zeroed bye is imputed from the nearest-ranked healthy peer
 * at the same position. A feed that reports a real rate ALONGSIDE a bye flag is
 * left alone: it already told the truth, and imputing over it would replace a
 * good number with a neighbour's.
 *
 * @returns {Map<string, {ros: number|null, base: number|null, quality: string,
 *                        availability: number, games: number, byeWeek: number|null}>}
 */
export function restOfSeasonValues(players, {
  projectionFor,
  rankingFor,
  weeks,
  currentWeek = null,
  endWeek = DEFAULT_FANTASY_END_WEEK,
}) {
  const observed = new Map(); // position -> [{rank, base}]
  const bases = new Map();    // position -> [base]

  for (const player of players) {
    const projection = projectionFor(player);
    if (!projection || typeof projection.projectedPoints !== 'number') continue;
    // Only a ZEROED bye is unusable as a peer reference. A real rate reported
    // alongside a bye flag is exactly the kind of number we want to impute from.
    if (projection.bye && projection.projectedPoints === 0) continue;
    const base = projection.projectedPoints;
    if (!bases.has(player.position)) bases.set(player.position, []);
    bases.get(player.position).push(base);
    const ranking = rankingFor ? rankingFor(player) : null;
    if (ranking && typeof ranking.rank === 'number') {
      if (!observed.has(player.position)) observed.set(player.position, []);
      observed.get(player.position).push({ rank: ranking.rank, base });
    }
  }
  for (const list of observed.values()) list.sort((a, b) => a.rank - b.rank);

  function impute(player) {
    const ranking = rankingFor ? rankingFor(player) : null;
    const peers = observed.get(player.position);
    if (ranking && typeof ranking.rank === 'number' && peers && peers.length) {
      let best = peers[0];
      let bestGap = Math.abs(peers[0].rank - ranking.rank);
      for (const peer of peers) {
        const gap = Math.abs(peer.rank - ranking.rank);
        if (gap < bestGap) { bestGap = gap; best = peer; }
      }
      return best.base;
    }
    return median(bases.get(player.position) || []);
  }

  const out = new Map();
  for (const player of players) {
    const projection = projectionFor(player);
    const availability = availabilityFactor(player.status, weeks);
    let base = null;
    let quality = 'missing';

    if (projection && typeof projection.projectedPoints === 'number') {
      if (projection.bye && projection.projectedPoints === 0) {
        // The feed zeroed a bye week. Taken at face value this is the single
        // most destructive error in the engine, so borrow a healthy peer's rate.
        base = impute(player);
        quality = base === null ? 'missing' : 'bye-imputed';
      } else {
        base = projection.projectedPoints;
        quality = 'observed';
      }
    }

    const byeWeek = projection && typeof projection.byeWeek === 'number' ? projection.byeWeek : null;
    const games = currentWeek === null
      ? weeks
      : gamesRemaining({ byeWeek, currentWeek, endWeek, weeks });

    out.set(player.id, {
      base,
      quality,
      availability,
      byeWeek,
      games,
      ros: base === null ? null : base * games * availability,
    });
  }
  return out;
}

/**
 * How many players at each position the league collectively needs to start,
 * apportioning each FLEX slot evenly across the positions it accepts.
 */
export function positionalDemand(league) {
  const slots = (league.rosterPositions || []).filter(isScoringSlot);
  const demand = {};
  for (const slot of slots) {
    const eligible = eligiblePositions(slot);
    const share = 1 / eligible.length;
    for (const position of eligible) {
      demand[position] = (demand[position] || 0) + share;
    }
  }
  const teams = league.totalRosters || 1;
  for (const position of Object.keys(demand)) demand[position] *= teams;
  return demand;
}

/**
 * Replacement level per position — what you could get for free.
 *
 * The waiver pool is ground truth: if free RBs are worth 8, then 8 is what an
 * RB costs you. The demand-rank estimator (the Nth best player leaguewide,
 * where N is how many the league must start) is only a FALLBACK for positions
 * whose waiver pool is empty — common at QB and TE in deep leagues, where the
 * observed estimator has nothing to say.
 *
 * Taking the higher of the two would be a bug: demand-rank routinely names a
 * player who is rostered and therefore not available at any price, which
 * inflates replacement level and erases exactly the surplus that makes trades
 * possible.
 *
 * We take the MEDIAN of the top few free agents rather than the single best.
 * Only one team can claim the best one; everyone else gets the next tier, so
 * the maximum overstates what is realistically available. It is also fragile:
 * one lucky waiver player would otherwise wipe out the tradeable value of
 * every player at that position.
 */
export function replacementLevels({ league, allPlayers, available, rosFor }) {
  const demand = positionalDemand(league);
  const positions = new Set([...Object.keys(demand), ...allPlayers.map((p) => p.position)]);
  const sampleSize = Math.max(3, Math.ceil((league.totalRosters || 1) / 3));
  const levels = {};

  for (const position of positions) {
    const waiver = available
      .filter((p) => p.position === position)
      .map((p) => rosFor(p))
      .filter((v) => typeof v === 'number')
      .sort((a, b) => b - a);

    if (waiver.length) {
      levels[position] = median(waiver.slice(0, sampleSize));
      continue;
    }

    const need = Math.max(1, Math.round(demand[position] || 0));
    const pool = allPlayers
      .filter((p) => p.position === position)
      .map((p) => rosFor(p))
      .filter((v) => typeof v === 'number')
      .sort((a, b) => b - a);
    levels[position] = pool.length ? pool[Math.min(need, pool.length) - 1] : 0;
  }
  return levels;
}

/** Value over replacement — abstract, team-independent. Pruning and tie-breaks only. */
export function valueOverReplacement(player, rosFor, levels) {
  const ros = rosFor(player);
  if (typeof ros !== 'number') return null;
  return ros - (levels[player.position] || 0);
}

/** What losing this player costs the roster, net of whoever replaces him. */
export function marginalOut(activePlayers, playerId, rosterPositions, valueFor) {
  const before = optimalLineup(activePlayers, rosterPositions, valueFor).total;
  const after = optimalLineup(
    activePlayers.filter((p) => p.id !== playerId),
    rosterPositions,
    valueFor
  ).total;
  return before - after;
}

/** What gaining this player adds to the roster's best lineup. */
export function marginalIn(activePlayers, player, rosterPositions, valueFor) {
  const before = optimalLineup(activePlayers, rosterPositions, valueFor).total;
  const after = optimalLineup(activePlayers.concat([player]), rosterPositions, valueFor).total;
  return after - before;
}
