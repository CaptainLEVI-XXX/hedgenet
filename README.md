# HedgeNet

**Describe your downside. Explore a neural hedge simulation—and see the risk that remains.**

HedgeNet makes position sizing inspectable: set a budget, compare proposed
positions and all-in cost, then look inside the network that produced them.
Built for the **CreateOS × Stripe Projects hackathon**.

[**Try the hosted demo →**](https://01m55gps20t94024xvf546rg91-3000.app.sb.createos.sh)
· [Engineering reference](ENGINEERING.md)
· [Stripe Projects stack](https://projects.dev/s#v1:createos~project)

[![HedgeNet showing measured neural activations, a synthetic hedge, and remaining loss](assets/hedgenet-demo.png)](https://01m55gps20t94024xvf546rg91-3000.app.sb.createos.sh)

## Try it

1. Open the demo and choose **A drop in Bitcoin**.
2. Click **Build my demo hedge** to run the trained model on the synthetic fixture.
3. Move the budget slider to compare positions, cost, and remaining modeled loss.
4. Pause the neural replay to inspect measured activations, or open
   **Details & assumptions** for scenarios and model provenance.

The preset goes straight to numerical inference; it does not need Jev. If the
page reports that the sandbox is waking up, wait a moment and refresh.

**Demo scope:** the model serves a fixed synthetic BTC universe for **30 October
2026**, with fictional $60k/$80k settlement buckets and synthetic books. Cached
real Polymarket links are discovery references, not the simulated positions or
live hedge recommendations. Weather is illustrative. This is experimental
research, not financial advice: no trades, wallets, payments, or online training.

## Start with the risk, not an order ticket

An example description:

> I hold 0.2 BTC. I want protection if Bitcoin falls below $70,000 on October 30,
> 2026. My hedge budget is $1,000.

[Jev](https://typesafe.ai/) interprets custom descriptions into an exposure draft
and helps discover related events in a cached Polymarket catalogue. Discovery
helps you investigate the risk; it does not establish settlement compatibility
or automatically turn arbitrary text into a neural hedge.

Custom intake keeps your original description and requested date visible. It
does not replace them with the BTC example. Choose the separate demo explicitly
to explore neural position sizing with fictional markets.

The current local build also lets you **Read rules & live books** for a suggested
event: inspect its full published rules, fresh YES/NO best asks, supported fees,
and direct Polymarket links. This is market review, not a confirmed hedge or a
neural share recommendation. Selections expire after ten minutes; submit the
exposure again if they expire. This addition has not yet been deployed.

## What you get

| Capability | Why it matters |
| --- | --- |
| **Plain-language intake** | Jev structures your concern and surfaces related cached market links for investigation. |
| **Budget-sensitive BTC simulation** | A trained neural model proposes quantities; changing the budget reruns inference. |
| **Independent financial checks** | Deterministic code checks cost including fees, budget, depth, order minima, and scenario payoffs. |
| **Residual-risk view** | Compare the unhedged baseline with remaining modeled loss instead of treating a basket as guaranteed protection. |
| **An inspectable network** | See selected real inputs, learned weights, and measured activations from the completed forward pass. |
| **A meaningful no-hedge result** | Non-improving proposals are withheld rather than dressed up as recommendations. |

## How it works

### Request path: interpretation, discovery, and explicit demo inference

```text
+----------------------+     +-------------------+     +---------------------+
| Custom description   | --> | Jev exposure draft| --> | Cached Polymarket   |
| Original risk + date |     | + interpretation  |     | discovery links     |
+----------------------+     +-------------------+     +---------------------+
                                                        Not live positions

+----------------------+     +-------------------+     +---------------------+
| Explicit BTC demo    | --> | Trained neural    | --> | Independent checks  |
| Synthetic fixture   |     | quantity proposal |     | Cost, depth, losses |
+----------------------+     +-------------------+     +----------+----------+
                                                                 |
                                                                 v
                                                      Positions + remaining
                                                      loss + inference replay
```

The network uses **738 encoded inputs and 32 hidden units** to propose position
sizes, not to forecast prices. The interface shows a selected subset of features,
weights, and activations. Animated connections replay **measured inference**,
not live training or invented progress.

The financial evaluator uses canonical decimal strings and accounts for the
full cost of protection:

```text
Net loss = original loss + purchase cost including fees − payout
```

It preserves signed scenario gains and compares worst modeled loss against the
unhedged baseline. A proposal that fails constraints or does not improve risk
does not become a recommendation. The offline solver never silently substitutes
for the neural model on the request path.

### Training path: offline building, independent evaluation

```text
+----------------------+     +-----------------------+
| Trusted optimizer    | --> | Codex-authored training|
| Synthetic examples   |     | code inside CreateOS   |
+----------------------+     +-----------+-----------+
                                        |
                                        v
+----------------------+     +-----------------------+
| Experimental         | <-- | Independent host-side |
| checkpoint to serve  |     | financial evaluation  |
+----------------------+     +-----------------------+
```

Codex authored and ran training code in a CreateOS sandbox. Candidate numerical
outputs were checked outside the builder; generated candidate code did not run
on the developer's machine. Training is separate from serving—no Codex session,
code generation, or weight updates are needed for each demo request.

The served checkpoint is experimental, not evidence of general hedge quality.
See [evaluation results and scope](ENGINEERING.md#prototype-scope-and-evaluation)
for measured validation performance and unresolved held-out quality.

## CreateOS × Stripe Projects

[Stripe Projects](https://projects.dev/s#v1:createos~project) provisioned
**`createos/project` and `createos/free` only**: the CreateOS project and Free
plan. Jev and Codex were integrated separately; Stripe is not a payment or
trading integration here.

CreateOS supplied the sandbox for offline Codex training and hosts the deployed
Next.js frontend, API routes, and authenticated numerical model runtime. The
experimental numerical runtime uses
[Handwired](https://github.com/chenglou/handwired); its MIT notice accompanies
the deployed runtime.

## Where it is useful

- **Explore a BTC downside scenario:** compare the budget/cost/risk trade-off
  inside the fixed synthetic universe, without placing an order.
- **Understand neural position sizing:** inspect real inference rather than
  treating model output as an unexplained recommendation.
- **Investigate related prediction markets:** use custom-text interpretation
  and cached event links as a starting point for rule review, not proof of cover.

The intended product connects a confirmed exposure to compatible markets, fresh
books, neural sizing, and independent checks. That live-market chain is not
complete. Actual live hedges require new model-universe evidence as well as
rule compatibility, freshness, and confirmation—not merely a discovered link.

## Run locally

Use **Node 24 LTS** and **pnpm 12.4.2**.

```sh
git clone https://github.com/CaptainLEVI-XXX/hedgenet.git
cd hedgenet
pnpm install --frozen-lockfile
pnpm dev
```

Open http://127.0.0.1:3000. **A clone alone cannot run the neural model:** trained
weights are private, and inference needs separately prepared artifacts and a
configured runtime. The hosted app includes those artifacts. Local UI work and
offline financial checks do not require cloud credentials.

For this workspace with its verified private artifacts, stop `pnpm dev` and run
`pnpm dev:local`. It starts the authenticated numeric model on loopback port 8080
and the frontend on port 3000, using the same checkpoint without contacting
CreateOS for inference. Results explicitly report **local** execution. This is
not an automatic fallback and does not restore an unavailable hosted sandbox.
The command requires `.amp/in/web-deploy/model` and `.amp/in/serving`, prepared
through the existing verified model workflow; it does not download or train weights.
It loads server-side configuration from an optional root `.env`; custom intake
requires `JEV_API_KEY` and a prepared live catalogue. Market review also needs
network access to Polymarket's Gamma and CLOB APIs.

```sh
pnpm test
pnpm typecheck
pnpm demo:foundation
pnpm build:web
```

See [ENGINEERING.md](ENGINEERING.md#run-locally) for server-side Jev configuration,
catalogue setup, the older-Node wrapper, private model preparation, and deployment.
Never put credentials in browser bundles or public environment variables.

## Tech and project layout

**Next.js · React · TypeScript · Jev / TypeSafe · Handwired · HiGHS · CreateOS**

| Path | Responsibility |
| --- | --- |
| `apps/web/` | Interface, API routes, intake orchestration, and neural serving. |
| `packages/core/` | Exact financial accounting, scenarios, teacher, encoding, and decoding. |
| `packages/intake/` | Jev adapter, exposure drafts, discovery, and confirmation contracts. |
| `packages/venue/` | Polymarket catalogue, selected books, rules, fees, and freshness. |
| `packages/training/` | Synthetic datasets, isolated training, and remote numerical runtime. |
| `tools/` / `deploy/web/` | Local checks, catalogue tooling, and serving/deployment preparation. |
| `tests/` | Financial, intake, venue, training, and web regression checks. |

Read [CONTRIBUTING.md](CONTRIBUTING.md) before changing the code; the
[engineering reference](ENGINEERING.md) covers deeper contracts and experiments.
