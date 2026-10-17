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

There is **no live market integration, trained model, Codex training harness,
Jev integration, or production website yet**. The included crypto/weather demo is
synthetic; it makes no optimality or execution claim.

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

## References and contribution

The previous [PolyHedge](https://github.com/CaptainLEVI-XXX/polyhedge) informs the
module organization, cached-market approach and premium-inclusive objective.
Reference inspected: [source revision](https://github.com/CaptainLEVI-XXX/polyhedge/commit/b22a3c989ea3d209010eafacac7f2e62391e9639).
No upstream application source has been copied into this foundation.
[Handwired](https://github.com/chenglou/handwired) inspires the planned trainable
circuit; it is not integrated yet.

Read [CONTRIBUTING.md](CONTRIBUTING.md) before making changes. Credentials, local
provider state and internal plans stay out of Git. Do not force-add ignored files.
