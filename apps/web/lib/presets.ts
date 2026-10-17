// Client-safe preset copy. Everything here is explicitly fictional illustration data.

export type ExampleId = 'crypto' | 'weather';
export type PresetId = ExampleId | 'none';

export const PREVIEW_BUDGET_MAX_USD = 5000;
export const DEFAULT_BUDGET_USD = '1000';
// At most two decimals, no exponent/sign/whitespace; range checked separately. Never clamped.
export const BUDGET_PATTERN = /^(?:0|[1-9]\d{0,3})(?:\.\d{1,2})?$/;

export function budgetProblem(value: string): string | null {
  if (!BUDGET_PATTERN.test(value)) return 'Enter a dollar amount with at most two decimals, e.g. 1000 or 250.50.';
  if (Number(value) > PREVIEW_BUDGET_MAX_USD) return 'The simulation accepts budgets from $0 to $5,000.';
  return null;
}

export const presets: Record<PresetId, { text: string; title: string; glyph: string; blurb: string }> = {
  crypto: {
    title: 'A drop in Bitcoin', glyph: '₿', blurb: '0.2 BTC held. A $1,000 budget to soften the downside.',
    text: 'I hold 0.2 BTC. I want protection if Bitcoin falls below $70,000 on October 30, 2026. My hedge budget is $1,000.',
  },
  weather: {
    title: 'Rain on event day', glyph: '☂', blurb: 'A $5,000 event loss if Heathrow records rain.',
    text: 'My outdoor event loses $5,000 if London Heathrow records at least 1 mm of rain on October 24, 2026. My hedge budget is $1,000.',
  },
  none: {
    title: 'Frost at a vineyard', glyph: '♧', blurb: 'What happens when a suitable market doesn’t exist?',
    text: 'My vineyard in Bordeaux loses $8,000 if frost damages the vines overnight on April 12, 2027. I can spend $500 to protect it.',
  },
};

/** Exact preset match only. Arbitrary text is never treated as an illustrative preset. */
export function matchPreset(text: string): PresetId | null {
  const trimmed = text.trim();
  return (Object.keys(presets) as PresetId[]).find(id => presets[id].text === trimmed) ?? null;
}

export const exampleCopy: Record<ExampleId, {
  context: string; quote: string; loss: string; rules: string; gap: string; domain: string;
  inputs: Array<[string, string]>;
}> = {
  crypto: {
    context: 'Bitcoin downside · 30 Oct 2026, 16:00 UTC',
    quote: '“I hold 0.2 BTC. Protect me below $70,000.”',
    loss: 'For every $1 the demo BTC/USD reference index settles below $70,000, the 0.2 BTC holding loses $0.20. At $0 the loss is $14,000.',
    rules: 'Three fictional, mutually exclusive contracts partition the demo BTC/USD index at 16:00 UTC on 30 October 2026: below $55,000; from $55,000 up to (not including) $65,000; and $65,000 or above. Each has YES and NO shares paying $1 if its outcome occurs. These are not real Polymarket listings.',
    gap: 'Below $55,000 payouts stop growing while the holding keeps losing value, down to a $0 BTC tail. Exactly one bucket pays, so the payout is conditional, never the sum of all shares.',
    domain: 'Scenarios cover the whole partition, from BTC $0 to above $70,000.',
    inputs: [['Holding', '0.2 BTC'], ['Reference price', '$70,000'], ['Hedge budget', ''], ['YES below $55k', '$0.20 / share'], ['YES $55k–$65k', '$0.35 / share']],
  },
  weather: {
    context: 'Heathrow rainfall · 24 Oct 2026, Europe/London',
    quote: '“My event loses $5,000 if Heathrow gets at least 1 mm of rain.”',
    loss: 'You lose $5,000 if the demo Heathrow station records at least 1 mm of rain on 24 October 2026 (00:00–24:00 Europe/London); otherwise $0.',
    rules: 'One fictional binary contract pays $1 per YES share if the demo London Heathrow station records at least 1 mm of rain on 24 October 2026, 00:00–24:00 Europe/London. Station, source and window are explicit demo assumptions. Not a real listing.',
    gap: 'Rain at your event may differ from the station. The $5,000 business-loss amount is your assumption, not a market guarantee.',
    domain: 'Two station-rainfall outcomes.',
    inputs: [['Business loss', '$5,000'], ['Rain threshold', '≥ 1 mm'], ['Hedge budget', ''], ['YES: rainy day', '$0.30 / share'], ['Observation', 'Heathrow · 24 Oct']],
  },
};
