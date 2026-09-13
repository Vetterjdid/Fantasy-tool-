/**
 * Structured reasons a trade makes sense.
 *
 * This layer returns FACTS, never sentences — the render layer templates the
 * prose. Keeping strings out of the analysis code is what lets every number
 * in a suggestion be traced back to the data that produced it.
 */

function uniquePositions(players) {
  return [...new Set(players.map((p) => p.position))];
}

/** Slot-by-slot diff between two solved lineups, keyed on slot index. */
export function lineupChanges(before, after) {
  const beforeBySlot = new Map(before.assignments.map((a) => [a.slotIndex, a]));
  const afterBySlot = new Map(after.assignments.map((a) => [a.slotIndex, a]));
  const slotIndexes = new Set([...beforeBySlot.keys(), ...afterBySlot.keys()]);
  const changes = [];

  for (const slotIndex of [...slotIndexes].sort((a, b) => a - b)) {
    const from = beforeBySlot.get(slotIndex) || null;
    const to = afterBySlot.get(slotIndex) || null;
    if (from && to && from.playerId === to.playerId) continue;
    changes.push({
      slot: (to || from).slot,
      slotIndex,
      fromPlayerId: from ? from.playerId : null,
      toPlayerId: to ? to.playerId : null,
      delta: (to ? to.value : 0) - (from ? from.value : 0),
    });
  }
  return changes;
}

/**
 * @returns {Array<{kind: string}>} typed facts; the renderer decides wording.
 */
export function buildRationale({ myProfile, theirProfile, send, receive, levels, rosFor }) {
  const facts = [];

  for (const position of uniquePositions(send)) {
    const mine = myProfile.byPosition[position];
    if (mine && mine.surplus > 0) {
      facts.push({
        kind: 'surplus',
        position,
        startableCount: mine.starterCount + mine.surplusPlayers.length,
        slotsRequired: Math.round(mine.slotsRequired * 100) / 100,
        surplusValue: Math.round(mine.surplus * 10) / 10,
      });
    }
    const theirs = theirProfile.byPosition[position];
    if (theirs && (theirs.z < 0 || theirs.shortfall > 0)) {
      facts.push({
        kind: 'theirNeed',
        position,
        theirStarterStrength: Math.round(theirs.starterStrength * 10) / 10,
        replacementLevel: Math.round((levels[position] || 0) * 10) / 10,
        theirZ: Math.round((theirs.z || 0) * 100) / 100,
        shortfall: theirs.shortfall,
      });
    }
  }

  for (const position of uniquePositions(receive)) {
    const mine = myProfile.byPosition[position];
    if (mine && (mine.z < 0 || mine.shortfall > 0 || mine.exposure > 0)) {
      facts.push({
        kind: 'myNeed',
        position,
        myZ: Math.round((mine.z || 0) * 100) / 100,
        exposure: Math.round(mine.exposure * 10) / 10,
        shortfall: mine.shortfall,
      });
    }
    const theirs = theirProfile.byPosition[position];
    if (theirs && theirs.surplusPlayers.length > 0) {
      facts.push({
        kind: 'theirSurplus',
        position,
        surplusCount: theirs.surplusPlayers.length,
        surplusValue: Math.round(theirs.surplus * 10) / 10,
      });
    }
  }

  return facts;
}
