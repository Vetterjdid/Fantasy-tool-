# Trade Finder — rebuild the dashboard around team analysis

## Context

The dashboard today answers "what does this league look like?" It cannot answer the two questions that actually matter to a manager: **how is my team composed relative to everyone else, and what trade should I make?**

Nothing in the current build supports that. Three structural gaps:

1. **No concept of "my team."** `Team` carries `ownerName` but not `ownerId`; `normalizeTeams()` reads Sleeper's `roster.owner_id` and throws it away. There is no user identity anywhere in the repo.
2. **Roster value is computed wrong.** `starterTotal()` sums whoever is flagged `slot === 'starter'`. That flag is stale, possibly illegal, and records no lineup position — there is no QB/RB/FLEX assignment stored anywhere. A roster's real value is its *optimal* lineup, which must be re-derived from `Player.position` against `League.rosterPositions`.
3. **Value is measured over one week.** Trades are rest-of-season decisions; only single-week projections exist.

The outcome we want: three views — **My Team**, **League**, **Trade Finder** — where the trade tool works from either end (analyze my weaknesses and find fixes, or shop a specific player and see who wants him), and every suggestion is backed by numbers a manager can check.

## Core thesis (this drives every design decision)

A player has **two different values**, and the gap between them is the entire reason trades happen:

- **Abstract value** — `VOR = restOfSeasonValue − replacementLevel(position)`. Scarcity-aware, team-independent.
- **Marginal value to a specific roster** — `mvOut(T,p) = L(T) − L(T\{p})` and `mvIn(T,p) = L(T∪{p}) − L(T)`, where `L` is the optimal-lineup total. **Both are 0 for a player who doesn't crack the lineup**, however good he is in the abstract.

My third startable RB might have `VOR = 40` but `mvOut ≈ 3`. On a team starting a 6.2-pt RB2 his `mvIn ≈ 35`. Trades are mutually positive exactly when each side ships players whose cost to them is far below their value to the other.

Scoring trades by comparing VOR sums — the "trade value chart" approach — produces trades nobody accepts. **We never do that.**

## Decisions taken

| | |
|---|---|
| Views | My Team · League · Trade Finder (waiver/rankings fold in as context, not tabs) |
| Horizon | Rest of season |
| Suggestions | Mutual gain only (both lineups improve), ranked by my gain |
| Onboarding | Enter a Sleeper **username** → auto-discover every league. No league IDs, no password |
| Identity | Derived from Sleeper `owner_id === user_id` — no manual picker |

## Known blocker, and how we sequence around it

Identity is Sleeper-derived, and `api.sleeper.app` is blocked by this environment's egress policy. **The My Team and Trade Finder views cannot show real output until that is lifted.**

So: Phases 1–3 are fully buildable and testable today against fixtures and the seeded demo data. Phase 4 builds the UI. A **dev-only override** (`?asTeam=<teamId>` URL param, not a product affordance) lets us exercise and screenshot the views before real data exists. Phase 5 is the real connection.

Also worth stating plainly: **the engine is only as good as its projections.** Against the current synthetic rolling-average demo data, suggestions will be structurally correct but not actionable. Real value needs a real projection source (FantasyPros/nflverse, already on the roadmap).

---

## Phase 1 — Analysis engine (`src/analysis/`, pure + unit-tested)

No network, no identity, no UI. Plain ESM, no dependencies, `node:test`.

**`lineup.js`**
- `optimalLineup(players, rosterPositions, valueFor)` → `{total, assignments:[{slot, slotIndex, playerId, value}], unfilled, benched}`
- Max-weight bipartite matching (Hungarian, rectangular). Slots = `rosterPositions` minus `BN`; ≤10 slots × ≤15 players ≈ 1.5k ops, microseconds.
- Eligibility table: `FLEX→{RB,WR,TE}`, `SUPER_FLEX→{QB,RB,WR,TE}`, `WRRB_FLEX→{RB,WR}`, `REC_FLEX→{WR,TE}`, dedicated→itself.
- Greedy is optimal only when eligibility sets nest; real configs break that. Keep greedy as a **test oracle** (`greedy ≤ hungarian` always; equal on nested configs).
- Ineligible pairs get a large negative sentinel, **never `-Infinity`** (poisons Hungarian potentials to `NaN`). Pad with zero-value dummies so short rosters leave slots unfilled rather than failing.
- Deterministic tie-break `(value desc, position, playerId asc)` — non-determinism makes lineup deltas jitter and manufactures phantom trades.

**`value.js`**
- `restOfSeasonValue(player, projection, remainingWeeks)` = `base × remainingWeeks × availability(status)`; availability Active 1.0 / Questionable 0.92 / Doubtful 0.6 / Out `(R−1)/R` / IR 0.
- **Bye imputation is the highest-severity correctness issue here.** `projectedPoints` is 0 when `bye === true`; used raw, every bye player looks worthless and the engine screams "sell." Impute from positional rank among non-bye players and tag `projectionQuality: 'observed'|'bye-imputed'|'missing'`. Missing ≠ 0 — exclude and flag.
- Honest comment required in-file: `remainingWeeks` is a constant multiplier and **changes no ordering**. The real content is availability + bye imputation + readable season units. It does not capture future byes, schedule strength, return timing, usage trend, or playoff matchups.
- `replacementLevels(league, players, rosterSlots, valueFor)` — max of two estimators: best available at position (reuse **`computeWaiverWire()`** from `src/integrations/sleeper.js`), and a demand-rank fallback `D_pos = totalRosters × (dedicatedSlots + flexShare)` for when a position's waiver pool is empty.
- `marginalValue(roster, playerId, ...)` → `{mvIn, mvOut}` via lineup re-solves.

**`profile.js`**
- `teamProfile(team, roster, league, context)` → per position: `starterStrength` (+ `z` vs league mean/SD, FLEX occupants attributed to their real position), `fragility` (drop to next man up × injury risk), `surplus` + `surplusPlayers`, `unfilled`.
- Guard `SD === 0` (identical teams → `NaN` z poisons every ranking). `unfilled` must never report as `z = 0`.
- Feeds both "my weak spots, ranked" (ascending z + fragility) and "who has surplus where I'm thin."

**`trades.js`**
- `findTrades(myTeamId, league, context, opts)` → ranked suggestions.
- Unpruned at 12 teams × 15 players ≈ **158k packages / 317k matchings** — seconds, not milliseconds. Pruning ladder, each stage before any matching:
  1. Drop K/DEF from the *trade pool* (VOR ≈ 0; nobody trades them) but keep them **in the lineup solve** so totals stay right. Drop taxi, `VOR ≤ 0`, missing projections.
  2. Top-8 per side — mine by `VOR − mvOut` (surplus first), theirs by `mvIn(me, p)`.
  3. Positional complementarity gate (send from surplus, receive into need — both sides).
  4. Value-band gate on `|ΣVOR(out) − ΣVOR(in)|`.
  - Survivors ≈ 3–5k → well under 300ms. Memoize lineup solves on a sorted-playerId roster hash (2-for-2 packages share sub-rosters heavily). Guard with a `performance.now()` deadline, degrading to 1-for-1 + 2-for-1.
- Score by re-solving **both** lineups post-swap. Accept only `myGain > ε && theirGain > ε` with **ε ≈ 2.0 RoS pts** (not 0 — float noise and tie-flips fabricate wins). Plausibility guard `theirGain ≥ 0.5 × myGain`.
- Rank: `myGain` → `mutuality = min/max(gains)` → fewer players → fragility relief. Dedupe supersets (drop a 2-for-2 that beats none of the 1-for-1s inside it). Enforce roster-size legality on 2-for-1 (open spot, or model the drop and **say so**).

**`explain.js`**
- Returns **structured facts, never sentences** — the render layer templates prose.
- Suggestion exposes: `send[]`/`receive[]` (each with `ros`, `vor`, `mvIn`/`mvOut`, `wouldStart`, `lineupSlot`), `myGain`, `theirGain`, `mutuality`, before/after lineups both sides, `lineupChanges[]` (drives "X replaces Y in your FLEX for +9.4"), `rationale[]` (typed: `surplus`/`theirNeed`/`myNeed`/`theirSurplus`), `caveats[]`, `replacementLevels`.
- Every number must reconcile: `myGain` ties to `lineupChanges`, `marginalCost` is `mvOut`, `replacementRos` is the observed waiver best.

## Phase 2 — Connect flow: username → every league → identity

**No password, ever.** Sleeper's public API is unauthenticated and read-only — there is no login endpoint to call. A username is a public handle, not a credential. We never build a password field for a third-party service; if a platform later requires auth it is OAuth (Yahoo) or user-supplied tokens/cookies (ESPN), and those secrets stay server-side and **never** enter the shared artifact `db`, which every viewer can read.

One username unlocks both league discovery and team identity:

- `src/integrations/sleeper.js` — add:
  - `fetchUser(handle)` → `/v1/user/{handle}` → `{user_id, username, display_name}` (accepts username or user_id)
  - `fetchUserLeagues(userId, season)` → `/v1/user/{userId}/leagues/nfl/{season}` → every league that user is in
  - **Flag both as unverified** until a live response confirms the shape — same rule applied to the rest of the integration.
- Carry `roster.owner_id` through `normalizeTeams()` (currently discarded) and add `ownerId` to the `Team` typedef in `src/model/schema.js`.
- `loadAllLeagues(handle, season)` — resolve user → discover leagues → `loadLeague()` each → normalize. This is what makes multi-league real instead of manual.
- Store `{sleeperUsername, sleeperUserId}` in a `meta/identity` db doc (public handle + public id — not secrets). Resolve my team **per league** by `team.ownerId === sleeperUserId`; a user can own a different roster in each league.
- Handle the real failure cases explicitly: unknown username (404), a user in zero leagues this season, and a league where no roster matches the user id (they left mid-season).
- Dev-only `?asTeam=<teamId>` override remains, purely for pre-network verification.

## Phase 3 — Build step (single source of truth)

`artifact/dashboard.html` is a hand-written self-contained IIFE with no build step, so `src/analysis/*` can't be imported — and hand-mirroring guarantees drift.

- Author `artifact/dashboard.template.html` with an `<!--INJECT:analysis-->` marker.
- `scripts/build-artifact.mjs` concatenates `src/analysis/*.js` (strip `export`) into one `<script>` block → `build/dashboard.html`. Add `npm run build:artifact`.
- Publish `build/dashboard.html` **passing `url:` explicitly** to keep the existing artifact — the seeded 447-document database belongs to that artifact and a new one starts empty.
- Delete `availableOf()` from the artifact (duplicates `computeWaiverWire`) and replace every `starterTotal()` call with `optimalLineup().total`.

## Phase 4 — The three views

Keep the existing dark-console design tokens and shell; rebuild the information architecture.

- **My Team** — solved optimal lineup by slot; bench with next-man-up; positional strength bars (z vs league); weak spots ranked; surplus assets flagged as trade chips; fragility callouts.
- **League** — teams × positions **z-score heatmap** (diverging scale — load the `dataviz` skill before building it); team totals from `optimalLineup()`; click through to any team's profile.
- **Trade Finder** — two entry modes: *Fix my weaknesses* (engine picks targets) and *Shop a player* (select one of mine → who wants him, what comes back). Ranked suggestion cards showing send/receive, both gains, mutuality, and expandable before/after lineups. The expandable lineup diff is the trust-builder — without it nobody believes the output.

## Phase 5 — Real data

Once egress allows `api.sleeper.app`: enter the username, verify `fetchUser` / `fetchUserLeagues` / `owner_id` against live responses, confirm every league is discovered and identity resolves in each, then retire the dev override.

---

## Verification

1. `npm test` — engine unit tests, all pure, no network:
   - **lineup**: FLEX correctness; non-nested eligibility where greedy loses; property test `greedy ≤ hungarian` over random rosters; unfilled slots; tie determinism across repeated solves.
   - **value**: bye imputation (a bye star must not read as worthless); availability discounts; missing projection ≠ 0; replacement falls back to demand-rank when a waiver pool is empty.
   - **marginal**: `mvOut === 0` for a benched non-next-man-up; `mvIn ≠ mvOut` for the same player on two rosters.
   - **profile**: z-scores; `SD === 0` guard; `unfilled` distinct from `z = 0`.
   - **trades**: mutual-gain filter; ε rejects noise-level gains; superset dedupe; 2-for-1 roster legality; self-trade filtered.
2. **Golden test** over `scripts/demo-data.json` asserting a specific known-good trade appears with expected gains — catches silent regressions in the whole chain.
3. **Performance assertion** — `findTrades` on the 12-team worst case completes under 300ms.
4. **Visual pass** — commit `scripts/preview.mjs` (headless Chromium + stubbed db, generalizing the throwaway used this session) and screenshot all three views before publishing.
5. **Reconciliation check** — for a sampled suggestion, assert `myGain` equals the sum of its `lineupChanges` deltas. If the explanation doesn't add up to the score, the suggestion is not trustworthy.

## Critical files

| Path | Change |
|---|---|
| `src/analysis/{lineup,value,profile,trades,explain}.js` | New — the engine |
| `src/model/schema.js` | Add `Team.ownerId` |
| `src/integrations/sleeper.js` | Carry `owner_id`; add `fetchUser()` / `fetchUserLeagues()` / `loadAllLeagues()`; reuse `computeWaiverWire()` |
| `artifact/dashboard.template.html` | New — authored source, replaces hand-edited HTML |
| `scripts/build-artifact.mjs` | New — inline `src/analysis/*` |
| `scripts/preview.mjs` | New — headless screenshot harness |
| `test/analysis/*.test.js` | New — engine coverage |
| `src/projections/customModel.js` | Unchanged — still feeds `projectedPoints` |
