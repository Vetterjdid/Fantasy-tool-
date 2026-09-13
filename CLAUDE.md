# Fantasy tool — project state

Multi-league fantasy football analysis, delivered as a live Claude Artifact.
`docs/PLAN.md` holds the original design; where this file disagrees with it,
this file is current.

## Where things stand

| Phase | What | Status |
|---|---|---|
| 1 | Analysis engine (`src/analysis/`) | **Done** |
| 2 | Sleeper username → league discovery → identity | **Done**, verified against live responses |
| 3 | Build step bundling `src/analysis/*` into the artifact | **Done** (`scripts/build-artifact.mjs`) |
| 4 | Views: My Team, League, Waivers, Trade Finder, Saved | **Done** |
| 5 | Real Sleeper data | **Done** — running on three live leagues |

82 tests pass. Branch: `claude/live-artifact-tool-um585n`. Run `npm test` before
trusting anything.

Not done: refresh is manual. `npm run fetch:live <username>` re-pulls the data,
then `node scripts/build-artifact.mjs` and a republish. Automating that on a
schedule is the obvious next piece of work.

## The published artifact — do not orphan it

**https://claude.ai/code/artifact/8bfc07fb-3b2b-41ce-a569-2a8e1ccbe63c** ("War Room", 🏈)

**Always republish by passing that `url:` explicitly.** Publishing without it
creates a *separate* artifact, leaving the real one stale and stranding the
saved/dismissed trades in its database.

## How data gets in

The artifact sandbox blocks `fetch`, XHR and WebSocket to **every** host, so the
page cannot call Sleeper or anything else. Data is therefore baked into the page
at build time:

1. `npm run fetch:live <sleeper-username>` → `data/live.json` (gitignored).
   Needs `--use-env-proxy`, already in the npm script — Node's `fetch` ignores
   the proxy env that `curl` reads, and gets a bare 403 without it.
2. `node scripts/build-artifact.mjs` inlines `src/analysis/*` plus that snapshot
   into `build/dashboard.html`.
3. Republish to the URL above.

The bundle is a flat concatenation sharing one scope, so **two modules may not
declare the same top-level name**. The build fails loudly on a collision rather
than shipping a page that dies whole in the browser. It also fails when a
bundled module imports one that is not in `MODULES`: adding a file to
`src/analysis/` and forgetting the bundler list produces perfectly valid
JavaScript that simply never declares those functions, so the page ships and
dies the first time a view calls one.

Only the artifact `db` is live at runtime: it stores each league's saved and
dismissed trades under `tradeboard/<leagueId>`, mirrored to `localStorage`.

## Projections: prior-season production, not a forecast

The season is week 1, so there is no current-season scoring to average and
`src/projections/customModel.js` cannot run. `src/projections/baseline.js` uses
2025 per-game production from nflverse (open data, published for programmatic
use) as the opening prior. It knows nothing about team changes, depth charts or
camp injuries. Swap it back to the rolling-average model once enough weeks exist.

Joining Sleeper to nflverse needs care, and the obvious approach fails quietly:
Sleeper's own `gsis_id` covers about a fifth of a real roster, is missing for
players as prominent as CeeDee Lamb, and arrives on some records with a **leading
space**. Going through nflverse's player table by normalized name lifts coverage
to ~87%, where nearly all the remainder is rookies who correctly have no line.

## Constraints that are not negotiable

- **No passwords.** Sleeper's API is unauthenticated and has no login endpoint.
  A username is a public handle. Never build a password field for a third-party
  service. Future ESPN cookies or Yahoo OAuth stay server-side and **never**
  enter the artifact `db`. The `/user` response carries null `email`, `phone`,
  `token` and `cookies` keys — `loadAllLeagues` picks three fields by hand for
  exactly this reason; do not widen it to spread the whole object.
- **No scraping** sites whose terms disallow programmatic access, and no
  undocumented Sleeper endpoints (their internal projections routes included).
- **Sleeper needs an allowlist entry.** The cloud environment's Network access
  is `Custom` with `api.sleeper.app`. If it 403s again, that setting was changed.

## The engine's core thesis

A player has two different values, and the gap between them is the entire reason
trades happen:

- **VOR** (`ros − replacementLevel[position]`) — scarcity-aware but
  team-independent. Used for **pruning and tie-breaks only.**
- **Marginal value to a specific roster** — `mvOut = L(T) − L(T\{p})`,
  `mvIn = L(T∪{p}) − L(T)`, where `L` is the optimal-lineup total. **Both are 0
  for a player who doesn't crack the lineup**, however good he is in the abstract.

Scoring trades by comparing VOR sums — the "trade value chart" approach — produces
trades nobody accepts. **Never do that.** Every suggestion is scored by re-solving
*both* lineups after the swap.

Corollaries worth keeping in mind before changing anything in `src/analysis/`:

- A roster's value is its **best legal lineup**, re-derived by position
  eligibility. The `slot` field on `RosterSlot` is stale, possibly illegal, and
  records no lineup position — never sum "whoever is flagged starter".
- Lineup assignment is **max-weight bipartite matching**, not greedy. Greedy is
  optimal only when eligibility sets nest, and real FLEX configs break that.
  `greedyLineup` exists solely as a test oracle.
- Ineligible pairs use a large **finite** sentinel. `-Infinity` poisons the
  matching potentials to `NaN`.
- Tie-breaks are deterministic `(value desc, position, id asc)`. Non-deterministic
  lineups jitter, and jitter manufactures phantom trades.
- A projection row on a bye carries `projectedPoints: 0`. Used raw, every star on
  bye reads as worthless and the engine screams "sell". Bye values are imputed
  from the nearest-ranked healthy peer at the same position. `baseline.js` hard-codes
  `bye: false` because week 1 has none — extending it past week 1 **must** consult
  the schedule.
- A missing projection is `null`, never `0`. Rookies rely on this.
- Replacement level is the **median of the top few free agents** — not the single
  best (one lucky waiver player would erase a whole position's tradeable value)
  and never a rostered player (who cannot be had at any price).
- **Shortfall means an empty lineup slot**, nothing else. Comparing starters
  against demand looks right and is wrong: FLEX demand is fractional, so a team
  starting exactly two RBs in a 2-RB-plus-FLEX league always measured 0.33
  "short", and every team in every league read as short at two of three flex
  positions.
- Guard `SD === 0` before computing z-scores.
- **Reserve players are never drop candidates on the waiver wire.** IR carries
  an availability factor of zero, so an injured star's rest-of-season value is
  zero, so dropping him looks free — a recommender trusting that arithmetic
  advises cutting your best injured player every week. The value of an IR stash
  is that he returns, which this horizon does not model.
- **K and DEF are browsable but never recommended.** The baseline gives every
  kicker the same number and every defense the same number, so ranking them
  would be ranking noise.
- **Sleeper's `waiver_type` enum is undocumented** and these leagues do not all
  use the same value (0, 0, 1). `waiver_position` is ground truth for the
  current order and is displayed; the reordering rule is deliberately NOT named,
  because asserting "reverse standings" would be an unverifiable claim shown as
  fact. `docs.sleeper.com` is not on the egress allowlist, only `api.sleeper.app`.

## UI notes

Sleeper's visual language: dark-only, and position colours carry identity
(QB pink, RB teal, WR blue, TE orange, K purple, DEF grey). Keep those strictly
apart from the diverging warm/cool pair, which means weak or strong. Player
headshots cannot be used — the sandbox blocks external images — hence tinted
initials.

ARIA attributes need the literal strings `"true"`/`"false"`; the `el()` helper's
boolean-attribute shorthand (correct for `disabled`, `open`) silently breaks
`[aria-selected="true"]` selectors, which is how the league tabs once lost their
selected state.

Waiver pickups and trade suggestions both need variety capping, for the same
reason: ranked purely by gain, every free tight end that beats your worst one
fills the list with eight ways to say "add a tight end". Two per position
(waivers) and two per manager (trades).

Trade suggestions are ordered for variety, not filtered: best two per manager
first, then the rest by rank. A hard per-manager cap looks reasonable and leaves
only ~8 of 60, because just four to six managers in a league ever have a workable
trade.

## Decisions already taken

Horizon: rest of season. Suggestions: mutual gain only, ranked by my gain.
Onboarding: Sleeper username, no league IDs. Identity: `owner_id === user_id`,
resolved per league — a user can own a different roster in each.

## Conventions

Plain ESM, Node 18+, **zero dependencies** in `src/`, `node:test` +
`node:assert/strict`. `npm test` runs `node --test "test/**/*.test.js"` — this
Node rejects a bare directory argument, so keep the glob.
