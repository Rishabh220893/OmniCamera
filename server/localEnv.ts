import { readFileSync, existsSync } from 'node:fs';

/**
 * The process environment plus demo.local and scale.local (later files win, and both win over the shell), the same
 * precedence as scripts/probe-grid.mjs. Quotes around a value are removed; Windows line endings are tolerated.
 */
export function loadLocalEnv(files = ['demo.local', 'scale.local'], base: Record<string, string | undefined> = process.env): Record<string, string | undefined> {
  const env = { ...base };
  for (const f of files) {
    if (!existsSync(f)) continue;
    for (const line of readFileSync(f, 'utf8').replace(/\r/g, '').split('\n')) {
      const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
      if (m) env[m[1]] = m[2].trim().replace(/^["']|["']$/g, '');
    }
  }
  return env;
}
