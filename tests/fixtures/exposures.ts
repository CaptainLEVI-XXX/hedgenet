// Synthetic, hand-calculated loss examples. No real venue rules or liquidity.
export const exposureFixtures = [
  {
    name: 'BTC holding',
    dataMode: 'synthetic',
    template: {
      schemaVersion: 'loss-v1', currency: 'USD', templateId: 'terminal_downside',
      units: '0.25', referencePriceUsd: '70000',
    },
    cases: [
      { observation: { kind: 'numeric', value: '0' }, lossUsd: '17500' },
      { observation: { kind: 'numeric', value: '55000' }, lossUsd: '3750' },
      { observation: { kind: 'numeric', value: '70000' }, lossUsd: '0' },
      { observation: { kind: 'numeric', value: '81000' }, lossUsd: '0' },
    ],
  },
  {
    name: 'Heating cost below 10°C',
    dataMode: 'synthetic',
    template: {
      schemaVersion: 'loss-v1', currency: 'USD', templateId: 'threshold_loss',
      direction: 'below', threshold: '10', lossRateUsd: '500', maxLossUsd: '5000',
    },
    cases: [
      { observation: { kind: 'numeric', value: '-5' }, lossUsd: '5000' },
      { observation: { kind: 'numeric', value: '0' }, lossUsd: '5000' },
      { observation: { kind: 'numeric', value: '7' }, lossUsd: '1500' },
      { observation: { kind: 'numeric', value: '9.999' }, lossUsd: '0.5' },
      { observation: { kind: 'numeric', value: '10' }, lossUsd: '0' },
      { observation: { kind: 'numeric', value: '12' }, lossUsd: '0' },
    ],
  },
  {
    name: 'Cooling cost above −2°C',
    dataMode: 'synthetic',
    template: {
      schemaVersion: 'loss-v1', currency: 'USD', templateId: 'threshold_loss',
      direction: 'above', threshold: '-2', lossRateUsd: '125.5', maxLossUsd: '400',
    },
    cases: [
      { observation: { kind: 'numeric', value: '-3' }, lossUsd: '0' },
      { observation: { kind: 'numeric', value: '-2' }, lossUsd: '0' },
      { observation: { kind: 'numeric', value: '-1' }, lossUsd: '125.5' },
      { observation: { kind: 'numeric', value: '5' }, lossUsd: '400' },
    ],
  },
  {
    name: 'Fixed loss under the confirmed rain condition',
    dataMode: 'synthetic',
    template: {
      schemaVersion: 'loss-v1', currency: 'USD', templateId: 'conditional_loss',
      conditionId: 'synthetic:station-a:daily-rain', fixedLossUsd: '5000',
    },
    cases: [
      {
        observation: { kind: 'condition', conditionId: 'synthetic:station-a:daily-rain', occurs: false },
        lossUsd: '0',
      },
      {
        observation: { kind: 'condition', conditionId: 'synthetic:station-a:daily-rain', occurs: true },
        lossUsd: '5000',
      },
    ],
  },
] as const;
