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
`summarizeScenarioLosses`, plus `createValuationProblem` and `evaluatePositions`.
It also exports their template/observation and valuation/proposal input types.
Schemas reject unknown fields/versions and do not coerce strings into booleans
or numbers into monetary values.

Inputs use canonical decimal strings, not floating-point JSON numbers: `"0.1"`,
not `0.1`, `"1e-1"`, or `"0.10"`. Scalar inputs allow up to 12 integer and 12
fractional digits. Scenario money accepts up to 24 integer and 24 fractional
digits to preserve exact scalar products. Out-of-bound values reject; they are
not rounded silently. This representation limit does not establish a model's
supported financial range. Only explicitly supplied scenarios are scored;
completeness of a real market's state space remains a separate requirement.

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
