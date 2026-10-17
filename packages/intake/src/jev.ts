import { z } from 'zod';

export const jevModel = 'jev-1.13.0';
export type ChoiceQuestion = { type: 'choice'; instructions: string; criteria: Record<string, string> };
const probability = z.number().finite().min(0).max(1);
const answerSchema = z.object({ type: z.literal('choice'), choice: z.string(),
  probabilities: z.record(z.string(), probability), confidence: probability });
const responseSchema = z.object({ model: z.literal(jevModel), answers: z.record(z.string(), answerSchema),
  usage: z.object({ input_tokens: z.number().int().nonnegative().safe(), output_tokens: z.number().int().nonnegative().safe() }) });
export type JevResponse = z.infer<typeof responseSchema> & { durationMs: number };
export class JevError extends Error {
  readonly code: 'timeout' | 'http_error' | 'invalid_response' | 'network_error';
  constructor(code: JevError['code']) { super(`Jev ${code}`); this.name = 'JevError'; this.code = code; }
}
const sameKeys = (a: object, b: object) => Object.keys(a).sort().join('\0') === Object.keys(b).sort().join('\0');

/** Server-only, fixed endpoint, pinned model, no retry or provider-body logging. */
export function createJevClient(options: { apiKey: string; fetchImpl?: typeof fetch }) {
  if (!options.apiKey.trim()) throw new Error('JEV_API_KEY is required on the server');
  return {
    async ask(state: unknown, questions: Record<string, ChoiceQuestion>, signal?: AbortSignal): Promise<JevResponse> {
      const startedAt = performance.now();
      const controller = new AbortController();
      const abort = () => controller.abort();
      signal?.addEventListener('abort', abort, { once: true });
      if (signal?.aborted) abort();
      let timer: ReturnType<typeof setTimeout> | undefined;
      let rejectOnAbort: (() => void) | undefined;
      try {
        const deadline = new Promise<never>((_resolve, reject) => {
          rejectOnAbort = () => reject(new JevError('timeout'));
          controller.signal.addEventListener('abort', rejectOnAbort, { once: true });
          timer = setTimeout(abort, 5000);
          if (controller.signal.aborted) rejectOnAbort();
        });
        const request = async () => {
          controller.signal.throwIfAborted();
          const response = await (options.fetchImpl ?? fetch)('https://api.typesafe.ai/v1/systemone', {
            method: 'POST', signal: controller.signal, redirect: 'error',
            headers: { Authorization: `Bearer ${options.apiKey}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ model: jevModel, state, questions }),
          });
          if (!response.ok) throw new JevError('http_error');
          let parsed: z.infer<typeof responseSchema>;
          try {
            const text = await response.text();
            if (text.length > 256_000) throw new Error('Response too large');
            parsed = responseSchema.parse(JSON.parse(text));
            if (!sameKeys(parsed.answers, questions)) throw new Error('Answer identities differ');
            for (const [id, answer] of Object.entries(parsed.answers)) {
              if (!sameKeys(answer.probabilities, questions[id]!.criteria)
                || !Object.hasOwn(answer.probabilities, answer.choice)) throw new Error('Invalid choices');
              const values = Object.values(answer.probabilities);
              if (Math.abs(values.reduce((sum, value) => sum + value, 0) - 1) > 0.000001
                || answer.probabilities[answer.choice] !== Math.max(...values)) throw new Error('Invalid distribution');
            }
          } catch { throw new JevError('invalid_response'); }
          return { ...parsed, durationMs: performance.now() - startedAt };
        };
        return await Promise.race([deadline, request()]);
      } catch (error) {
        if (error instanceof JevError) throw error;
        throw new JevError(controller.signal.aborted ? 'timeout' : 'network_error');
      } finally {
        clearTimeout(timer);
        signal?.removeEventListener('abort', abort);
        if (rejectOnAbort) controller.signal.removeEventListener('abort', rejectOnAbort);
      }
    },
  };
}
export type JevClient = ReturnType<typeof createJevClient>;

/** Uncalibrated suggestion policy, never a correctness or confirmation score. */
export function suggestedChoice(answer: JevResponse['answers'][string]): string | null {
  const probabilities = Object.values(answer.probabilities).sort((a, b) => b - a);
  return probabilities[0]! >= 0.8 && probabilities[0]! - (probabilities[1] ?? 0) >= 0.2 ? answer.choice : null;
}
