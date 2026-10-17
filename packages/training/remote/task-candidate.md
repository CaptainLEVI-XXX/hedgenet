You are the training-code author for HedgeNet attempt {{ATTEMPT}} of at most 3.
You have a hard 5-minute wall-clock limit for this whole session. Be direct: write
the files, run a quick self-check, then stop. Do not start long training runs.

Working directory: {{CANDIDATE}} (write ONLY here). Read-only inputs:
- {{WORK}}/runtime/numeric-ui-core.ts — pinned Handwired runtime (MIT, see
  {{WORK}}/runtime/LICENSE, revision 257856e3b221140acb4cc4460626b850c0bd4ff1).
  Import it as `../runtime/numeric-ui-core.ts` (a symlink next to your directory). No other dependencies; no npm installs.
- {{WORK}}/runtime/reference-model-example.ts — upstream example (same license) of a
  graph with trainable parameter source cells, `multiply`, `roundAffine`, `reglu`,
  `evaluateReference`, `backpropagateReference` and host-side Adam. It predates
  branded wires: pass wires via `circuit.source(i)` / `asWire(i)` instead of raw numbers.
- {{WORK}}/data/development.json — 16 rows `{id, features[738], targets[16], mask[16]}`.
- {{WORK}}/data/train.json, {{WORK}}/data/validation.json — same row format.
Runtime: Node 24 runs .ts directly (type stripping: no enums/namespaces/parameter properties).
{{PREVIOUS}}
## Required files (TypeScript, ES modules)

### model.ts
Network: 738 inputs -> H hidden ReLU units -> 16 linear outputs, built as ONE Handwired
`Circuit` whose source cells are [parameters..., features...]. Parameter layout (fixed):
W1[h*738+f] for h<H,f<738; then b1[H]; then W2[o*H+h] for o<16,h<H; then b2[16].
parameterCount = 738*H + H + 16*H + 16. Declare feature cells with `assumeRange(...,0,8)`
before use so `multiply(weight, feature)` lowers to one reglu.
Exports:
- `initializeParameters(hidden: 8|32, seed: number): Float32Array` — deterministic seeded
  small centered weights, biases exactly 0.
- `createNetwork({hidden, parameters?}): Network` where Network has
  `hidden`, `parameterCount`, `getParameters(): Float32Array` (copy), `setParameters(p)`,
  `predict(features): number[]` (16 values, via `circuit.createTensorEvaluator`, built once),
  `predictReference(features): number[]` (16 values, via `circuit.evaluateReference`),
  `lossAndGradient(features, targets, mask): {loss: number, gradient: Float64Array}` using
  `circuit.backpropagateReference`. Loss = sum_j mask_j*(y_j-t_j)^2 / sum_j mask_j, and
  exactly 0 with zero gradient when the mask is all zero. Gradient is d loss / d parameter.

### train.ts — `node train.ts <config.json>`
Config: `{seed, hidden, learningRate, maxEpochs, batchSize, trainPath, validationPath,
outDir, controlDir, checkpointEvery, waitForControl}`. Seeded shuffling each epoch;
mini-batches of `batchSize`; average gradients over the batch; Adam (beta1 0.9, beta2 0.999,
eps 1e-8). Do not change the loss, features, targets or outputs.
1. Before training write `${outDir}/initial.json` =
   `{schemaVersion:"hedgenet-weights-v1", hidden, parameterCount, parameters:number[]}`.
2. After every `checkpointEvery` epochs (epoch counted from 1) atomically write (temp file +
   rename) `${outDir}/checkpoint-EEEE.json` (EEEE = epoch zero-padded to 4 digits):
   `{schemaVersion:"hedgenet-checkpoint-v1", epoch, hidden, learningRate, seed, parameterCount,
   trainLoss, parameters:number[], validation:[{id, values:number[16]}]}` where trainLoss is the
   mean example loss that epoch and validation lists EVERY validation row in file order with
   `predict` outputs. Print one JSON progress line to stdout.
3. If `waitForControl` is true, then poll every 250 ms for `${controlDir}/control-EEEE.json`
   (`{"action":"continue"}` or `{"action":"stop"}`) for at most 180 s. Continue training on
   "continue"; exit 0 on "stop"; exit 3 on timeout. Never write control files yourself in
   the real run. If false, keep going without waiting. After `maxEpochs` exit 0 (when waiting,
   wait for the final control file first). Stop with exit 4 on any non-finite loss/parameter.

### predict.ts — `node predict.ts <weights.json> <inputs.json> <out.json>`
Inputs: `[{id, features[738]}]`. Load weights (format above, also accept a checkpoint file),
write `{schemaVersion:"hedgenet-predictions-v1", predictions:[{id, values:number[16]}]}` in
input order using `predict`. Must not read training/validation files.

### attempt-config.json
`{"hidden": 8|32, "learningRate": 0.0003|0.001|0.003, "maxEpochs": <multiple of 5, <=120>,
"rationale": "..."}`. {{CONFIG_RULE}}

### NOTES.md — 5 lines max: what you built and what you checked.

## Self-check (keep under ~60 s of compute)
Briefly confirm on 2-3 development rows: finite outputs; predict vs predictReference agree
within 1e-4; one central-difference gradient check; a 2-epoch `waitForControl:false` run on
development data into a scratch dir under {{CANDIDATE}}/scratch writes initial + checkpoint
files. A separate fixed harness written by the builder re-checks gradients, reference
agreement, serialization and development learning; trusted financial validation happens
outside this sandbox. You never see final test inputs or labels.
