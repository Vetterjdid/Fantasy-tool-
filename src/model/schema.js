/**
 * Unified internal data model that every platform integration (Sleeper, ESPN,
 * Yahoo, ...) normalizes into. The dashboard UI and projection logic only
 * ever deal with these shapes, never with a platform's raw response.
 *
 * @typedef {'sleeper'|'espn'|'yahoo'} Platform
 *
 * @typedef {Object} League
 * @property {string} id              `${platform}:${externalId}`
 * @property {Platform} platform
 * @property {string} externalId      platform's own league id
 * @property {string} name
 * @property {string} season          e.g. "2025"
 * @property {string} scoringType     'ppr' | 'half_ppr' | 'standard' | 'custom'
 * @property {number} totalRosters
 * @property {string[]} rosterPositions  e.g. ['QB','RB','RB','WR','WR','TE','FLEX','DEF','K','BN','BN','BN','BN','BN','BN']
 * @property {string} status          'pre_draft' | 'drafting' | 'in_season' | 'complete'
 * @property {number|null} waiverType   Sleeper's raw `waiver_type`. Its enum is NOT
 *                                      documented in the public API docs, so it is
 *                                      carried through unmapped — display it as
 *                                      unverified rather than naming a system.
 * @property {number|null} waiverBudget FAAB budget, if the league runs one
 * @property {number|null} waiverDayOfWeek raw; the weekday base is likewise unverified
 * @property {number|null} waiverClearDays days a claim sits before processing
 *
 * @typedef {Object} Team
 * @property {string} id              `${leagueId}:${externalId}`
 * @property {string} leagueId
 * @property {string} externalId      platform's own roster/team id
 * @property {string|null} ownerId    platform's own user id for the owner; this is
 *                                    what resolves "which of these teams is mine",
 *                                    per league — the same person can own a
 *                                    different roster in every league they're in
 * @property {string} ownerName
 * @property {string} teamName
 * @property {number} wins
 * @property {number} losses
 * @property {number} ties
 * @property {number} pointsFor
 * @property {number} pointsAgainst
 * @property {number|null} waiverPosition  1 = first claim. Sleeper reports this for
 *                                         every roster and it is ground truth for the
 *                                         CURRENT order; how it reorders after a claim
 *                                         depends on the league's waiver type.
 * @property {number} waiverBudgetUsed     FAAB spent so far (0 in a non-FAAB league,
 *                                         and also 0 before anyone has bid — the two
 *                                         are indistinguishable early in a season)
 *
 * @typedef {Object} Player
 * @property {string} id              canonical id, Sleeper's player id preferred
 * @property {Object} platformIds     { sleeper?, espn?, yahoo? }
 * @property {string} fullName
 * @property {string} position        'QB'|'RB'|'WR'|'TE'|'K'|'DEF'
 * @property {string|null} nflTeam    NFL team abbreviation, null if free agent/retired
 * @property {string} status          'Active'|'Injured Reserve'|'Out'|'Questionable'|...
 * @property {number|null} age
 * @property {number|null} yearsExp
 *
 * @typedef {Object} RosterSlot
 * @property {string} leagueId
 * @property {string} teamId
 * @property {string} playerId
 * @property {'starter'|'bench'|'ir'|'taxi'} slot
 * @property {number|null} lineupSlot  For a starter, the INDEX into the league's
 *                                     scoring slots — Sleeper's `starters` array is
 *                                     positional, so index 6 in a
 *                                     QB/RB/RB/WR/WR/TE/FLEX league is the FLEX.
 *                                     This is the manager's actual declared lineup,
 *                                     which is not the same as the optimal one.
 *
 * @typedef {Object} Projection
 * @property {string} playerId
 * @property {string} leagueId        projections can be scoring-type dependent
 * @property {string} season
 * @property {number} week
 * @property {number} projectedPoints  a per-game RATE, never zeroed for a bye
 * @property {number|null} byeWeek    the week this player's NFL team is off, or null
 *                                    if unknown. Rest-of-season value counts GAMES,
 *                                    so a bye still ahead costs one game.
 * @property {string|null} opponent   NFL team abbreviation, null on bye
 * @property {boolean} bye            whether THIS row's week is the bye (informational)
 * @property {'custom'|'fantasypros'|'nflverse'} source
 *
 * @typedef {Object} Ranking
 * @property {string} playerId
 * @property {string} position
 * @property {number} rank            rank within position
 * @property {number|null} tier
 * @property {string} source
 * @property {string} asOf            ISO date
 */

/** @param {Platform} platform @param {string} externalId */
export function leagueId(platform, externalId) {
  return `${platform}:${externalId}`;
}

/** @param {string} leagueId @param {string} externalId */
export function teamId(leagueId, externalId) {
  return `${leagueId}:${externalId}`;
}

export const ROSTER_SLOT = /** @type {const} */ ({
  STARTER: 'starter',
  BENCH: 'bench',
  IR: 'ir',
  TAXI: 'taxi',
});

export const POSITIONS = /** @type {const} */ (['QB', 'RB', 'WR', 'TE', 'K', 'DEF']);
