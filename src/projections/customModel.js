/**
 * No-dependency fallback projection model, used until a real projections
 * source (FantasyPros API key, or nflverse) is wired in.
 *
 * Approach: a recency-weighted rolling average of each player's own
 * league-scored fantasy points over their last N played weeks, with a small
 * opponent-strength adjustment when schedule/defense data is supplied.
 * Deliberately simple and transparent rather than a black box — every
 * number it produces traces back to actual points the player scored in
 * this league this season.
 */

const DEFAULT_WINDOW = 4;

/**
 * @param {Record<string, Record<number, number>>} weeklyPointsByPlayer
 *   playerId -> { week: points }, only weeks the player actually played.
 * @param {string} playerId
 * @param {number} upToWeek        exclusive — only weeks before this count
 * @param {number} windowSize
 * @returns {{ average: number, gamesPlayed: number } | null}
 */
export function rollingAverage(weeklyPointsByPlayer, playerId, upToWeek, windowSize = DEFAULT_WINDOW) {
  const history = weeklyPointsByPlayer[playerId];
  if (!history) return null;

  const weeksPlayed = Object.keys(history)
    .map(Number)
    .filter((w) => w < upToWeek)
    .sort((a, b) => b - a)
    .slice(0, windowSize);

  if (weeksPlayed.length === 0) return null;

  // Most recent week gets the highest weight; weights are just position in
  // the window (windowSize, windowSize-1, ..., 1) normalized.
  let weightedSum = 0;
  let weightTotal = 0;
  weeksPlayed.forEach((week, i) => {
    const weight = weeksPlayed.length - i;
    weightedSum += history[week] * weight;
    weightTotal += weight;
  });

  return { average: weightedSum / weightTotal, gamesPlayed: weeksPlayed.length };
}

/**
 * Adjustment multiplier for facing a stronger/weaker-than-average defense
 * at the player's position. `opponentPositionStrength` is a plain number
 * where 1.0 = league-average points allowed to that position; below 1.0
 * means a tougher-than-average matchup, above 1.0 an easier one. Clamped
 * to +/-15% so one thin data point can't swing a projection wildly.
 *
 * @param {number|null|undefined} opponentPositionStrength
 */
export function opponentAdjustment(opponentPositionStrength) {
  if (opponentPositionStrength == null || Number.isNaN(opponentPositionStrength)) return 1;
  const clamped = Math.min(1.15, Math.max(0.85, opponentPositionStrength));
  return clamped;
}

/**
 * @param {Object} params
 * @param {import('../model/schema.js').Player[]} params.players
 * @param {Record<string, Record<number, number>>} params.weeklyPointsByPlayer
 * @param {string} params.leagueId
 * @param {string} params.season
 * @param {number} params.week                     week to project
 * @param {number} [params.windowSize]
 * @param {(nflTeam: string, week: number) => { opponent: string|null, bye: boolean }} [params.scheduleLookup]
 * @param {(position: string, opponent: string) => number|null} [params.defenseStrengthLookup]
 * @returns {import('../model/schema.js').Projection[]}
 */
export function computeProjections({
  players,
  weeklyPointsByPlayer,
  leagueId,
  season,
  week,
  windowSize = DEFAULT_WINDOW,
  scheduleLookup,
  defenseStrengthLookup,
}) {
  /** @type {import('../model/schema.js').Projection[]} */
  const projections = [];

  for (const player of players) {
    const roll = rollingAverage(weeklyPointsByPlayer, player.id, week, windowSize);
    const base = roll?.average ?? 0;

    let opponent = null;
    let bye = false;
    if (scheduleLookup && player.nflTeam) {
      const scheduled = scheduleLookup(player.nflTeam, week);
      opponent = scheduled.opponent;
      bye = scheduled.bye;
    }

    let projectedPoints = bye ? 0 : base;
    if (!bye && opponent && defenseStrengthLookup) {
      const strength = defenseStrengthLookup(player.position, opponent);
      projectedPoints = base * opponentAdjustment(strength);
    }

    projections.push({
      playerId: player.id,
      leagueId,
      season,
      week,
      projectedPoints: Math.round(projectedPoints * 10) / 10,
      opponent,
      bye,
      source: 'custom',
    });
  }

  return projections;
}
