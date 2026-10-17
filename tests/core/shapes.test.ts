import { describe, expect, it } from 'vitest';
import { lossAt, LossTemplateSchema } from '@hedgenet/core';
import { exposureFixtures } from '../fixtures/exposures.ts';

const asset = exposureFixtures[0].template;
const heating = exposureFixtures[1].template;
const rain = exposureFixtures[3].template;

describe('loss templates', () => {
  for (const fixture of exposureFixtures) {
    it(`calculates ${fixture.name}, including boundaries`, () => {
      for (const { observation, lossUsd } of fixture.cases) {
        expect(lossAt(fixture.template, observation)).toBe(lossUsd);
      }
    });
  }

  it('preserves decimal precision rather than rounding to cents or binary floats', () => {
    expect(lossAt({ ...asset, units: '0.1', referencePriceUsd: '0.3' },
      { kind: 'numeric', value: '0.1' })).toBe('0.02');
    expect(lossAt({ ...asset, units: '0.000000000001', referencePriceUsd: '0.000000000001' },
      { kind: 'numeric', value: '0' })).toBe('0.000000000000000000000001');
    expect(lossAt({ ...asset, units: '999999999999', referencePriceUsd: '999999999999' },
      { kind: 'numeric', value: '0' })).toBe('999999999998000000000001');
  });

  it('rejects malformed and over-precision scalar inputs without coercing or truncating', () => {
    for (const units of ['NaN', 'Infinity', '1e3', '01', '1.0', '-0', ' 1', '', '0', '-1',
      '1000000000000', '0.0000000000001', 1, null]) {
      expect(() => lossAt({ ...asset, units }, { kind: 'numeric', value: '0' })).toThrow();
    }
    for (const template of [
      { ...asset, referencePriceUsd: '0' },
      { ...asset, schemaVersion: 'loss-v2' },
      { ...asset, currency: 'EUR' },
      { ...asset, guaranteed: true },
      { ...heating, direction: 'sideways' },
      { ...heating, lossRateUsd: '0' },
      { ...heating, maxLossUsd: '-1' },
      { ...rain, conditionId: ' ' },
      { ...rain, fixedLossUsd: '0' },
    ]) {
      expect(LossTemplateSchema.safeParse(template).success).toBe(false);
    }
  });

  it('allows signed temperatures but not negative asset prices or mismatched observation kinds', () => {
    expect(lossAt(heating, { kind: 'numeric', value: '-5' })).toBe('5000');
    for (const observation of [
      { kind: 'numeric', value: '-1' },
      { kind: 'numeric', value: 'NaN' },
      { kind: 'numeric', value: '1', extra: true },
      { kind: 'condition', conditionId: rain.conditionId, occurs: true },
    ]) {
      expect(() => lossAt(asset, observation)).toThrow();
    }
    expect(() => lossAt(rain, { kind: 'numeric', value: '1' })).toThrow();
  });

  it('requires the exact confirmed condition and a boolean, not a truthy string', () => {
    expect(() => lossAt(rain, {
      kind: 'condition', conditionId: 'synthetic:station-b:daily-rain', occurs: true,
    })).toThrow();
    expect(() => lossAt(rain, {
      kind: 'condition', conditionId: rain.conditionId, occurs: 'false',
    })).toThrow();
  });
});
