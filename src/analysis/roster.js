/** Pure roster shaping helpers, shared by the analysis layer and the integrations. */

import { POSITIONS, ROSTER_SLOT } from '../model/schema.js';

const RELEVANT = new Set(POSITIONS);

/**
 * A team's players split by whether they can be started this week.
 * IR and taxi players are real assets (tradeable) but must never be handed
 * to the lineup solver, or it will happily start them.
 */
export function rosterFor(rosterSlots, teamId, playersById) {
  const active = [];
  const reserve = [];
  for (const slot of rosterSlots) {
    if (slot.teamId !== teamId) continue;
    const player = playersById[slot.playerId];
    if (!player) continue;
    if (slot.slot === ROSTER_SLOT.IR || slot.slot === ROSTER_SLOT.TAXI) reserve.push(player);
    else active.push(player);
  }
  return { active, reserve, all: active.concat(reserve) };
}

export function rosteredPlayerIds(rosterSlots) {
  return new Set((rosterSlots || []).map((s) => s.playerId));
}

/**
 * Skill-position players nobody in this league has rostered — the pool that
 * sets replacement level, and the reason a "valuable" bench player may be
 * worth nothing in a trade.
 */
export function availablePlayers(playersById, rosterSlots) {
  const taken = rosteredPlayerIds(rosterSlots);
  return Object.keys(playersById)
    .map((id) => playersById[id])
    .filter((p) => p && !taken.has(p.id) && p.nflTeam && RELEVANT.has(p.position));
}
