/**
 * Reads the JSON a vision model sends back. The cheap models are right nearly always, but now and then add a trailing comma, wrap the
 * answer in a code fence, or put a sentence around it; one such slip used to fail the whole frame. This repairs only those slips and
 * never invents content: anything it cannot make valid JSON still throws.
 */
export function parseModelJson(raw: string | undefined): Record<string, unknown> {
  const text = (raw ?? '').trim() || '{}';
  const attempts: string[] = [text];
  const fenced = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/i, '');
  attempts.push(fenced);
  const open = fenced.indexOf('{'), close = fenced.lastIndexOf('}');
  if (open >= 0 && close > open) attempts.push(fenced.slice(open, close + 1));
  for (const a of [...attempts]) attempts.push(a.replace(/,\s*([}\]])/g, '$1'));
  let last: unknown;
  for (const a of attempts) {
    try {
      const v = JSON.parse(a);
      if (v && typeof v === 'object' && !Array.isArray(v)) return v as Record<string, unknown>;
    } catch (e) { last = e; }
  }
  throw last instanceof Error ? last : new Error('The model did not return a JSON object.');
}
