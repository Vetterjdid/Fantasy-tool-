# Fantasy tool — project state

Multi-league fantasy football analysis, delivered as a live Claude Artifact.
Read `docs/PLAN.md` for the full design and the phase breakdown.

## Where things stand

| Phase | What | Status |
|---|---|---|
| 1 | Analysis engine (`src/analysis/`) | **Done** — 55 tests pass |
| 2 | Sleeper username → league discovery → identity | Not started, and **deliberately deferred** (see Blocker) |
| 3 | Build step: bundle `src/analysis/*` into the artifact | Not started |
| 4 | Three views: My Team, League, Trade Finder | Not started |
| 5 | Real Sleeper data | Blocked |

Branch: `claude/live-artifact-tool-um585n`. Run `npm test` before trusting anything.

## The published artifact — do not orphan it

**https://claude.ai/code/artifact/8bfc07fb-3b2b-41ce-a569-2a8e1ccbe63c** ("War Room", 🏈)

It holds a seeded database of ~447 documents. **Always republish by passing that
`url:` explicitly.** Publishing without it creates a *new* artifact whose database
starts empty, and the seeded data is not attached to it.

## Blocker: `api.sleeper.app` is unreachable

The environment's network policy denies it — `curl` gets `CONNECT tunnel failed,
response 403`. This is not a timeout, a rate limit, or something to retry or route
around; it needs the cloud environment's **Network access** changed from `Trusted`
to `Custom` with `api.sleeper.app` allowed (plus the "include default package
managers" box ticked, or npm and GitHub break). Only the account owner can do that.

Consequences a fresh session should not "fix":

- `src/integrations/sleeper.js` is written against the documented API shape but
  **has never seen a live response**. Anything marked unverified genuinely is.
- The dashboard runs on generated demo data (`scripts/build-demo-data.mjs`,
  deterministic). That is a stand-in, not a fixture to build behaviour around.
- Phase 2 is skipped on purpose: writing network code that cannot be run once is
  how you get bugs that surface only when you need them not to.

## Constraints that are not negotiable

- **No passwords.** Sleeper's public API is unauthenticated and has no login
  endpoint. A username is a public handle, not a credential. Never build a
  password field for a third-party service. If ESPN cookies or Yahoo OAuth land
  later, those secrets stay server-side and **never** enter the artifact `db`,
  which every viewer of the artifact can read.
- **No scraping** sites whose terms disallow programmatic access. Stated by the
  user in the original spec.
- **Artifacts cannot make network requests.** The sandbox CSP blocks `fetch`,
  XHR and WebSocket to every host. This is *the* architectural constraint: the
  page cannot call Sleeper itself. A session or routine fetches, writes to the
  artifact `db`, and the page reads from there. Scripts load only from cdnjs,
  jsdelivr, the Tailwind play CDN and code.jquery.com; stylesheets only from
  fonts.googleapis.com.

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
  from the nearest-ranked healthy peer at the same position.
- A missing projection is `null`, never `0`.
- Replacement level is the **median of the top few free agents** — not the single
  best (one lucky waiver player would erase a whole position's tradeable value)
  and never a rostered player (who cannot be had at any price).
- Guard `SD === 0` before computing z-scores.

## Decisions already taken

Horizon: rest of season. Suggestions: mutual gain only, ranked by my gain.
Onboarding: Sleeper username, no league IDs. Identity: derived from
`owner_id === user_id`, resolved per league — a user can own a different roster in
each one. Views: My Team · League · Trade Finder, with waivers and rankings folded
in as context rather than their own tabs.

## Conventions

Plain ESM, Node 18+, **zero dependencies**, `node:test` + `node:assert/strict`.
`npm test` runs `node --test "test/**/*.test.js"` — this Node rejects a bare
directory argument, so keep the glob.
