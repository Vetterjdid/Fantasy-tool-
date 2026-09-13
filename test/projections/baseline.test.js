import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeName,
  cleanGsisId,
  buildIdBridge,
  perGamePoints,
  baselineProjections,
} from '../../src/projections/baseline.js';
import { parseCsv } from '../../src/util/csv.js';

test('gsis ids are trimmed — Sleeper ships some with a leading space', () => {
  // Live data really contains ' 00-0034975'. Untrimmed it is truthy but never
  // matches, so the join fails silently for those players.
  assert.equal(cleanGsisId(' 00-0034975'), '00-0034975');
  assert.equal(cleanGsisId('00-0032104'), '00-0032104');
  assert.equal(cleanGsisId(''), null);
  assert.equal(cleanGsisId(undefined), null);
});

test('name normalization survives accents, suffixes and punctuation', () => {
  assert.equal(normalizeName("De'Zhaun Stribling"), 'dezhaunstribling');
  assert.equal(normalizeName('Marvin Harrison Jr.'), 'marvinharrison');
  assert.equal(normalizeName('Amon-Ra St. Brown'), 'amonrastbrown');
  assert.equal(normalizeName('Michael Peníx'), normalizeName('Michael Penix'));
});

test('the id bridge prefers a real gsis id and falls back to the name match', () => {
  const catalog = {
    s1: { player_id: 's1', full_name: 'Ameer Abdullah', position: 'RB', gsis_id: ' 00-0032104' },
    s2: { player_id: 's2', full_name: 'CeeDee Lamb', position: 'WR', gsis_id: null },
    s3: { player_id: 's3', full_name: 'Nobody Here', position: 'WR', gsis_id: null },
  };
  const nflverse = [
    { gsis_id: '00-0032104', display_name: 'Ameer Abdullah', position: 'RB' },
    { gsis_id: '00-0036322', display_name: 'CeeDee Lamb', position: 'WR' },
  ];
  const { bridge, stats } = buildIdBridge(catalog, nflverse);

  assert.equal(bridge.get('s1'), '00-0032104', 'trimmed, not the raw spaced value');
  assert.equal(bridge.get('s2'), '00-0036322', 'matched by name where Sleeper has no id');
  assert.equal(bridge.has('s3'), false, 'no invented match');
  assert.equal(stats.direct, 1);
  assert.equal(stats.viaName, 1);
});

test('a namesake cannot displace an established player in the bridge', () => {
  const catalog = { s1: { player_id: 's1', full_name: 'John Smith', position: 'WR', gsis_id: null } };
  const nflverse = [
    { gsis_id: '00-0001111', display_name: 'John Smith', position: 'WR' },
    { gsis_id: '00-0009999', display_name: 'John Smith', position: 'WR' },
  ];
  const { bridge } = buildIdBridge(catalog, nflverse);
  assert.equal(bridge.get('s1'), '00-0001111', 'first row wins, deterministically');
});

test('per-game points respect the league scoring type', () => {
  const line = { games: '10', fantasy_points: '100', fantasy_points_ppr: '160' };
  assert.equal(perGamePoints(line, 'standard'), 10);
  assert.equal(perGamePoints(line, 'ppr'), 16);
  assert.equal(perGamePoints(line, 'half_ppr'), 13, 'reception points split in half');
});

test('a player with no games played yields no rate, never a zero', () => {
  assert.equal(perGamePoints({ games: '0', fantasy_points: '0', fantasy_points_ppr: '0' }, 'ppr'), null);
});

test('a rookie gets no projection rather than a zero one', () => {
  // Zero would read as "worthless" everywhere downstream. Absent reads as
  // "unknown", which is the truth and which restOfSeasonValues tags `missing`.
  const catalog = {
    vet: { player_id: 'vet', full_name: 'Old Hand', position: 'RB', gsis_id: '00-0000001' },
    rook: { player_id: 'rook', full_name: 'Fresh Legs', position: 'RB', gsis_id: null },
  };
  const { projections, coverage } = baselineProjections({
    sleeperCatalog: catalog,
    nflversePlayers: [{ gsis_id: '00-0000001', display_name: 'Old Hand', position: 'RB' }],
    nflverseStats: [{ player_id: '00-0000001', games: '16', fantasy_points: '160', fantasy_points_ppr: '200' }],
    playerIds: ['vet', 'rook'],
    leagueId: 'sleeper:1',
    season: '2026',
    week: 1,
    scoringType: 'ppr',
  });

  assert.equal(projections.length, 1);
  assert.equal(projections[0].playerId, 'vet');
  assert.equal(projections[0].projectedPoints, 12.5);
  assert.equal(coverage.missing, 1);
  assert.equal(coverage.missingPlayers[0].name, 'Fresh Legs');
});

test('kickers and defenses get a flat placeholder so lineups can still fill', () => {
  const catalog = {
    k: { player_id: 'k', full_name: 'A Foot', position: 'K', gsis_id: null },
    d: { player_id: 'd', full_name: 'Bears', position: 'DEF', gsis_id: null },
  };
  const { projections, coverage } = baselineProjections({
    sleeperCatalog: catalog,
    nflversePlayers: [],
    nflverseStats: [],
    playerIds: ['k', 'd'],
    leagueId: 'sleeper:1',
    season: '2026',
    week: 1,
    scoringType: 'ppr',
  });
  assert.equal(coverage.flat, 2);
  assert.equal(coverage.missing, 0);
  assert.ok(projections.every((p) => p.source === 'baseline-flat'));
});

test('week-1 projections are never marked as byes', () => {
  // A bye read as zero is the most damaging single error in the engine, and
  // byes do not start until around week 5.
  const { projections } = baselineProjections({
    sleeperCatalog: { k: { player_id: 'k', full_name: 'A Foot', position: 'K' } },
    nflversePlayers: [], nflverseStats: [], playerIds: ['k'],
    leagueId: 'sleeper:1', season: '2026', week: 1, scoringType: 'ppr',
  });
  assert.equal(projections[0].bye, false);
});

// ---- the CSV reader the whole pipeline depends on ----

test('the CSV reader keeps quoted commas inside their field', () => {
  // nflverse quotes names containing commas. A naive split shifts every
  // subsequent column, which would silently corrupt the stats join.
  const rows = parseCsv('player_id,player_name,position\n1,"Smith, John",WR\n2,Plain Name,RB\n');
  assert.equal(rows.length, 2);
  assert.equal(rows[0].player_name, 'Smith, John');
  assert.equal(rows[0].position, 'WR');
  assert.equal(rows[1].player_name, 'Plain Name');
});

test('the CSV reader handles escaped quotes and a missing trailing newline', () => {
  const rows = parseCsv('a,b\n"say ""hi""",2');
  assert.equal(rows[0].a, 'say "hi"');
  assert.equal(rows[0].b, '2');
});
