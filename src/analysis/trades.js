/**
 * Trade search.
 *
 * Every candidate is scored by re-solving BOTH rosters' optimal lineups after
 * the swap. We never compare "trade value" totals — that is the standard way
 * to generate trades nobody accepts, because it ignores that a player's worth
 * depends entirely on the lineup he lands in.
 *
 * Only mutually positive trades are returned. A trade the other manager would
 * refuse is not a suggestion, it is a daydream.
 */

import { optimalLineup, lineupTotal, POSITION_BIT } from './lineup.js';
import { marginalOut, marginalIn } from './value.js';
import { lineupChanges, buildRationale } from './explain.js';

/** Positions where replacement level sits on top of the starter — nobody trades these. */
const UNTRADEABLE = ['K', 'DEF'];

/**
 * Packages, each decorated with the metadata the inner loop needs.
 *
 * Computing position masks, VOR sums and memo keys here rather than per
 * candidate pair matters: there are only ~36 combos per side but ~1300 pairs,
 * so doing it lazily would repeat the same work dozens of times.
 */
function combinations(items, maxSize, required, vor) {
  const out = [];
  const n = items.length;
  for (let size = 1; size <= maxSize; size++) {
    const idx = [];
    (function pick(start) {
      if (idx.length === size) {
        const players = idx.map((i) => items[i]);
        if (!required || players.some((p) => p.id === required)) {
          let mask = 0;
          let vorSum = 0;
          for (const p of players) {
            mask |= POSITION_BIT[p.position] || 0;
            vorSum += Math.max(0, vor(p) || 0);
          }
          out.push({
            players,
            mask,
            vorSum,
            key: players.map((p) => p.id).sort().join('+'),
          });
        }
        return;
      }
      for (let i = start; i < n; i++) {
        idx.push(i);
        pick(i + 1);
        idx.pop();
      }
    })(0);
  }
  return out;
}

function ids(players) {
  return players.map((p) => p.id);
}

/**
 * Post-trade lineup totals, memoised. Packages share sub-rosters heavily, so
 * the cache typically absorbs most of the work in a 2-for-2 search.
 */
function makeSolver(context) {
  const cache = new Map();
  const { league, rosters, reserveIds, valueFor, rosFor } = context;
  const maxRoster = (league.rosterPositions || []).length || Infinity;

  return function solve(teamId, outPlayers, inPlayers, cacheKey) {
    const key =
      cacheKey ||
      teamId + '|' + ids(outPlayers).sort().join('+') + '>' + ids(inPlayers).sort().join('+');
    const hit = cache.get(key);
    if (hit !== undefined) return hit;

    const roster = rosters.get(teamId) || { active: [], reserve: [], all: [] };
    const outSet = new Set(ids(outPlayers));
    let active = roster.active.filter((p) => !outSet.has(p.id));
    const incoming = inPlayers.filter((p) => !reserveIds.has(p.id));
    active = active.concat(incoming);

    // If the trade pushes the roster past its size limit the manager has to
    // cut someone — model it as cutting the least valuable non-starter.
    const totalSize = roster.all.length - outPlayers.length + inPlayers.length;
    let dropped = 0;
    if (totalSize > maxRoster) {
      const excess = totalSize - maxRoster;
      const lineup = optimalLineup(active, league.rosterPositions, valueFor);
      const starting = new Set(lineup.assignments.map((a) => a.playerId));
      const cuttable = active
        .filter((p) => !starting.has(p.id))
        .sort((a, b) => (rosFor(a) || 0) - (rosFor(b) || 0));
      const cut = new Set(ids(cuttable.slice(0, excess)));
      dropped = cut.size;
      active = active.filter((p) => !cut.has(p.id));
    }

    const total = lineupTotal(active, league.rosterPositions, valueFor);
    const result = { total, dropped };
    cache.set(key, result);
    return result;
  };
}

/**
 * @param {object} context  from buildContext()
 * @param {string} myTeamId
 * @param {object} options
 * @returns {{suggestions: Array, scanned: number, evaluated: number, truncated: boolean, elapsedMs: number}}
 */
export function findTrades(context, myTeamId, options = {}) {
  const {
    maxSend = 2,
    maxReceive = 2,
    poolSize = 8,
    limit = 25,
    epsilon = 2,
    minMutuality = 0,
    targetPosition = null,
    shopPlayerId = null,
    partnerTeamIds = null,
    budgetMs = 300,
    now = () => Date.now(),
  } = options;

  const started = now();
  const { league, teams, rosters, reserveIds, profiles, vor, rosFor, valueFor, levels, quality } =
    context;
  const rosterPositions = league.rosterPositions;
  const maxRoster = (rosterPositions || []).length || Infinity;
  const solve = makeSolver(context);

  const myProfile = profiles.get(myTeamId);
  const myRoster = rosters.get(myTeamId);
  if (!myProfile || !myRoster) {
    return { suggestions: [], scanned: 0, evaluated: 0, truncated: false, elapsedMs: 0 };
  }

  const tradeable = (teamId) =>
    (rosters.get(teamId) || { all: [] }).all.filter(
      (p) =>
        UNTRADEABLE.indexOf(p.position) === -1 &&
        quality(p) !== 'missing' &&
        typeof rosFor(p) === 'number'
    );

  // My side: surplus first — high abstract value, low cost to give up.
  const myCost = new Map();
  for (const player of tradeable(myTeamId)) {
    myCost.set(player.id, marginalOut(myRoster.active, player.id, league.rosterPositions, valueFor));
  }
  let myPool = tradeable(myTeamId).sort(
    (a, b) => (vor(b) - myCost.get(b.id)) - (vor(a) - myCost.get(a.id))
  );
  if (shopPlayerId) {
    const shopped = myPool.find((p) => p.id === shopPlayerId);
    if (!shopped) {
      return { suggestions: [], scanned: 0, evaluated: 0, truncated: false, elapsedMs: now() - started };
    }
    myPool = [shopped].concat(myPool.filter((p) => p.id !== shopPlayerId).slice(0, poolSize - 1));
  } else {
    myPool = myPool.slice(0, poolSize);
  }

  const myBefore = solve(myTeamId, [], []).total;
  const partners = teams.filter(
    (t) => t.id !== myTeamId && (!partnerTeamIds || partnerTeamIds.indexOf(t.id) !== -1)
  );

  const scored = [];
  let scanned = 0;
  let evaluated = 0;
  let truncated = false;

  for (const partner of partners) {
    if (now() - started > budgetMs) { truncated = true; break; }

    const theirProfile = profiles.get(partner.id);
    const theirRoster = rosters.get(partner.id);
    if (!theirProfile || !theirRoster) continue;

    const theirCandidates = tradeable(partner.id);
    if (!theirCandidates.length) continue;

    // Their side: ranked by what each would add to MY lineup.
    const theirGainToMe = new Map();
    for (const player of theirCandidates) {
      theirGainToMe.set(
        player.id,
        marginalIn(myRoster.active, player, league.rosterPositions, valueFor)
      );
    }
    let theirPool = theirCandidates
      .filter((p) => !targetPosition || p.position === targetPosition)
      .sort((a, b) => theirGainToMe.get(b.id) - theirGainToMe.get(a.id))
      .slice(0, poolSize);
    if (!theirPool.length) continue;

    const theirBefore = solve(partner.id, [], []).total;
    const sendCombos = combinations(myPool, maxSend, shopPlayerId, vor);
    const receiveCombos = combinations(theirPool, maxReceive, null, vor);

    // Which positions are worth giving up / worth acquiring, as bitmasks, so
    // the complementarity test below is a bit-and rather than a set walk.
    let surplusMask = 0;
    let needMask = 0;
    for (const position of Object.keys(POSITION_BIT)) {
      const entry = myProfile.byPosition[position];
      if (!entry) continue;
      if (entry.surplus > 0) surplusMask |= POSITION_BIT[position];
      if (entry.z < 0.5 || entry.shortfall > 0 || entry.exposure > 0) needMask |= POSITION_BIT[position];
    }
    const targetMask = targetPosition ? POSITION_BIT[targetPosition] || 0 : 0;

    // The partner's roster minus each incoming package does not depend on what
    // I send, so resolve it once per package instead of once per pair.
    const theirActive = theirRoster.active;
    const receiveMeta = receiveCombos.map((rc) => {
      const out = new Set(ids(rc.players));
      return {
        ...rc,
        incoming: rc.players.filter((p) => !reserveIds.has(p.id)),
        theirBase: theirActive.filter((p) => !out.has(p.id)),
      };
    });

    const myActive = myRoster.active;
    const mySize = myRoster.all.length;
    const theirSize = theirRoster.all.length;

    for (const send of sendCombos) {
      // Gate 1a — I must be shipping from a position I actually have spare.
      if (!(send.mask & surplusMask)) { scanned += receiveMeta.length; continue; }

      const sendIds = new Set(ids(send.players));
      const myBase = myActive.filter((p) => !sendIds.has(p.id));
      const sendIncoming = send.players.filter((p) => !reserveIds.has(p.id));

      for (const receive of receiveMeta) {
        scanned++;

        // Gate 1b — and receiving into one I lack; otherwise it just reshuffles.
        if (!(receive.mask & needMask)) continue;
        if (targetMask && !(receive.mask & targetMask)) continue;

        // Gate 2 — a very loose sanity band. VOR is the wrong metric for
        // scoring, so this only discards absurd packages before we pay for
        // the lineup solves.
        const hi = Math.max(send.vorSum, receive.vorSum);
        const lo = Math.min(send.vorSum, receive.vorSum);
        if (hi > 0 && lo < hi / 4) continue;

        evaluated++;

        // Uneven packages can push a roster over its size limit, which means
        // someone has to be cut — rare, and handled by the slower path that
        // models the drop.
        const myAfterSize = mySize - send.players.length + receive.players.length;
        const theirAfterSize = theirSize - receive.players.length + send.players.length;
        const needsDrop = myAfterSize > maxRoster || theirAfterSize > maxRoster;

        let myAfter;
        let theirAfter;
        let requiresDrop = false;
        if (needsDrop) {
          const mine = solve(myTeamId, send.players, receive.players, `${myTeamId}|${send.key}>${receive.key}`);
          const theirs = solve(partner.id, receive.players, send.players, `${partner.id}|${receive.key}>${send.key}`);
          myAfter = mine.total;
          theirAfter = theirs.total;
          requiresDrop = mine.dropped > 0 || theirs.dropped > 0;
        } else {
          myAfter = lineupTotal(myBase.concat(receive.incoming), rosterPositions, valueFor);
          theirAfter = lineupTotal(receive.theirBase.concat(sendIncoming), rosterPositions, valueFor);
        }

        const myGain = myAfter - myBefore;
        const theirGain = theirAfter - theirBefore;

        // Epsilon, not zero: floating point noise and tie-flips manufacture
        // sub-point "gains" that are not real.
        if (myGain <= epsilon || theirGain <= epsilon) continue;
        if (minMutuality > 0 && theirGain < minMutuality * myGain) continue;

        scored.push({
          partnerTeamId: partner.id,
          partnerName: partner.teamName,
          partnerOwner: partner.ownerName,
          send: send.players,
          receive: receive.players,
          myGain,
          theirGain,
          mutuality: Math.min(myGain, theirGain) / Math.max(myGain, theirGain),
          requiresDrop,
        });
      }
      if (now() - started > budgetMs) { truncated = true; break; }
    }
  }

  scored.sort(
    (a, b) =>
      b.myGain - a.myGain ||
      b.mutuality - a.mutuality ||
      (a.send.length + a.receive.length) - (b.send.length + b.receive.length)
  );

  const deduped = dropDominatedSupersets(scored);
  const top = deduped.slice(0, limit).map((candidate) =>
    decorate(candidate, { context, myTeamId, myProfile, solve, epsilon })
  );

  return {
    suggestions: top,
    scanned,
    evaluated,
    truncated,
    elapsedMs: now() - started,
  };
}

/** A bigger package that beats none of the smaller ones inside it is noise. */
function dropDominatedSupersets(scored) {
  const kept = [];
  for (const candidate of scored) {
    const size = candidate.send.length + candidate.receive.length;
    const dominated = kept.some((other) => {
      if (other.partnerTeamId !== candidate.partnerTeamId) return false;
      if (other.send.length + other.receive.length >= size) return false;
      const sendIds = new Set(ids(candidate.send));
      const receiveIds = new Set(ids(candidate.receive));
      const subset =
        ids(other.send).every((id) => sendIds.has(id)) &&
        ids(other.receive).every((id) => receiveIds.has(id));
      return subset && other.myGain >= candidate.myGain - 0.01;
    });
    if (!dominated) kept.push(candidate);
  }
  return kept;
}

/** Full lineups and rationale, computed only for the results we actually show. */
function decorate(candidate, { context, myTeamId, myProfile, epsilon }) {
  const { league, rosters, profiles, reserveIds, valueFor, rosFor, vor, levels, quality } = context;
  const theirProfile = profiles.get(candidate.partnerTeamId);

  const build = (teamId, outPlayers, inPlayers) => {
    const roster = rosters.get(teamId);
    const outSet = new Set(ids(outPlayers));
    const active = roster.active
      .filter((p) => !outSet.has(p.id))
      .concat(inPlayers.filter((p) => !reserveIds.has(p.id)));
    return optimalLineup(active, league.rosterPositions, valueFor);
  };

  const myBeforeLineup = build(myTeamId, [], []);
  const myAfterLineup = build(myTeamId, candidate.send, candidate.receive);
  const theirBeforeLineup = build(candidate.partnerTeamId, [], []);
  const theirAfterLineup = build(candidate.partnerTeamId, candidate.receive, candidate.send);

  const startingForMe = new Set(myBeforeLineup.assignments.map((a) => a.playerId));
  const startingForThem = new Set(theirBeforeLineup.assignments.map((a) => a.playerId));
  const willStart = new Set(myAfterLineup.assignments.map((a) => a.playerId));

  const caveats = [];
  if (candidate.requiresDrop) caveats.push('requires-drop');
  for (const player of candidate.send.concat(candidate.receive)) {
    if (quality(player) === 'bye-imputed' && caveats.indexOf('bye-imputed') === -1) {
      caveats.push('bye-imputed');
    }
    if (reserveIds.has(player.id) && caveats.indexOf('reserve-player-included') === -1) {
      caveats.push('reserve-player-included');
    }
  }

  const describe = (player, startingSet, extra) => ({
    playerId: player.id,
    name: player.fullName || player.id,
    position: player.position,
    nflTeam: player.nflTeam || null,
    status: player.status || 'Active',
    ros: Math.round((rosFor(player) || 0) * 10) / 10,
    vor: Math.round((vor(player) || 0) * 10) / 10,
    startsToday: startingSet.has(player.id),
    quality: quality(player),
    ...extra,
  });

  return {
    id: `${myTeamId}>${candidate.partnerTeamId}:${ids(candidate.send).join('+')}>${ids(candidate.receive).join('+')}`,
    partnerTeamId: candidate.partnerTeamId,
    partnerName: candidate.partnerName,
    partnerOwner: candidate.partnerOwner,
    send: candidate.send.map((p) =>
      describe(p, startingForMe, {
        marginalCost: Math.round(
          marginalOut(rosters.get(myTeamId).active, p.id, league.rosterPositions, valueFor) * 10
        ) / 10,
      })
    ),
    receive: candidate.receive.map((p) =>
      describe(p, startingForThem, { wouldStart: willStart.has(p.id) })
    ),
    myGain: Math.round(candidate.myGain * 10) / 10,
    theirGain: Math.round(candidate.theirGain * 10) / 10,
    mutuality: Math.round(candidate.mutuality * 100) / 100,
    epsilonUsed: epsilon,
    myLineupBefore: myBeforeLineup,
    myLineupAfter: myAfterLineup,
    theirLineupBefore: theirBeforeLineup,
    theirLineupAfter: theirAfterLineup,
    lineupChanges: lineupChanges(myBeforeLineup, myAfterLineup),
    rationale: buildRationale({
      myProfile,
      theirProfile,
      send: candidate.send,
      receive: candidate.receive,
      levels,
      rosFor,
    }),
    caveats,
    replacementLevels: levels,
  };
}
