#!/usr/bin/env node
/**
 * Pull one live snapshot: Sleeper leagues + rosters, nflverse prior-season
 * production, joined into everything the dashboard needs.
 *
 * Writes data/live.json (gitignored — it is league data, not source).
 *
 *   node scripts/fetch-live.mjs <sleeper-username> [season]
 *
 * Network calls are deliberately explicit and few. The nflverse CSVs are
 * cached under data/cache/ because they are tens of megabytes and change once
 * a week at most; pass --refresh to re-download them.
 */

import { mkdirSync, writeFileSync, readFileSync, existsSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { fetchState, loadAllLeagues, fetchPlayersCatalog, computeWaiverWire, normalizePlayersCatalog } from '../src/integrations/sleeper.js';
import { baselineProjections } from '../src/projections/baseline.js';
import { parseCsv } from '../src/util/csv.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DATA = join(ROOT, 'data');
const CACHE = join(DATA, 'cache');
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;

const NFLVERSE = 'https://github.com/nflverse/nflverse-data/releases/download';

async function cachedCsv(name, url, refresh) {
  mkdirSync(CACHE, { recursive: true });
  const path = join(CACHE, name);
  const fresh = existsSync(path) && Date.now() - statSync(path).mtimeMs < CACHE_TTL_MS;
  if (!fresh || refresh) {
    process.stderr.write(`  downloading ${name}...\n`);
    const res = await fetch(url);
    if (!res.ok) throw new Error(`${url} -> ${res.status} ${res.statusText}`);
    writeFileSync(path, await res.text());
  }
  return parseCsv(readFileSync(path, 'utf8'));
}

async function main() {
  const args = process.argv.slice(2);
  const refresh = args.includes('--refresh');
  const handle = args.find((a) => !a.startsWith('--'));
  if (!handle) {
    console.error('usage: node scripts/fetch-live.mjs <sleeper-username> [season] [--refresh]');
    process.exit(1);
  }

  const state = await fetchState();
  const season = args.filter((a) => !a.startsWith('--'))[1] || state.season;
  const week = state.week;
  process.stderr.write(`Sleeper: ${season} week ${week} (${state.season_type})\n`);

  const { identity, leagues } = await loadAllLeagues(handle, season);
  process.stderr.write(`${identity.displayName}: ${leagues.length} league(s)\n`);
  if (!leagues.length) {
    console.error(`No ${season} NFL leagues for "${handle}". Check the season.`);
    process.exit(1);
  }

  const rawCatalog = await fetchPlayersCatalog();
  const catalog = normalizePlayersCatalog(rawCatalog);
  process.stderr.write(`Sleeper catalog: ${Object.keys(catalog).length} players\n`);

  // Prior season: this season has no completed weeks to average yet.
  const priorSeason = String(Number(season) - 1);
  const [nflversePlayers, nflverseStats] = await Promise.all([
    cachedCsv('players.csv', `${NFLVERSE}/players/players.csv`, refresh),
    cachedCsv(`stats_${priorSeason}.csv`, `${NFLVERSE}/stats_player/stats_player_reg_${priorSeason}.csv`, refresh),
  ]);
  process.stderr.write(`nflverse: ${nflversePlayers.length} players, ${nflverseStats.length} ${priorSeason} stat lines\n`);

  const snapshots = [];
  for (const { league, teams, rosterSlots, myTeamId } of leagues) {
    // Free agents worth considering. The full catalog is 12k entries, most of
    // them practice-squad noise; replacement level only needs the top of each
    // position, and the artifact should not carry thousands of dead rows.
    const waiver = computeWaiverWire(catalog, rosterSlots);
    const rosteredIds = rosterSlots.map((s) => s.playerId);

    const { projections: rosteredProjections, coverage } = baselineProjections({
      sleeperCatalog: rawCatalog,
      nflversePlayers,
      nflverseStats,
      playerIds: rosteredIds,
      leagueId: league.id,
      season,
      week,
      scoringType: league.scoringType,
    });

    const { projections: waiverProjections } = baselineProjections({
      sleeperCatalog: rawCatalog,
      nflversePlayers,
      nflverseStats,
      playerIds: waiver.map((p) => p.id),
      leagueId: league.id,
      season,
      week,
      scoringType: league.scoringType,
    });

    // Keep the best 30 free agents per position: enough for an honest
    // replacement level and a browsable waiver board, small enough to ship.
    const byPosition = new Map();
    for (const row of waiverProjections) {
      const player = catalog[row.playerId];
      if (!player) continue;
      if (!byPosition.has(player.position)) byPosition.set(player.position, []);
      byPosition.get(player.position).push(row);
    }
    const keptWaiver = [];
    for (const rows of byPosition.values()) {
      rows.sort((a, b) => b.projectedPoints - a.projectedPoints);
      keptWaiver.push(...rows.slice(0, 30));
    }

    const projections = rosteredProjections.concat(keptWaiver);
    const playerIds = new Set(projections.map((p) => p.playerId).concat(rosteredIds));
    const players = {};
    for (const id of playerIds) if (catalog[id]) players[id] = catalog[id];

    snapshots.push({ league, teams, rosterSlots, players, projections, myTeamId, coverage });
    process.stderr.write(
      `  ${league.name.padEnd(12)} ${teams.length} teams  ` +
      `proj ${coverage.observed} observed / ${coverage.flat} flat / ${coverage.missing} missing  ` +
      `${keptWaiver.length} FA  ${myTeamId ? 'mine: ' + myTeamId : 'NO TEAM OWNED'}\n`
    );
  }

  mkdirSync(DATA, { recursive: true });
  const out = {
    meta: {
      fetchedAt: new Date().toISOString(),
      season,
      currentWeek: week,
      projectionSource: `nflverse ${priorSeason} per-game, PPR-adjusted`,
    },
    identity,
    leagues: snapshots,
  };
  writeFileSync(join(DATA, 'live.json'), JSON.stringify(out));
  process.stderr.write(`\nwrote data/live.json (${(JSON.stringify(out).length / 1024).toFixed(0)} KB)\n`);
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
