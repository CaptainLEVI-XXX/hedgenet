# Contributing to HedgeNet

HedgeNet aims to turn a description of financial risk into a proposed hedge using
available prediction-market instruments. It is a research prototype, not an
investment adviser or an automated trading service.

## Product boundaries

- Jev structures the user's exposure and assesses relevant market candidates.
- A cached, categorized Polymarket catalogue supports market discovery; executable
  quotes must be checked for freshness and available liquidity.
- A neural model proposes positions inside a CreateOS sandbox. Training is a
  separate workflow, not a job repeated for every user request.
- A builder-controlled Codex agent writes and improves training code. Its edit
  access excludes the authoritative evaluator, final test labels and promotion
  state. Agent-written tests supplement, rather than replace, independent checks.
- Independent financial checks validate proposed positions, cost, constraints,
  and scenario payoffs. Model output alone is not evidence of a valid hedge.
- The interface shows coverage, remaining exposure, assumptions, and limitations.
  If suitable markets do not exist, say so rather than inventing protection.
- The initial product does not place trades, connect wallets, or move user funds.
  Stripe Projects provisions infrastructure; it is not a trading or payment flow.

## Local setup

Use Node 24 LTS and pnpm 12.4.2. Run `pnpm install --frozen-lockfile`, `pnpm test`,
`pnpm typecheck`, and `pnpm demo:foundation`; the [README](README.md) includes an
alternative when the system Node version is older. The current implementation
is a financial foundation with synthetic fixtures, not a running hedge service.
No credentials are needed for these checks.

Keep credentials in a local environment file or the deployment provider's secret
settings. Configure Jev and CreateOS credentials only on the server side. Never
put them in browser bundles, public environment variables, screenshots, logs, or
issue descriptions. Document required variable names and their purpose in the
README without real values.

Do not copy another contributor's Stripe Projects state or credentials. Use your
own authorized setup. Ask the project owner before provisioning paid resources,
changing shared infrastructure, or deploying. Paused CreateOS sandboxes can still
incur memory and storage charges.

## What belongs in Git

Commit product source, dependency manifests and lockfiles, useful public
documentation, and tests with synthetic or properly sanitized fixtures.

Keep these local; `.gitignore` excludes them:

- All `.env` and `.env.*` files, including `.env.example`, plus `*.env` variants.
- The entire `.projects/` directory, including provisioning state and its vault.
- Internal product/preparation documents and `docs/implementation/`.
- Local `AGENT.md`, `AGENTS.md`, `HARNESS.md`, and lab packets/decisions in `docs/`.
- Root `stages/`, `plans/`, and `implementation/` directories.
- Preparation mockups in `mockups/` and scratch/review files in `.amp/in/`.
- Dependencies, generated build output, and machine-local files.

Keep new internal plans in the excluded directories. Do not force-add excluded
files. Ignore rules do not protect secrets in arbitrary filenames, and they do
not remove files that Git already tracks.

## Development workflow

1. Work only on `main`; do not create additional branches or worktrees. Commit
   completed work feature by feature with short, descriptive messages. Keep
   changes small and avoid unrelated cleanup. Pushing requires separate approval.
2. Preserve the separation between exposure interpretation, market data, neural
   inference, independent validation, and presentation.
3. Add or update tests for observable behavior. Use synthetic exposures and
   market snapshots; never real customer financial data.
4. Run the relevant checks. For financial changes, include budget boundaries,
   unavailable markets, stale quotes, liquidity limits, and residual loss where
   applicable. Evaluate neural results against the optimizer baseline; do not
   silently substitute optimizer results for neural inference.
5. For visual changes, inspect the running interface at relevant viewport sizes
   and in loading, success, and no-match/error states. Label mock data explicitly.
6. Describe what changed, why, what was verified, and any remaining limitations
   in the pull request. State when external-service checks were not run.

Keep training reproducible: record seeds, data provenance, model versions, and
evaluation results. Do not commit private datasets or large generated checkpoints
without agreeing on their storage and distribution first.

## Before committing or pushing

Review the exact files and content, not just whether tests pass:

```sh
git status --short --untracked-files=all
git diff --cached --name-status
git diff --cached
```

Verify local-only paths are ignored when changing ignore rules:

```sh
git check-ignore -v .env .projects/state.json docs/implementation/00-system-contract.md
```

Never use `git add -f` to bypass these exclusions. If a private file was already
tracked, stop and remove it from tracking before publishing. If a secret was
committed or exposed, revoke/rotate it; deleting the current file does not remove
it from Git history. Coordinate any history rewrite with the repository owner.

Do not push, publish, deploy, or run paid/shared-service operations without the
project owner's authorization. Report security issues privately rather than
posting credentials or exploitable details in a public issue.
