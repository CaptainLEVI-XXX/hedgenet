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
Stripe Projects also requires `.projects/state.json` and `state.local.json` for
the service stack and project identification. These CLI-generated files contain
project, account, and resource IDs. Review every update for credentials before
committing; configuration or redirect fields must not expose secrets.

Keep these local; `.gitignore` excludes them:

- All `.env` and `.env.*` files, including `.env.example`, plus `*.env` variants.
- Everything in `.projects/` except those two state files, including vault and cache.
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

## Recorded local verification

For consequential work, record the question, prediction, counterexample, baseline
and fixed assumptions before checking the candidate. The optional local runner
captures tests → typecheck → synthetic demo with source hashes, a pre-run source
copy, bounded output and actual exit statuses. It needs Node 24 and macOS/Linux.

Save a packet such as this to an ignored path, e.g. `docs/lab/check.json`:

```json
{
  "schemaVersion": "lab-packet-v1",
  "id": "foundation-check",
  "mode": "evaluate",
  "question": "Does this candidate preserve the financial foundation?",
  "prediction": "All existing checks pass without source changes.",
  "disconfirmingEvidence": "A financial regression, incomplete check or source drift.",
  "requirements": ["Existing core tests and synthetic demo remain valid."],
  "assumptions": ["Trusted local code; synthetic data; installed locked dependencies."],
  "baseline": "The same three commands run directly on the same candidate.",
  "evidence": ["tests/core/", "tests/fixtures/exposures.ts"],
  "suite": "foundation",
  "budgetSeconds": 180
}
```

Run `pnpm lab:check docs/lab/check.json`. Only the `foundation` suite is supported;
packets cannot supply commands. Budget must be an integer from 1 to 180 seconds.
Inspect the printed `.amp/in/artifacts/lab/` result path and logs. Later checks
are skipped after failure; interruption/timeouts never count as passed. Correcting
a candidate creates a new run rather than replacing the failed evidence.

This is **trusted local execution, not a sandbox**. The child can read local files
and use the network. Do not run untrusted generated training code through it.
Environment variables are allowlisted and credential filenames are excluded from
snapshots, but arbitrary secrets in source/packets/logs are not automatically
redacted. Review before sharing. Source snapshots exclude installed dependencies,
private docs and source roots not listed in `tools/lab.mjs`.

`checks_passed` is not independent model evaluation, acceptance or release. Record
the hypothesis decision and limitations separately. Model training, held-out
financial grading and promotion still require their own controller and controls.

## Before committing or pushing

Review the exact files and content, not just whether tests pass:

```sh
git status --short --untracked-files=all
git diff --cached --name-status
git diff --cached
```

Verify local-only paths are ignored when changing ignore rules:

```sh
git check-ignore -v .env .projects/vault/vault.json docs/implementation/00-system-contract.md
```

Never use `git add -f` to bypass these exclusions. If a private file was already
tracked, stop and remove it from tracking before publishing. If a secret was
committed or exposed, revoke/rotate it; deleting the current file does not remove
it from Git history. Coordinate any history rewrite with the repository owner.

Do not push, publish, deploy, or run paid/shared-service operations without the
project owner's authorization. Report security issues privately rather than
posting credentials or exploitable details in a public issue.
