#!/usr/bin/env node
/**
 * Bundle the analysis engine and a data snapshot into a single self-contained
 * artifact page.
 *
 * The artifact sandbox blocks every outbound request — fetch, XHR and
 * WebSocket alike — so the page cannot call Sleeper, or anything else, itself.
 * Everything it needs has to be in the file when it is published.
 *
 * The engine is inlined from src/ rather than rewritten for the browser.
 * Hand-mirroring the same logic in two places guarantees the two drift, and
 * the copy without tests is always the one that is wrong.
 *
 *   node scripts/build-artifact.mjs [--demo]
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Dependency order, since the bundle is a flat concatenation rather than a
 * module graph. A module must appear after everything it references.
 */
const MODULES = [
  'src/model/schema.js',
  'src/projections/schedule.js',
  'src/analysis/lineup.js',
  'src/analysis/value.js',
  'src/analysis/roster.js',
  'src/analysis/profile.js',
  'src/analysis/explain.js',
  'src/analysis/waivers.js',
  'src/analysis/trades.js',
  'src/analysis/index.js',
];

/**
 * Strip ES module syntax so the files concatenate into one scope.
 *
 * Line-oriented rather than regex-over-the-whole-file: imports span several
 * lines in this codebase, and a non-greedy regex across the file will happily
 * swallow real code between two import statements.
 */
export function stripModuleSyntax(source) {
  const lines = source.split('\n');
  const out = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();

    // `import ... from '...'` and re-exports: drop the whole statement,
    // however many lines it occupies.
    if (/^import\b/.test(trimmed) || /^export\s+[*{][^=]*$/.test(trimmed) || /^export\s+[*{].*\bfrom\b/.test(trimmed)) {
      let statement = trimmed;
      while (!/;\s*$/.test(statement) && i + 1 < lines.length) {
        i++;
        statement += ' ' + lines[i].trim();
      }
      // `export { findTrades }` with no `from` is a local re-export of a name
      // already declared in this file — dropping it is correct either way.
      continue;
    }

    // `export function f()` / `export const x` / `export class C` -> bare decl.
    out.push(line.replace(/^(\s*)export\s+(?=(async\s+)?(function|const|let|var|class)\b)/, '$1'));
  }

  return out.join('\n');
}

/**
 * Flat concatenation means every module shares one scope, so two files
 * declaring the same top-level name is a syntax error that only appears in the
 * browser — the page dies whole, with a message that names the identifier and
 * nothing else. Catching it here turns that into a failed build.
 */
function assertNoCollisions(modules) {
  const declaredIn = new Map();
  const collisions = [];
  for (const [rel, source] of modules) {
    for (const line of source.split('\n')) {
      const match = line.match(/^(?:async\s+)?(?:function|const|let|var|class)\s+([A-Za-z0-9_$]+)/);
      if (!match) continue;
      const name = match[1];
      if (declaredIn.has(name)) collisions.push(`${name} (${declaredIn.get(name)} and ${rel})`);
      else declaredIn.set(name, rel);
    }
  }
  if (collisions.length) {
    throw new Error(
      'Two modules declare the same top-level name, which cannot survive bundling:\n  ' +
      collisions.join('\n  ') +
      '\nExport it from one module and import it in the other.'
    );
  }
}

/**
 * Every module the bundled set imports or re-exports must itself be bundled.
 *
 * Forgetting to add a new file to MODULES does not fail the build on its own —
 * the concatenation is happily valid JavaScript that simply never declares the
 * missing functions, so the page ships and then dies the moment a view calls
 * one. That is a browser-only failure for a mistake visible right here.
 */
function assertNoMissingModules(rawSources) {
  const bundled = new Set(MODULES);
  const missing = [];
  for (const [rel, source] of rawSources) {
    const dir = rel.slice(0, rel.lastIndexOf('/'));
    for (const match of source.matchAll(/\bfrom\s+['"](\.[^'"]+)['"]/g)) {
      const resolved = new URL(match[1], 'file:///' + dir + '/').pathname.replace(/^\//, '');
      if (!bundled.has(resolved)) missing.push(`${rel} references ${match[1]} (${resolved})`);
    }
  }
  if (missing.length) {
    throw new Error(
      'These modules are imported but not in the bundle, so the page would call functions that do not exist:\n  ' +
      missing.join('\n  ') + '\nAdd them to MODULES, in dependency order.'
    );
  }
}

function bundleEngine() {
  const raw = MODULES.map((rel) => [rel, readFileSync(join(ROOT, rel), 'utf8')]);
  assertNoMissingModules(raw);
  const modules = raw.map(([rel, source]) => [rel, stripModuleSyntax(source)]);
  assertNoCollisions(modules);
  return modules.map(([rel, source]) => `// ===== ${rel} =====\n${source}`).join('\n');
}

function loadSnapshot(useDemo) {
  const live = join(ROOT, 'data', 'live.json');
  if (!useDemo && existsSync(live)) return JSON.parse(readFileSync(live, 'utf8'));

  const demo = join(ROOT, 'scripts', 'demo-data.json');
  if (!existsSync(demo)) {
    throw new Error('No data. Run `npm run fetch:live <username>` or `npm run refresh:demo`.');
  }
  // The demo generator emits one flat league; reshape it to the live envelope
  // so the page has exactly one input format to understand.
  const d = JSON.parse(readFileSync(demo, 'utf8'));
  const league = d.leagues[0];
  return {
    meta: { ...d.meta, projectionSource: 'demo data', fetchedAt: new Date().toISOString(), demo: true },
    identity: { displayName: 'Demo', sleeperUsername: 'demo', sleeperUserId: null },
    leagues: [{
      league,
      teams: d.teams.filter((t) => t.leagueId === league.id),
      rosterSlots: d.rosterSlots.filter((s) => s.leagueId === league.id),
      players: Object.fromEntries(d.players.map((p) => [p.id, p])),
      projections: d.projections.filter((p) => p.leagueId === league.id),
      myTeamId: d.teams.filter((t) => t.leagueId === league.id)[0].id,
      coverage: null,
    }],
  };
}

function main() {
  const useDemo = process.argv.includes('--demo');
  const template = readFileSync(join(ROOT, 'artifact', 'dashboard.template.html'), 'utf8');
  const snapshot = loadSnapshot(useDemo);

  for (const marker of ['<!--INJECT:analysis-->', '<!--INJECT:data-->']) {
    if (!template.includes(marker)) throw new Error(`template is missing ${marker}`);
  }

  const html = template
    .replace('<!--INJECT:analysis-->', () => bundleEngine())
    // `</script>` inside a JSON string would close the surrounding tag early.
    // U+2028/U+2029 are valid JSON but break JavaScript string literals.
    .replace('<!--INJECT:data-->', () => JSON.stringify(snapshot)
      .replace(/</g, '\\u003c')
      .replace(/\u2028/g, '\\u2028')
      .replace(/\u2029/g, '\\u2029'));

  mkdirSync(join(ROOT, 'build'), { recursive: true });
  const out = join(ROOT, 'build', 'dashboard.html');
  writeFileSync(out, html);

  const leagues = snapshot.leagues.map((l) => l.league.name).join(', ');
  process.stderr.write(
    `built ${out} — ${(html.length / 1024).toFixed(0)} KB\n` +
    `  ${snapshot.leagues.length} league(s): ${leagues}\n` +
    `  week ${snapshot.meta.currentWeek} ${snapshot.meta.season} | ${snapshot.meta.projectionSource}\n`
  );
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
