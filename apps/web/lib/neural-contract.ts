// Client-safe wire contract. Server dependencies are imported only as types.
import type { Preview } from './preview.ts';

export type NeuralInput = { units: string; referencePriceUsd: string; budgetUsd: string; revision: number; confirmedSynthetic: true };
export type NeuralTrace = {
  // 32 actual ReLU activations; six real-leg outputs in preview.legs order.
  schemaVersion: 'activation-trace-v1'; hidden: number[]; outputs: number[];
  // Five selected encoded features; learned weight matrices are 32×5 and 6×32.
  inputGroups: { label: string; value: number }[];
  inputWeights: number[][]; outputWeights: number[][];
};
export type NeuralPreview = Omit<Preview, 'schemaVersion' | 'proposalSource' | 'trace' | 'example'> & {
  schemaVersion: 'neural-preview-v1'; proposalSource: 'neural-network'; trace: NeuralTrace;
  example: 'crypto'; outcome: 'improvement' | 'no_improvement';
  exposure: { units: string; referencePriceUsd: string };
  model: { version: string; weightsHash: string; qualityPolicy: 'advisory'; qualityWarnings: string[] };
  execution: { provider: 'createos'; runtime: 'sandbox' | 'application'; inferenceMs: number; totalMs: number };
  repair: { budgetScaled: boolean; multiplier: string; droppedLegIds: string[] };
};
