/**
 * Per-call cost, from the token counts the API reports.
 *
 * Prices are US dollars per million tokens, from Anthropic's published price
 * list (checked 2026-10-19). Haiku 5.5's rate applies to prompts up to 100K
 * tokens; this feature's prompts are around 1K. Thinking tokens are billed as
 * output and are already included in `output_tokens`.
 *
 * Costs are stored as integer micro-dollars, for the same reason fines are
 * integer cents: summing floats over thousands of rows drifts.
 */
const PRICES: Record<string, { input: number; output: number }> = {
  "claude-haiku-5-5": { input: 0.1, output: 0.5 },
};

export function costMicroUsd(
  model: string,
  usage: { input_tokens: number; output_tokens: number },
): number {
  const price = PRICES[model];
  // An unpriced model is a code change someone forgot to finish. Better a
  // loud failure in tests than a dashboard quietly reporting $0.
  if (!price) throw new Error(`No price configured for model ${model}`);

  // $/MTok is numerically the same as micro-dollars per token.
  return Math.round(
    usage.input_tokens * price.input + usage.output_tokens * price.output,
  );
}

export function formatMicroUsd(micro: number): string {
  const dollars = micro / 1_000_000;
  if (dollars === 0) return "$0";
  if (dollars < 0.01) return `$${dollars.toFixed(5)}`;
  return `$${dollars.toFixed(2)}`;
}
