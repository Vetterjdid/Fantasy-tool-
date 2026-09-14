/**
 * The waiver wire: who is free, and whether any of them is worth a roster spot.
 *
 * This is the same thesis as the trade engine, with one side of the deal
 * replaced by the free-agent pool. A pickup is worth making exactly when the
 * player you add contributes more to your best lineup than the player you drop
 * was contributing — both measured against YOUR roster, not in the abstract.
 *
 * Rosters here are full, so every add is an add-and-drop. There is no such
 * thing as a free pickup once you have fourteen players and fourteen slots.
 */

import { optimalLineup, lineupTotal } from './lineup.js';
import { marginalOut } from './value.js';

/**
 * Positions the recommender will not act on.
 *
 * The baseline projection gives every kicker the same number and every defense
 * the same number, because prior-season fantasy lines do not exist for them in
 * nflverse. Ranking them against each other would be ranking noise, so they are
 * browsable but never recommended. This is a limitation of the projection, not
 * a claim that streaming defenses is a bad idea.
 */
export const UNRANKABLE = ['K', 'DEF'];

/**
 * Free agents worth looking at, best first, with what each would actually add
 * to this roster.
 *
 * `mvIn` is the honest number and it is frequently zero: a free agent who does
 * not crack your lineup adds nothing, however much better than replacement he
 * looks on paper.
 */
export function waiverBoard(context, teamId, { perPosition = 12 } = {}) {
  const { league, rosters, available, valueFor, rosFor, vor, quality, byeWeekFor } = context;
  const roster = rosters.get(teamId);
  const active = roster ? roster.active : [];
  const before = optimalLineup(active, league.rosterPositions, valueFor);
  const startingNow = new Set(before.assignments.map((a) => a.playerId));

  const byPosition = new Map();
  for (const player of available) {
    const ros = rosFor(player);
    if (typeof ros !== 'number') continue;      // no projection: not rankable
    if (!byPosition.has(player.position)) byPosition.set(player.position, []);
    byPosition.get(player.position).push(player);
  }

  const board = [];
  for (const [position, players] of byPosition) {
    players.sort((a, b) => (rosFor(b) || 0) - (rosFor(a) || 0));
    for (const player of players.slice(0, perPosition)) {
      const after = lineupTotal(active.concat([player]), league.rosterPositions, valueFor);
      board.push({
        playerId: player.id,
        name: player.fullName,
        position,
        nflTeam: player.nflTeam || null,
        status: player.status || 'Active',
        ros: round1(rosFor(player) || 0),
        vor: round1(vor(player) || 0),
        quality: quality(player),
        byeWeek: byeWeekFor ? byeWeekFor(player) : null,
        // What he adds before considering who leaves to make room.
        mvIn: round1(Math.max(0, after - before.total)),
        wouldStart: after - before.total > 0.01,
      });
    }
  }
  board.sort((a, b) => b.mvIn - a.mvIn || b.ros - a.ros);
  return { board, startingNow };
}

/**
 * Ranked add-and-drop pairs: swap one rostered player for one free agent so
 * that the best legal lineup improves.
 *
 * RESERVE PLAYERS ARE NEVER DROP CANDIDATES, and the reason matters. A player
 * on injured reserve carries an availability factor of zero, so his
 * rest-of-season value is zero, so dropping him appears to cost nothing — and a
 * recommender that trusted that arithmetic would tell you to cut your injured
 * best player every single week. The value of an IR stash is precisely that he
 * comes back, which this horizon does not model. Excluding them is the honest
 * response to a gap in the model, not an oversight.
 *
 * @returns {{moves: Array, scanned: number, droppable: number, candidates: number}}
 */
export function waiverMoves(context, teamId, {
  limit = 12,
  minGain = 2,
  candidatesPerPosition = 12,
  maxDrops = 12,
} = {}) {
  const { league, rosters, playersById, valueFor, rosFor, vor, quality } = context;
  const roster = rosters.get(teamId);
  if (!roster) return { moves: [], scanned: 0, droppable: 0, candidates: 0 };

  const active = roster.active;
  const slots = league.rosterPositions;
  const before = optimalLineup(active, slots, valueFor);
  const startingNow = new Set(before.assignments.map((a) => a.playerId));

  // Drop candidates: cheapest first, since the whole point is to give up little.
  const droppable = active
    .filter((p) => !UNRANKABLE.includes(p.position))
    .map((player) => ({
      player,
      cost: marginalOut(active, player.id, slots, valueFor),
    }))
    .sort((a, b) => a.cost - b.cost)
    .slice(0, maxDrops);

  const { board } = waiverBoard(context, teamId, { perPosition: candidatesPerPosition });
  const candidates = board
    .filter((entry) => !UNRANKABLE.includes(entry.position))
    .map((entry) => playersById[entry.playerId])
    .filter(Boolean);

  const best = new Map();   // one recommendation per added player: his best drop
  let scanned = 0;

  for (const addition of candidates) {
    for (const { player: departing, cost } of droppable) {
      scanned++;
      const next = active.filter((p) => p.id !== departing.id).concat([addition]);
      const gain = lineupTotal(next, slots, valueFor) - before.total;
      if (gain <= minGain) continue;
      const existing = best.get(addition.id);
      if (!existing || gain > existing.gain) {
        best.set(addition.id, { addition, departing, cost, gain });
      }
    }
  }

  const moves = [...best.values()]
    .sort((a, b) => b.gain - a.gain)
    .slice(0, limit)
    .map(({ addition, departing, cost, gain }) => {
      const next = active.filter((p) => p.id !== departing.id).concat([addition]);
      const after = optimalLineup(next, slots, valueFor);
      return {
        id: teamId + ':+' + addition.id + '-' + departing.id,
        gain: round1(gain),
        add: describe(addition, { rosFor, vor, quality, startsAfter: after, startedBefore: startingNow }),
        drop: {
          ...describe(departing, { rosFor, vor, quality, startsAfter: after, startedBefore: startingNow }),
          marginalCost: round1(cost),
        },
        lineupChanges: diff(before, after, playersById),
      };
    });

  return { moves, scanned, droppable: droppable.length, candidates: candidates.length };
}

function describe(player, { rosFor, vor, quality, startsAfter, startedBefore }) {
  return {
    playerId: player.id,
    name: player.fullName,
    position: player.position,
    nflTeam: player.nflTeam || null,
    status: player.status || 'Active',
    ros: round1(rosFor(player) || 0),
    vor: round1(vor(player) || 0),
    quality: quality(player),
    startedBefore: startedBefore.has(player.id),
    startsAfter: startsAfter.assignments.some((a) => a.playerId === player.id),
  };
}

/** Slot-by-slot difference, so a reported gain can be checked against its parts. */
function diff(before, after, playersById) {
  const from = new Map(before.assignments.map((a) => [a.slotIndex, a]));
  const to = new Map(after.assignments.map((a) => [a.slotIndex, a]));
  const changes = [];
  for (const slotIndex of new Set([...from.keys(), ...to.keys()])) {
    const was = from.get(slotIndex) || null;
    const now = to.get(slotIndex) || null;
    if (was && now && was.playerId === now.playerId) continue;
    changes.push({
      slot: (now || was).slot,
      slotIndex,
      from: was ? (playersById[was.playerId] || {}).fullName || was.playerId : null,
      to: now ? (playersById[now.playerId] || {}).fullName || now.playerId : null,
      delta: round1((now ? now.value : 0) - (was ? was.value : 0)),
    });
  }
  return changes.sort((a, b) => a.slotIndex - b.slotIndex);
}

/**
 * Waiver order, as Sleeper reports it right now.
 *
 * The order itself is authoritative. How it CHANGES after a claim is not
 * something this can state: Sleeper's `waiver_type` enum is undocumented in
 * their public API, and these leagues do not all use the same value, so the
 * raw setting is passed through for the caller to label honestly.
 */
export function waiverOrder(teams) {
  const ranked = teams
    .filter((t) => typeof t.waiverPosition === 'number')
    .sort((a, b) => a.waiverPosition - b.waiverPosition);
  return {
    order: ranked,
    // Every roster must report a position for the list to mean anything.
    complete: ranked.length === teams.length && ranked.length > 0,
    budgetInUse: teams.some((t) => (t.waiverBudgetUsed || 0) > 0),
  };
}

function round1(n) {
  return Math.round(n * 10) / 10;
}
