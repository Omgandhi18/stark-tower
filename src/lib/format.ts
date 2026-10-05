// Numbers as the UI shows them.
const THOUSAND = 1_000;
const MILLION = 1_000_000;
const SMALLEST_CENT = 0.01;

/** "$0.42", "$12.30", "<$0.01". */
export function formatCost(usd: number): string {
  if (usd > 0 && usd < SMALLEST_CENT) return "<$0.01";
  return `$${usd.toFixed(2)}`;
}

/** "870", "38k", "1.2M". */
export function formatTokens(count: number): string {
  if (count < THOUSAND) return String(Math.round(count));
  if (count < MILLION) return `${Math.round(count / THOUSAND)}k`;
  return `${(count / MILLION).toFixed(1).replace(/\.0$/, "")}M`;
}
