/**
 * Bye weeks, derived from the real schedule rather than hardcoded.
 *
 * WHY THIS MATTERS MORE THAN IT LOOKS: without it, rest-of-season value is
 * `rate × weeks remaining`, which quietly credits every player with a game he
 * will not play. Worse, most projection feeds report a bye week as zero points,
 * and a zero read literally makes a star look worthless — the engine then
 * recommends selling and dropping exactly the players you should keep. The bye
 * is the single most damaging thing a fantasy model can get wrong, and it goes
 * from harmless to harmful on a fixed date: byes begin in week 5.
 *
 * A team's bye is not a column in the schedule. It is the absence of a row —
 * the week in which the team appears in no game at all.
 */

/**
 * @param {Array<{season: string, game_type: string, week: string, home_team: string, away_team: string}>} games
 *        nflverse `games.csv` rows
 * @param {string|number} season
 * @returns {{byeWeeks: Record<string, number>, weeks: number[], anomalies: Array}}
 */
export function byeWeeksFromGames(games, season) {
  const wanted = String(season);
  const playing = new Map();    // team -> Set(week)
  const weeks = new Set();

  for (const game of games) {
    // Regular season only: preseason and playoffs would both corrupt the
    // "absent means bye" inference, in opposite directions.
    if (String(game.season) !== wanted || game.game_type !== 'REG') continue;
    const week = Number(game.week);
    if (!Number.isFinite(week)) continue;
    weeks.add(week);
    for (const team of [game.home_team, game.away_team]) {
      if (!team) continue;
      if (!playing.has(team)) playing.set(team, new Set());
      playing.get(team).add(week);
    }
  }

  const allWeeks = [...weeks].sort((a, b) => a - b);
  const byeWeeks = {};
  const anomalies = [];

  for (const [team, played] of playing) {
    const off = allWeeks.filter((week) => !played.has(week));
    if (off.length === 1) {
      byeWeeks[team] = off[0];
    } else {
      // Two byes, or none, means the schedule is partial or the format changed.
      // Recording no bye is the safe failure: the player is credited with every
      // remaining week, which is the behaviour from before this existed.
      anomalies.push({ team, off });
    }
  }

  return { byeWeeks, weeks: allWeeks, anomalies };
}

/**
 * Games a player still has left, which is not the same as weeks remaining.
 *
 * An unknown bye returns the full count — the honest fallback, and identical
 * to the behaviour before byes were modelled at all.
 */
export function gamesRemaining({ byeWeek, currentWeek, endWeek, weeks }) {
  if (typeof byeWeek !== 'number') return weeks;
  // A bye already played does not reduce what is left.
  const stillAhead = byeWeek >= currentWeek && byeWeek <= endWeek;
  return stillAhead ? Math.max(0, weeks - 1) : weeks;
}
