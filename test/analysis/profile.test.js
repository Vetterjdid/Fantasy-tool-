import { test } from 'node:test';
import assert from 'node:assert/strict';
import { optimalLineup } from '../../src/analysis/lineup.js';
import { shortfallByPosition, teamProfile, weakSpots } from '../../src/analysis/profile.js';

const FLEX_LEAGUE = {
  totalRosters: 12,
  rosterPositions: ['QB', 'RB', 'RB', 'WR', 'WR', 'TE', 'FLEX', 'K', 'DEF', 'BN', 'BN'],
};

const P = (id, position, value, extra = {}) => ({
  id, position, fullName: id, status: 'Active', nflTeam: 'KC', value, ...extra,
});
const val = (p) => p.value;

/** A complete roster: every slot fillable, one RB spare who takes the FLEX. */
function fullRoster() {
  return [
    P('qb1', 'QB', 300),
    P('rb1', 'RB', 250), P('rb2', 'RB', 200), P('rb3', 'RB', 180),
    P('wr1', 'WR', 240), P('wr2', 'WR', 210),
    P('te1', 'TE', 150),
    P('k1', 'K', 100), P('def1', 'DEF', 90),
  ];
}

test('a team that fills every slot is short nowhere, whoever wins the FLEX', () => {
  // The regression this exists for: RB demand in this league is 2.33 because
  // the FLEX is shared three ways, so measuring starters against demand made
  // a team starting three RBs look 0.33 short at WR and TE simultaneously.
  const lineup = optimalLineup(fullRoster(), FLEX_LEAGUE.rosterPositions, val);
  assert.equal(lineup.unfilled.length, 0, 'this roster fills every slot');
  assert.deepEqual(shortfallByPosition(lineup), {});
});

test('an empty slot is a shortfall for every position that could have filled it', () => {
  const noTe = fullRoster().filter((p) => p.position !== 'TE');
  const lineup = optimalLineup(noTe, FLEX_LEAGUE.rosterPositions, val);
  const short = shortfallByPosition(lineup);

  // With no tight end the TE slot cannot be filled by anyone.
  assert.equal(short.TE, 1, 'the empty TE slot counts against TE');
  assert.ok(!short.QB, 'a quarterback could never have filled it');
});

test('a missing quarterback is a shortfall at quarterback only', () => {
  const noQb = fullRoster().filter((p) => p.position !== 'QB');
  const lineup = optimalLineup(noQb, FLEX_LEAGUE.rosterPositions, val);
  const short = shortfallByPosition(lineup);
  assert.equal(short.QB, 1);
  assert.ok(!short.RB && !short.WR && !short.TE, 'the flex slots are still filled');
});

test('weak spots rank by relative strength, not by which position won the FLEX', () => {
  const roster = fullRoster();
  const profile = teamProfile({
    team: { id: 't1', teamName: 'T', ownerName: 'O' },
    roster: { active: roster, reserve: [], all: roster },
    league: FLEX_LEAGUE,
    valueFor: val,
    rosFor: val,
    levels: { QB: 100, RB: 100, WR: 100, TE: 100, K: 50, DEF: 50 },
    weeks: 14,
  });

  for (const position of ['QB', 'RB', 'WR', 'TE']) {
    assert.equal(profile.byPosition[position].shortfall, 0, `${position} should not be short`);
  }

  // With no shortfall anywhere, ordering is purely the z-scores, so a
  // single-team league (every z is 0) must not invent a severity spike.
  const ranked = weakSpots(profile);
  assert.equal(ranked.length, 4);
  assert.ok(ranked.every((entry) => entry.severity === 0), 'no phantom severity');
});

test('a real hole outranks merely being below average', () => {
  const roster = fullRoster().filter((p) => p.position !== 'TE');
  const profile = teamProfile({
    team: { id: 't1', teamName: 'T', ownerName: 'O' },
    roster: { active: roster, reserve: [], all: roster },
    league: FLEX_LEAGUE,
    valueFor: val,
    rosFor: val,
    levels: { QB: 100, RB: 100, WR: 100, TE: 100, K: 50, DEF: 50 },
    weeks: 14,
  });
  // Hand-set z-scores as if the league had rated this roster strong at TE;
  // an unfillable slot must still outrank a merely soft position.
  profile.byPosition.TE.z = 0.5;
  profile.byPosition.RB.z = -0.4;

  assert.equal(weakSpots(profile)[0].position, 'TE', 'an empty slot is the weakest spot');
});
