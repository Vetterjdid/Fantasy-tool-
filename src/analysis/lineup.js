/**
 * Optimal starting lineup.
 *
 * A roster's value is the best lineup it can legally field — not the sum of
 * its players, and not whatever is currently flagged `starter`. That flag is
 * stale, may be illegal, and records no lineup position at all, so the
 * assignment is always re-derived here from position eligibility.
 */

const BENCH_SLOTS = new Set(['BN', 'BE', 'IR', 'TAXI']);

/** Which player positions may fill each roster slot. */
export const SLOT_ELIGIBILITY = {
  QB: ['QB'],
  RB: ['RB'],
  WR: ['WR'],
  TE: ['TE'],
  K: ['K'],
  DEF: ['DEF'],
  DST: ['DEF'],
  FLEX: ['RB', 'WR', 'TE'],
  WRRB_FLEX: ['RB', 'WR'],
  WRRB_WRT: ['RB', 'WR', 'TE'],
  REC_FLEX: ['WR', 'TE'],
  SUPER_FLEX: ['QB', 'RB', 'WR', 'TE'],
};

/** Cost for an assignment that is not allowed. Large but finite — an
 * infinite sentinel poisons the algorithm's potentials into NaN. */
const INELIGIBLE = 1e9;

/**
 * Eligibility as bitmasks. The trade search re-solves lineups tens of
 * thousands of times, so this inner test has to be a bit-and rather than an
 * array scan.
 */
/**
 * One bit per position, so eligibility is an integer AND rather than a set
 * walk. Exported because the trade search gates candidate packages with the
 * same masks: a second copy that drifted would let the search accept packages
 * the lineup solver then refuses to start.
 */
export const POSITION_BIT = { QB: 1, RB: 2, WR: 4, TE: 8, K: 16, DEF: 32 };
const SLOT_MASK = {};
for (const slot of Object.keys(SLOT_ELIGIBILITY)) {
  SLOT_MASK[slot] = SLOT_ELIGIBILITY[slot].reduce((mask, p) => mask | (POSITION_BIT[p] || 0), 0);
}
function maskForSlot(slot) {
  const known = SLOT_MASK[slot];
  return known === undefined ? POSITION_BIT[slot] || 0 : known;
}
function bitForPosition(position) {
  return POSITION_BIT[position] || 0;
}

export function isScoringSlot(slot) {
  return !BENCH_SLOTS.has(slot);
}

export function eligiblePositions(slot) {
  return SLOT_ELIGIBILITY[slot] || [slot];
}

export function canFill(slot, position) {
  return eligiblePositions(slot).indexOf(position) !== -1;
}

/** Slots a roster must fill, bench excluded. */
export function scoringSlots(rosterPositions) {
  return (rosterPositions || []).filter(isScoringSlot);
}

/**
 * Deterministic player ordering. Ties in projected value would otherwise let
 * the matching flip between runs, which makes lineup deltas jitter and
 * manufactures trades that are really just rounding noise.
 *
 * Values are read once per player here rather than repeatedly inside a
 * comparator — this runs in the innermost loop of the trade search.
 */
function prepare(players, valueFor) {
  const n = players.length;
  const values = new Array(n);
  const order = new Array(n);
  for (let i = 0; i < n; i++) {
    values[i] = valueFor(players[i]) || 0;
    order[i] = i;
  }
  order.sort((a, b) => {
    const dv = values[b] - values[a];
    if (dv !== 0) return dv;
    const pa = players[a];
    const pb = players[b];
    if (pa.position !== pb.position) return pa.position < pb.position ? -1 : 1;
    return String(pa.id) < String(pb.id) ? -1 : 1;
  });
  const pool = new Array(n);
  const sorted = new Array(n);
  const bits = new Array(n);
  for (let i = 0; i < n; i++) {
    const idx = order[i];
    pool[i] = players[idx];
    sorted[i] = values[idx];
    bits[i] = bitForPosition(players[idx].position);
  }
  return { pool, values: sorted, bits };
}

/** Scratch buffers reused across solves; the solver is synchronous and non-reentrant. */
const scratch = { u: [], v: [], p: [], way: [], minv: [], used: [], rowToCol: [], cost: [] };
function buffer(name, size) {
  const existing = scratch[name];
  if (existing.length < size) scratch[name] = new Array(size);
  return scratch[name];
}

/**
 * Rectangular max-weight assignment via the Jonker-Volgenant shortest
 * augmenting path method (minimises cost; we feed it negated values).
 * Slots become rows, players columns, padded with zero-value dummies so a
 * slot nobody can fill simply comes back empty.
 *
 * O(rows^2 * cols) — at most 10 slots x ~20 players.
 *
 * Writes into shared scratch buffers; the returned rowToCol is only valid
 * until the next call.
 */
function solveAssignment(values, bits, slots) {
  const nRows = slots.length;
  const nPlayers = values.length;
  const nCols = Math.max(nPlayers, nRows);
  const cost = buffer('cost', nRows * nCols);

  for (let i = 0; i < nRows; i++) {
    const mask = maskForSlot(slots[i]);
    const base = i * nCols;
    for (let j = 0; j < nCols; j++) {
      if (j >= nPlayers) cost[base + j] = 0;
      else cost[base + j] = mask & bits[j] ? -values[j] : INELIGIBLE;
    }
  }

  const u = buffer('u', nRows + 1);
  const v = buffer('v', nCols + 1);
  const p = buffer('p', nCols + 1);
  const way = buffer('way', nCols + 1);
  const minv = buffer('minv', nCols + 1);
  const used = buffer('used', nCols + 1);

  for (let i = 0; i <= nRows; i++) u[i] = 0;
  for (let j = 0; j <= nCols; j++) {
    v[j] = 0;
    p[j] = 0;
    way[j] = 0;
  }

  for (let i = 1; i <= nRows; i++) {
    p[0] = i;
    let j0 = 0;
    for (let j = 0; j <= nCols; j++) {
      minv[j] = Infinity;
      used[j] = false;
    }
    do {
      used[j0] = true;
      const i0 = p[j0];
      const rowBase = (i0 - 1) * nCols;
      const ui = u[i0];
      let delta = Infinity;
      let j1 = 0;
      for (let j = 1; j <= nCols; j++) {
        if (used[j]) continue;
        const cur = cost[rowBase + j - 1] - ui - v[j];
        if (cur < minv[j]) {
          minv[j] = cur;
          way[j] = j0;
        }
        if (minv[j] < delta) {
          delta = minv[j];
          j1 = j;
        }
      }
      for (let j = 0; j <= nCols; j++) {
        if (used[j]) {
          u[p[j]] += delta;
          v[j] -= delta;
        } else {
          minv[j] -= delta;
        }
      }
      j0 = j1;
    } while (p[j0] !== 0);
    do {
      const j1 = way[j0];
      p[j0] = p[j1];
      j0 = j1;
    } while (j0);
  }

  const rowToCol = buffer('rowToCol', nRows);
  for (let i = 0; i < nRows; i++) rowToCol[i] = -1;
  for (let j = 1; j <= nCols; j++) {
    if (p[j] > 0 && p[j] <= nRows) rowToCol[p[j] - 1] = j - 1;
  }
  return rowToCol;
}

/**
 * @param {Array<{id: string, position: string}>} players  available players (exclude IR/taxi)
 * @param {string[]} rosterPositions  league slot template, e.g. ['QB','RB','RB','WR','WR','TE','FLEX','K','DEF','BN']
 * @param {(player) => number} valueFor
 * @returns {{total: number, assignments: Array, unfilled: Array, benched: string[]}}
 */
export function optimalLineup(players, rosterPositions, valueFor) {
  const slots = scoringSlots(rosterPositions);
  const { pool, values, bits } = prepare(players || [], valueFor);

  if (slots.length === 0) {
    return { total: 0, assignments: [], unfilled: [], benched: pool.map((p) => p.id) };
  }

  const rowToCol = solveAssignment(values, bits, slots);

  const assignments = [];
  const unfilled = [];
  const taken = new Set();
  let total = 0;

  for (let i = 0; i < slots.length; i++) {
    const col = rowToCol[i];
    const player = col >= 0 && col < pool.length ? pool[col] : null;
    if (!player || !(maskForSlot(slots[i]) & bits[col])) {
      unfilled.push({ slot: slots[i], slotIndex: i });
      continue;
    }
    total += values[col];
    taken.add(player.id);
    assignments.push({
      slot: slots[i],
      slotIndex: i,
      playerId: player.id,
      position: player.position,
      value: values[col],
    });
  }

  return {
    total,
    assignments,
    unfilled,
    benched: pool.filter((p) => !taken.has(p.id)).map((p) => p.id),
  };
}

/**
 * Just the number. The trade search calls this tens of thousands of times, so
 * it skips building the assignment objects entirely.
 */
export function lineupTotal(players, rosterPositions, valueFor) {
  const slots = scoringSlots(rosterPositions);
  if (slots.length === 0) return 0;
  const { values, bits } = prepare(players || [], valueFor);
  const rowToCol = solveAssignment(values, bits, slots);
  let total = 0;
  for (let i = 0; i < slots.length; i++) {
    const col = rowToCol[i];
    if (col >= 0 && col < values.length && maskForSlot(slots[i]) & bits[col]) total += values[col];
  }
  return total;
}

/**
 * Fill each slot in order with the best remaining eligible player.
 *
 * Exported only as a test oracle: this is optimal when eligibility sets are
 * nested (QB inside SUPER_FLEX) but wrong in general — a FLEX listed before
 * a dedicated TE will eat the only tight end and strand the TE slot.
 */
export function greedyLineup(players, rosterPositions, valueFor) {
  const slots = scoringSlots(rosterPositions);
  const { pool, values } = prepare(players || [], valueFor);
  const used = new Set();
  let total = 0;
  for (const slot of slots) {
    for (let i = 0; i < pool.length; i++) {
      if (used.has(pool[i].id) || !canFill(slot, pool[i].position)) continue;
      used.add(pool[i].id);
      total += values[i];
      break;
    }
  }
  return total;
}
