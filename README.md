# HedgeNet

**Describe your risk. Explore your hedge.**

HedgeNet is a research prototype for neural hedge construction, starting with
prediction markets. It models potential losses; it does not place trades,
provide insurance, or guarantee protection.

## Current implementation

The financial foundation is implemented. It supports three explicit loss rules:

- **Asset downside:** units held × the positive drop below a reference price.
- **Threshold loss:** cost per unit above/below a threshold, capped at a confirmed
  maximum. Signed observations support cases such as temperature.
- **Conditional loss:** a fixed loss if an exactly identified condition occurs.

The scenario accounting function calculates **original loss + total cost − payout**
for each supplied state. It preserves signed gains and compares worst modeled
loss with the no-hedge case. The independent position evaluator now derives cost
and payouts from trusted books, fee schedules and named scenario payoffs. It
rejects positions exceeding reserved depth, minimum-size rules or the exact budget.
It does not select positions or establish market compatibility, complete scenario
coverage, quote freshness or model eligibility. Those checks remain necessary
before any proposal can be recommended.

The scenario builder now derives losses and payouts for matching binary conditions
or complete continuous numeric partitions, including boundary limits and tails.
This establishes coverage under supplied normalized rules, not that those rules
faithfully describe a live market or the user's exposure.

Public market discovery now has a persisted categorized catalogue and local
search. Selected CTF order books can also be read and checked for identity,
precision and freshness, and bound to full rule text, current status and explicit
supported fees. Jev now has a bounded, validated adapter and provenance-bearing
exposure drafts, tested with synthetic responses and one live intake trial.
An offline optimizer now produces independently checked training references.
There is **no complete
live hedge flow, trained model, Codex training harness, or production website yet**. The included
crypto/weather financial demo is synthetic; it makes no execution claim.

## Run locally

Use **Node 24 LTS** and **pnpm 12.4.2**. The Node version is recorded in
`.node-version`; the package manager and dependency versions are locked.

```sh
pnpm install --frozen-lockfile
pnpm test
pnpm typecheck
pnpm demo:foundation
```

These commands need no credentials or cloud compute. If your default Node is
older, you can run the checks without changing the system installation:

```sh
npx --yes --package=node@24 --package=pnpm@12.4.2 --call 'pnpm install --frozen-lockfile && pnpm test && pnpm typecheck && pnpm demo:foundation'
```

For reproducible local check records, use `pnpm lab:check <local-packet.json>`.
The [packet format and safety limits](CONTRIBUTING.md#recorded-local-verification)
explain what is captured. This is a trusted local verification runner, not the
planned Codex/CreateOS training controller. Private instructions, work packets
and generated evidence stay out of Git.

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

## Intended architecture

**User requests:** Jev interprets exposure → the backend selects compatible
cached markets and fetches fresh books → an accepted neural model in CreateOS
proposes positions → independent financial code validates the proposal.

**Builder training:** Codex writes/edits training code in CreateOS → bounded
experiments use optimizer-generated examples → a fixed external evaluator checks
the frozen candidate → the builder accepts or rejects it. Codex cannot edit the
authoritative evaluator or final test labels. No code generation or training
happens per user request.

CreateOS compute, Codex subscription allowance, and Jev API usage are separate.
Subscription authentication inside the sandbox has not been verified yet.

## Core contracts

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

## References and contribution

The previous [PolyHedge](https://github.com/CaptainLEVI-XXX/polyhedge) informs the
module organization, cached-market approach and premium-inclusive objective.
Reference inspected: [source revision](https://github.com/CaptainLEVI-XXX/polyhedge/commit/b22a3c989ea3d209010eafacac7f2e62391e9639).
No upstream application source has been copied into this foundation.
[Handwired](https://github.com/chenglou/handwired) inspires the planned trainable
circuit; it is not integrated yet.

Read [CONTRIBUTING.md](CONTRIBUTING.md) before making changes. Credentials, local
provider state and internal plans stay out of Git. Do not force-add ignored files.
