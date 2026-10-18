# HedgeNet engineering reference

Setup, runtime behavior, financial contracts, and experiment results.
For the product introduction and demo, see the [README](README.md).

## What it does

Crypto holders can describe the downside they fear, but turning that concern into
hedge quantities—and understanding the risk that remains—is harder. HedgeNet
makes that process inspectable:

- **Describe exposure:** Jev extracts a structured, editable draft from your text.
- **Set a budget:** the trained network proposes position sizes for the supported simulation.
- **Check the numbers:** deterministic code evaluates cost, constraints, payouts,
  and worst modeled loss. Non-improving baskets are not recommended.
- **Look inside the model:** the UI replays measured activations and learned
  weights. The animation is inference replay, **not live training**.
- **Explore related events:** open real Polymarket event links from the cached
  catalogue, clearly separated from the fictional simulation positions.

## Try it in a minute

1. Open the [demo](https://01m55gps20t94024xvf546rg91-3000.app.sb.createos.sh)—no password required.
2. Choose **A drop in Bitcoin**, then **Build my demo hedge**. The simulation runs
   automatically; there is no separate confirmation screen.
3. Change the budget to compare cost, positions, and remaining loss. Set it to
   zero to see the no-improvement outcome.
4. Pause the neural replay or open **Details & assumptions** for exact scenarios,
   model provenance, and a downloadable result.

Custom descriptions go through Jev; the preset and manual BTC entry do not need
Jev. Supported BTC fields feed the fixed synthetic simulation, not a live-market
hedge. The model uses fictional $60k/$80k settlement buckets for 30 October 2026.
Weather is an illustration, not a trained weather model.

The sandbox can sleep when idle. In-app requests retry its explicit wake-up
response for up to 20 retries, three seconds apart. If the first page itself says
“Sandbox is waking up,” wait a moment and refresh. Real application errors are
not automatically replayed. The public demo shares a limit of 10 intake/neural
requests per minute and 100 per day per process; counters reset on restart.

## How the pieces fit together

| Component | Responsibility |
| --- | --- |
| **Jev / TypeSafe** | Interpret exposure and judge cached discovery candidates. Its suggestions do not certify market compatibility. |
| **Neural model** | Propose quantities from encoded exposure, budget, books, and scenario payoffs. The demo supplies synthetic books. |
| **Deterministic evaluator** | Check budget, depth, order minima, costs including fees, and scenario losses independently of the model. |
| **Codex builder** | Author and iterate training code inside CreateOS, separately from user requests. |
| **CreateOS Sandbox** | Run generated training code; host the deployed Next.js app, backend routes, and authenticated numerical model runtime after serving preparation. |
| **Stripe Projects** | Provision the CreateOS project and Free plan: `createos/project` and `createos/free`. Jev and Codex were integrated separately. |

**Serving:** description → Jev draft → synthetic BTC problem → neural quantities
→ deterministic checks → positions, cost, remaining loss, and measured trace.
Preset/manual entry starts at the synthetic BTC problem.

**Training:** trusted optimizer examples → Codex-generated training code in
CreateOS → frozen candidate outputs → independent host-side financial evaluation
→ experimental checkpoint. The builder does not grade itself. No generated
candidate code runs on the developer's machine, and no training runs per request.

The numerical encoder has 738 features; the trained model has 32 hidden units.
The UI displays a selected subset of the actual features, activations, and
weights. Monetary truth uses canonical decimal strings:

```text
Net loss = original loss + purchase cost including fees − payout
```

The evaluator preserves signed scenario gains and compares worst modeled loss
with the unhedged baseline. The offline solver supplies training references; it
never silently replaces neural inference.

## Prototype scope and evaluation

| Capability | Current scope |
| --- | --- |
| Hosted web app, backend, and model | Running together in CreateOS Sandbox; public demo access, authenticated model endpoint. |
| Plain-language intake | Live Jev integration with provenance-bearing drafts; semantic accuracy is not established by access tests. |
| BTC simulation | Trained checkpoint, deterministic decoding/checks, budget updates, and real inference traces. |
| Market discovery | Cached Polymarket events with outbound links; not live executable recommendations. |
| Financial foundation | Asset-downside, capped-threshold, and conditional-loss rules; scenario construction and valuation. |
| Live-market hedging | Not connected end to end. Rule compatibility, fresh selected books, and confirmation remain necessary. |
| Weather | Illustrative UI and financial foundations; no trained weather checkpoint. |
| Model quality | Experimental. Statistical targets are advisory; exact financial and artifact checks remain mandatory. |

The selected candidate retained **51.2% of the teacher's improvement at the
median across 48 synthetic validation cases**, below the original 80% target.
It is served under the prototype's advisory-quality policy, not relabeled as
having passed that target. Held-out quality and real-market usefulness remain
unestablished. The detailed experiment record is below.

## Run locally

Use **Node 24 LTS** and **pnpm 12.4.2**. The Node version is recorded in
`.node-version`; the package manager and dependency versions are locked.

```sh
git clone https://github.com/CaptainLEVI-XXX/hedgenet.git
cd hedgenet
pnpm install --frozen-lockfile
pnpm dev
```

Open http://127.0.0.1:3000. Local development binds to loopback.

**A Git clone does not include the trained weights or provider credentials.**
The UI, weather illustration, and offline checks can run without cloud access;
BTC inference needs separately prepared private artifacts and a configured
CreateOS runtime. Use the hosted demo to try the complete synthetic BTC flow.

For custom-text intake, configure server-side `JEV_API_KEY` in the ignored root
`.env`, then run `pnpm catalogue refresh`. Never use `NEXT_PUBLIC_` for secrets.
Catalogue refresh reads the public Gamma API; user requests search the cache.

### Checks

```sh
pnpm test
pnpm typecheck
pnpm demo:foundation
pnpm build:web
```

These checks need no credentials or cloud compute. If your default Node is
older, you can run the checks without changing the system installation:

```sh
npx --yes --package=node@24 --package=pnpm@12.4.2 --call 'pnpm install --frozen-lockfile && pnpm test && pnpm typecheck && pnpm demo:foundation'
```

For reproducible local check records, use `pnpm lab:check <local-packet.json>`.
The [packet format and safety limits](CONTRIBUTING.md#recorded-local-verification)
explain what is captured. This is a trusted local verification runner, not the
Codex/CreateOS training controller. Private instructions, work packets
and generated evidence stay out of Git.

## Repository map

| Path | Contents |
| --- | --- |
| `apps/web/` | Next.js/React interface, API routes, intake orchestration, neural serving, and request guards. |
| `packages/core/` | Exact loss/scenario accounting, position valuation, teacher, feature encoding, and neural decoding. |
| `packages/intake/` | Jev adapter, exposure drafts, discovery, rule review, and confirmation contracts. |
| `packages/venue/` | Polymarket catalogue, selected books, rules, fees, and freshness checks. |
| `packages/training/` | Synthetic datasets, isolated training workflow, and remote numerical runtime. |
| `tools/` | Catalogue, laboratory checks, dataset/training, and serving/deployment preparation. |
| `deploy/web/` | Full-app Dockerfile and sandbox process launcher. |
| `tests/` | Financial, intake, venue, training, and web regression checks. |

## Deployment and engineering reference

### Prepare a private inference sandbox

With an authorized existing CreateOS sandbox, the original private checkpoint,
its neighboring candidate/mechanics artifacts, and the pinned Handwired checkout:

```sh
HEDGENET_SANDBOX_ID=your-existing-sandbox-id \
  node tools/prepare-serving.ts /absolute/path/to/checkpoints/checkpoint-0005.json
```

This is an explicit cloud operation: it resumes a sandbox with ingress disabled,
removes the builder's Codex session, uploads verified serving files, compares the
serving runtime with the original model inside CreateOS, and pauses it again.
It creates no new resource or public URL. **Do not run this preparation against
the sandbox hosting the public app.** Private registry/weights remain under
ignored `.amp/in/serving/`; they are not bundled into Git or the browser.

The private CLI-driven inference path verifies hashes, resumes/executes/pauses
the sandbox for each request, and serializes operations. A surviving operation
lock must be cleared only after confirming remote termination and sandbox pause.
This is different from hosted serving, which keeps the model process resident.
Numerical inference requires no generative-model call or new training; Jev intake
is separate. Compute charges and model-provider usage are separate.

### Package the hosted demo

`node tools/prepare-web-deploy.ts` creates an explicit source/model/catalogue
allowlist in ignored `.amp/in/web-deploy/`. It requires the prepared private
serving artifacts and pinned numeric runtime. Never upload the repository root
or add credentials to the bundle.

The generated Dockerfile serves the full Next app. Set these only on the server:

| Variable | Purpose |
| --- | --- |
| `JEV_API_KEY` | Custom-text exposure interpretation. |
| `HEDGENET_MODEL_URL` | Authenticated model service URL; external endpoints require HTTPS. |
| `HEDGENET_MODEL_TOKEN` | Internal model bearer token; never sent to the browser. |
| `HEDGENET_PUBLIC_ORIGIN` | Exact public HTTPS origin, without a trailing slash. |
| `HEDGENET_PUBLIC_DEMO` | Set to `true` only to intentionally allow anonymous demo access. |
| `HEDGENET_DEMO_PASSWORD` | Required for protected public mode when anonymous access is not enabled; username `demo`. |

For a CreateOS sandbox hosting both processes, install/build the allowlisted
bundle with Node 24 and pnpm 12.4.2, then run:

```sh
node --env-file=/external/private.env deploy/web/start-sandbox.mjs
```

The launcher serves Next on port 3000 and binds the authenticated numerical model
to `127.0.0.1:8080`. CreateOS ingress can also forward to loopback ports: the model
bearer token, not its bind address, protects inference. The launcher supplies
the local model URL and sandbox runtime configuration. No training or Codex
session starts with the web app. Keep the environment file outside the bundle.

`/api/health` checks web readiness, not model availability; model health is also
public. Never disable model authentication. Use one web replica for the existing
in-memory aggregate request limits. Hosted serving does not pause after each
request, but provider idle auto-pause can still apply. It can incur compute
charges. Build success alone does not establish a working public deployment.

On the 1 GB sandbox, building alongside the running app exhausted memory.
Build a separate release with enough free memory; retain the previous release
for rollback. No paid upgrade is implied by these instructions.

### Market catalogue

```sh
pnpm catalogue refresh
pnpm catalogue search "BTC"
pnpm catalogue search "London rain"
```

Refresh reads the public Gamma API without credentials and stores a gzip snapshot
under ignored `.amp/in/catalogue/`. Search reads local data only; it does not crawl
markets on the user path. `@hedgenet/venue` exports `refreshCatalogue`,
`loadCatalogue`, and `createCatalogueIndex`; keep the returned index in memory and
replace it only after a successful load/build. Search supports category filtering,
BTC/ETH aliases and at most 20 parent-event candidates. Results are discovery
matches, **not compatible hedges**. Unknown observation/source/protocol details
remain unknown; event end dates are not observation dates. Closed/unavailable
children cannot make an otherwise unavailable parent searchable.

Descriptions are bounded 1,024-character excerpts, explicitly marked when
truncated; a market's description hash covers the original text. Parents with
more than eight children retain counts, categories and title but no child-detail
subset (`structureStatus: too_many_markets`). They remain discoverable, not
silently reduced to eight buckets or declared semantically incompatible. Full
selected rules and identities must be fetched before financial use.

Refresh has a single-writer lock, 100-event pages, a 500-page invocation limit,
30-second request deadlines and a 120-second crawl-request budget. On failure or
limit exhaustion, rerun to resume persisted pages. Only a completed cursor walk
replaces last-good data; this is not a frozen point-in-time provider snapshot.
Checkpoints older than 24 hours restart. Searches report age from crawl start:
over 30 minutes is degraded, over 24 hours is expired with no candidates.
Missing/corrupt storage throws instead of masquerading as no market matches.

The CLI is one-shot, not an installed periodic worker. Future hosting must provide
the 10-minute refresh schedule, durable storage and backup explicitly. Atomic
rename protects readers from partial files, not disk loss. After a hard crash,
inspect `refresh.lock` and confirm its process is gone before removing the lock;
do not remove a live writer's lock. Synthetic/recorded sources require an explicit
fetch adapter and cannot resume live checkpoints.

### Selected order books

`fetchBookSnapshot(legs, { dataMode: 'live' })` reads one public batch for 1–16
trusted `{ legId, protocol: 'ctf', assetId, conditionId }` selections. Protocol v2
is explicitly unsupported at this boundary. Identity checks reject missing,
duplicate, unexpected or wrong-condition books; response order does not matter.
Empty asks mean zero depth, whereas a missing book is an error.

Snapshots retain raw responses, exact normalized decimal strings, order minimums,
ticks, venue timestamps/hashes and host fetch times. Asks sort ascending; bids
sort descending. The adapter does **not** apply the evaluator's 90% depth reserve
or infer fees. Financial fields outside the supported 12+12-digit range fail
rather than round; string spelling such as `"0.200"` normalizes to `"0.2"`.

Call `assertBooksFresh(snapshot)` again when producing a result. It checks the
content hash, at most five seconds of fetch span and at most 30 seconds since
fetch start. A venue timestamp is its update time, not our retrieval time. Hashes
detect drift, not authenticity: the server must own the trusted snapshot. Public
reads were exercised; use the selected-market boundary below to bind rules/fees.

### Rules, fees and selected-market snapshots

`fetchEventRules(eventId, { dataMode: 'live' })` retrieves full parent/child rule
text and a `rulesHash` for confirmation. The hash includes resolution material,
outcome identities and protocol fields, but excludes prices, volume, status and
fees. Financial configuration is re-read for each snapshot rather than frozen
at confirmation. Unknown observations remain `null`; end dates are not silently
treated as observation times.

`fetchMarketSnapshot({ eventId, expectedRulesHash, marketIds }, options)` re-fetches
that event, blocks changed rules or unavailable/unknown selected-market status,
then retrieves both YES/NO books for each of 1–8 explicit selected markets. It
joins outcomes by label even when Gamma returns NO first, verifies CTF identity,
and requires Gamma/book minimum size, tick and negative-risk flags to agree.
Unknown, contradictory or unsupported fees block; explicit disabled fees and
exponent-one taker schedules are supported. Numeric JSON fee/constraint tokens
are read exactly using Node 24's reviver source rather than rounded through JS
numbers. Full original event text is retained with the snapshot.

Recheck `assertMarketSnapshotFresh(snapshot)` at completion. The outer hash binds
rules, interpreted fees, selected legs and books; metadata must also be at most
30 seconds old. `MarketSnapshotError.code` distinguishes rule drift, unavailable
markets/fees, unsupported markets, changed constraints and provider/data errors;
input-schema and underlying book/network failures may also throw.

These are **host-owned indicative snapshots, not confirmed hedges**. Every result
retains `reviewStatus: needs_semantic_review`. Selecting several markets does not
establish that they form a complete numeric partition or share the user's exact
source, location, time and loss meaning. Jev/intake and scenario construction must
establish those separately. Reads are sampled, not transactional exchange state;
no price/fill guarantee, access permission or void/dispute handling is implied.

### Exposure interpretation

`@hedgenet/intake` exports `createJevClient({ apiKey })` and
`interpretExposure({ text, timezone, interpretedAt }, client)`. Supply the server's
`JEV_API_KEY` explicitly; the library does not read environment files. The adapter
uses the TypeSafe System One API, pinned `jev-1.13.0`, a five-second deadline and
no retries. It checks answer IDs, primitive types, all offered choices, finite
probability distributions, model identity and token usage. Provider failures
return `dependency_unavailable` for manual entry, not a market refusal.

One batched request assigns roles to exact source spans. Drafts retain offsets,
raw text, normalized decimal strings and the original judgments. The initial
0.80 probability / 0.20 margin suggestion policy is **not calibrated accuracy**;
every field remains unconfirmed. Supported loss formulas include asset downside,
capped threshold loss and conditional fixed loss, including weather. Missing
caps, negative holdings and unsupported path-dependent losses are not repaired
into a different exposure. Zero budget and negative temperature are valid.

Input is bounded to 4,000 characters and 30 spans. This first extractor recognizes
explicit English decimal amounts, date phrases and BTC/ETH/weather aliases.
Abbreviated/exponential amounts, other aliases and complete observation/source/
station details require manual clarification. Dates retain their wording: no
missing year or observation time is borrowed from a market's end date. A draft
is not a confirmed brief or a financial problem. One authorized live intake trial
verified API access and numeric roles; it is not a language accuracy evaluation.
Equivalent aliases such as BTC/Bitcoin combine their Choice probability mass
without merging distinct assets or losing source provenance. Local automated
checks make no paid calls.

`intakeExposure(input, { client, catalogue })` connects that draft to an already
loaded `createCatalogueIndex` instance. It retrieves up to 20 cached candidates,
judges at most five in one additional batch and returns at most three suggestions.
Amounts and date spans do not become lexical topic terms; unfamiliar category
tags do not exclude weather. A recognized observable is required in retrieved
events before the top-20 cutoff, so unrelated uses of “budget” cannot crowd them
out. Rain/rainfall/precipitation are discovery aliases only, not interchangeable
settlement rules. The full workflow has a ten-second shared deadline
and at most two model calls. Each call also retains its five-second limit.

Suggestions always say `needs_rule_review`. Relevance probabilities are not
coverage, settlement compatibility or event probabilities. Empty lexical search,
no semantic suggestion, unsupported event structure, expired catalogue and API
failure have distinct statuses; none claims an exhaustive absence of compatible
markets. Failure of the second call preserves the editable exposure draft.

### Confirmation and financial assembly

`createRuleReview(eventRules, { semantics, settlement, evidence })` records a
**trusted operator's normalization** of full venue rules. It checks canonical
market/YES/NO/condition identity and verbatim evidence for each selected market.
Numeric reviews must include the entire event, not a convenient subset. Excerpt
presence is not proof of interpretation: do not expose this function as an API
that lets a browser or model certify its own market rules. Automatic rule-text
interpretation and a review interface are still future work.

`confirmExposure(draft, request, review)` requires the current draft ID/revision,
explicit loss, budget and semantics, matching event/rules/review hashes, and
acknowledgments for financial fields, market rules, normal resolution only and
USD collateral parity. Observation instants normalize to UTC; source, observable,
unit, location, observation window/statistic and timezone must match exactly.
Incomplete data, mismatches, expired observations and invalid partitions block.
The caller must authenticate the user and retain the host-owned draft/review.

`assembleConfirmedValuation(confirmed, review, snapshot)` checks those bindings
again, enforces snapshot freshness, builds exact scenarios and joins every
canonical leg to its fresh book and fee schedule. It returns provenance plus a
`valuation-v1` problem for the independent evaluator; it neither sizes positions
nor claims neural eligibility. `reviseBudget` takes an expected revision and a
new exact budget, increments the revision and preserves confirmed semantics,
without calling Jev. The server must reject late results for an older revision.

Tests exercise asset downside, continuous-temperature and binary-rain scenarios
with synthetic rules/books. Rounded or discrete temperature markets, voids,
disputes, depeg and real execution are not covered by this modeled guarantee.
Hashes detect content drift, not authenticity or correct interpretation.

### Intended live-market architecture (not the current demo)

**User requests:** Jev interprets exposure → the backend selects compatible
cached markets and fetches fresh books → an accepted neural model in CreateOS
proposes positions → independent financial code validates the proposal.

**Builder training:** Codex writes/edits training code in CreateOS → bounded
experiments use optimizer-generated examples → a fixed external evaluator checks
the frozen candidate → the host controller records its result. Codex cannot edit the
authoritative evaluator or final test labels. No code generation or training
happens per user request.

CreateOS compute, Codex subscription allowance, and Jev API usage are separate.
Codex CLI 0.160.0 successfully completed device login inside the sandbox and
authored and ran the training code using ChatGPT subscription authentication, not
an OpenAI API key. Three candidates completed. Serving preparation removes that
session; running numeric inference needs no generative-model credentials.
Remaining subscription quota and compute credit balance are unknown.

### Core contracts

`@hedgenet/core` exports `LossTemplateSchema`, `ObservationSchema`, `lossAt`, and
`summarizeScenarioLosses`, `buildScenarios`, `createValuationProblem` and
`evaluatePositions`, with the associated input and scenario-location types.
Schemas reject unknown fields/versions and do not coerce strings into booleans
or numbers into monetary values.

Inputs use canonical decimal strings, not floating-point JSON numbers: `"0.1"`,
not `0.1`, `"1e-1"`, or `"0.10"`. Scalar inputs allow up to 12 integer and 12
fractional digits. Scenario money accepts up to 24 integer and 24 fractional
digits to preserve exact scalar products. Out-of-bound values reject; they are
not rounded silently. This representation limit does not establish a model's
supported financial range. Only explicitly supplied scenarios are scored;
completeness of a real market's state space remains a separate requirement.

### Scenario construction

`buildScenarios(loss, settlement)` consumes a loss template and strict
`settlement-v1` rules. A `binary` settlement must match a conditional loss's exact
`conditionId`. A `numeric_partition` requires `domain: continuous` and 3–8 buckets
with unique `marketId`, `yesLegId`, `noLegId`, and `lower`/`upper` bounds. Each bound
is `{ value, inclusive }`, or `null` for an infinite end. Asset partitions cover
[0, +∞); threshold partitions cover the whole real line. Gaps, overlaps, missing
tails, duplicate identities and unsupported measurement domains reject.

The `scenarios-v1` result retains parsed loss/settlement, states with locations and
losses, and YES/NO payouts keyed by state ID. Buckets are sorted canonically;
states follow position order within each bucket. A boundary belongs to exactly
one bucket; its opposite one-sided limit retains the neighboring payout. Singleton
outcomes are preserved. No floating epsilon or finite chart range defines risk.

`numeric` locations have a `value` and `side: at | below | above`; `tail` locations
name a direction. `loss_cap` denotes the exact threshold ± cap/rate breakpoint
using the returned loss template, without rounding a recurring fraction.
All supported numeric losses are continuous and piecewise linear, so endpoints,
limits and breakpoints capture every payoff region's extrema. Worst loss includes
the supremum where an open endpoint is not attained. At most 18 numeric states
are produced under these limits; they fit the evaluator's 32-state maximum.

Pass `{ stateId, originalLossUsd }` from generated states to the valuation problem
and join generated legs to trusted books/fees **by leg ID**. The scenario builder
does not verify observation time, source, location, rule provenance or void/dispute
outcomes. Discrete/rounded measurement semantics need their own explicit support.
These results are not proof of live hedge eligibility.

### Position valuation

The server calls `createValuationProblem` with trusted `valuation-v1` inputs:
USD budget, data mode, snapshot ID, rules hash, 1–32 named scenario losses and
1–16 legs. Each leg supplies minimum size, explicit fees, raw asks (at most 1,000)
and a 0/1 per-share payout for every scenario. A missing book or fee is invalid;
an explicitly empty book means zero capacity. These inputs are not supplied by
the position proposer. The returned SHA-256 binds the parsed snapshot; it does
not establish authenticity or freshness.

`evaluatePositions(problem, proposal)` requires `positions-v1`, the matching
`valuationHash`, and one `{ legId, shares }` for every leg, including zeros. Shares
are canonical nonnegative whole-number strings (up to 12 digits). Extra fields,
duplicate/unknown/missing identities and changed problem contents reject.

Equal-price asks are merged, sorted ascending and limited to the three cheapest
distinct levels. Each size is multiplied by 0.9 and floored once before filling.
Explicit fee-free legs cost only premium. Exponent-one curves use
`shares × rate × price × (1 − price)`, with each consumed level's fee rounded up to
five decimals under `ceil-5dp-per-level-v1`. This is our declared **level-based fee
estimate**, not exact venue rounding or a bound across unknown match fragmentation.
No positive budget tolerance or silent position repair applies.

Results include fills, premiums, estimated fees, total cost, scenario payouts and
net losses, provenance and policy IDs. `improvesModeledRisk` means at least $0.01
less worst modeled loss; it is **not** permission to display a live recommendation.
Feasible harmful baskets retain negative improvement instead of being hidden.
This server-side valuation slice is not the full future hedge/model contract.

### Offline training reference

`await solveTeacher(problem)` uses pinned HiGHS 1.15.3 to minimize worst net loss
including purchase cost, then minimize cost among risk-equivalent baskets. It
enforces whole shares, order minima, reserved three-level depth and cheaper-level
fills. Both phases must return `Optimal`; the separate exact evaluator must accept
the positions. Timeout, malformed output or solver failure throws rather than
creating a zero-position training label. A genuinely optimal no-hedge answer is
valid and retains its zero improvement.

This is a **conservative discretized reference, not an exact financial optimum**.
Each share's premium and fee are rounded up separately to $0.00001, scenario loss
is rounded up, and budget is rounded down. This bounds the evaluator's declared
level-fee estimate, not real exchange execution. Near a budget boundary it can
exclude an otherwise feasible share. Results distinguish reference risk/cost
from independently evaluated risk/cost and retain input binding, solver settings,
phase model hashes and elapsed time. They cannot replace neural output silently.

The adapter rejects more than 1,000,000 reserved shares per leg, or encoded
monetary values/aggregate full-depth cost above 1,000,000,000,000 ticks ($10 million).
These are solver representation limits, not an accepted model's support bounds.
Each phase has a native two-second limit, zero MIP gap and fixed seed 17.
The WASM solve is synchronous and blocks its calling thread; loading, parsing and
checking are outside that native limit. Run it offline under an outer process
deadline, not in a request handler. No neural training or cloud compute is
performed by this function.

### Neural proposal decoding

`decodeNeuralProposal(problem, expectedModel, response)` accepts only finite
normalized outputs for the exact ordered real legs. The host supplies the expected
`modelVersion`, `weightsHash`, `featureVersion: features-v1`, and `contractHash`;
the response must match those and the valuation hash. Changed budgets, stale
problem bindings, extra padded outputs and swapped identities reject.

The decoder clamps outputs to [0, 1], multiplies by reserved capacity, floors to
whole shares and drops subminimum orders. If full size exceeds the exact budget,
32 bisection steps scale all quantities down together, checking full fees and
cost each time. It never tops up, swaps instruments or calls the teacher. Repair
details and original outputs are retained. Harmful or sub-cent-improvement baskets
return `no_improvement` with their actual financial result, not a substituted
zero or solver basket. `improvement` means modeled loss falls by at least $0.01,
not that a live recommendation is authorized.

This boundary does not verify an accepted artifact, feature support, freshness,
session ownership or request ordering. The future host must supply those gates
and reject late runs; hashes alone are not authenticity. No model is trained or
executed by this function.

### Frozen neural inputs

`createFeatureContract` binds `features-v1`, one rules hash, canonical real-leg
IDs, a USD loss scale of at least 1, and 738 explicit normalized decimal ranges.
`encodeFeatures(problem, contract)` checks those bindings and the scenario
builder's `state-0`, `state-1`, … ordering. Scenario count and loss values may vary
within the declared ranges; changing the event/rules or leg ordering cannot.

The encoder produces 738 FP32 values: budget/maximum loss, 32 losses, 32 state
masks, a 16×32 leg-major payout matrix, and ten fields per leg (availability, fee
rate, minimum, whole-share step and three price/size pairs). Money and quantities
use the same frozen scale; padded slots are zero. Depth is merged and reserved
once. Decimal range checks happen **before** FP32 conversion, without clamping
the exposure. Returned hashes bind the valuation, contract and ordered IDs.

Freeze these ranges before training; do not widen them to admit a failing test
case. Range membership does not prove distribution coverage. Full template/
exposure support, accepted weights, dataset splits and model-quality gates remain
separate requirements. These functions prepare numerical inputs, not a trained
network or a market forecast.

### Grouped training data

Run `node tools/prepare-dataset.ts crypto --development` for 16 development
examples, then `node tools/prepare-dataset.ts crypto` or `weather` for the frozen
192-example synthetic experiment. Each of 24 independent book-seed groups stays
entirely in one split: 96 training, 48 validation and 48 test examples.

The teacher runs in a terminable worker with a 15-minute outer deadline. Every
attempt is retained; rejected labels make the dataset incomplete, not zero-labeled.
Private artifacts live under `.amp/in/artifacts/datasets/`. Only the explicit
`builder/` files contain transferable train/validation features, targets and masks;
`host-only.json` and the complete attempt log must never go to the coding agent.
Development seeds are disjoint from the main experiment.

`scorePredictions` applies the trusted decoder and financial evaluator to every
example, including invalid, zero and harmful predictions. It reports feasibility,
retained improvement and normalized risk gap with fixed nearest-rank quantiles.
`passed` now means every decoded result is feasible; `qualityThresholdsMet` retains
the original quality comparison as advisory evidence. Passing is **not** artifact
acceptance or promotion. Synthetic books establish no live market coverage.

### Bounded Codex/CreateOS experiment

`tools/run-training.ts` supervises an existing builder sandbox through the CreateOS
CLI. It requires `HEDGENET_SANDBOX_ID`, authorized ChatGPT device login, prepared main
and development datasets, and the pinned Handwired reference checkout. Invoke it as
`node tools/run-training.ts crypto <main-dataset-directory> <development-directory>`
only with a fresh experiment authorization. It resumes compute and changes egress.

Codex authors candidate source inside CreateOS. The host independently scores
downloaded numerical outputs and controls checkpoint selection and early stopping.
No generated candidate code executes on the host. Final labels stay outside the
builder. A passing numerical report is not promotion; timeout, failed checks or
incomplete cleanup cannot enable serving. This is a single-owner research workflow,
not an adversarial multi-tenant security boundary.

The first synthetic crypto experiment produced three mechanically valid candidates,
each feasible on all 48 validation cases. Median retained teacher improvement was
47.3%, 52.5% and 51.2%, versus the original 80% target. All were rejected under
the original policy before held-out evaluation. The owner subsequently made
quality advisory for the prototype; the selected third candidate is served as
experimental, without relabeling those historical results as passing. Held-out
quality remains unestablished; weather was not trained.

## References and contribution

The previous [PolyHedge](https://github.com/CaptainLEVI-XXX/polyhedge) informs the
module organization, cached-market approach and premium-inclusive objective.
Reference inspected: [source revision](https://github.com/CaptainLEVI-XXX/polyhedge/commit/b22a3c989ea3d209010eafacac7f2e62391e9639).
No upstream application source has been copied into this foundation.
[Handwired](https://github.com/chenglou/handwired) supplies the remote experimental
circuit runtime, pinned to [this revision](https://github.com/chenglou/handwired/commit/257856e3b221140acb4cc4460626b850c0bd4ff1).
Its MIT notice accompanies the runtime in the sandbox. Model weights remain local
private artifacts; no upstream application source is shipped here.

Read [CONTRIBUTING.md](CONTRIBUTING.md) before making changes. Stripe's submission
checker requires both `.projects/state.json` and `.projects/state.local.json`;
the committed files contain service and project-identification metadata. Review
CLI-generated updates before committing them. Credentials, `.env` files, the
vault/cache, private model artifacts, and internal plans stay out of Git. Do not
force-add ignored files.
