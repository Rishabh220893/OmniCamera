/**
 * Anomaly detection without a model (gap A17): what is normal for a camera at this hour of this day of the week, learned from its own counts, and a
 * count far from it. No training step and no GPU: an exponentially weighted mean and variance per camera, per metric, per hour of the week
 * (168 buckets), so a quiet street at 3 a.m. and a busy one at 6 p.m. are each judged against their own usual.
 *
 * Honest limits: it needs a few days of data before it says anything (`minSamples` in a bucket), counts come from the scene analysis or a detector
 * and are only as good as they are, and "unusual" is statistics, not meaning: a festival, a market day or a road closure is flagged. People decide.
 */
export type Metric = 'people' | 'vehicles';

export interface BucketState { n: number; mean: number; m2: number }
export interface Observation { key: string; metric: Metric; at: Date; value: number }

export interface Score {
  /** How many buckets-worth of history there is for this hour (0 when none). */
  samples: number;
  expected: number;
  stdev: number;
  /** Standard deviations from the mean (positive: more than usual). Null while there is too little history to say. */
  z: number | null;
}

export interface BaselineOptions {
  /** Weight of a new value (the memory is roughly 1/alpha observations of that hour). Default 0.1. */
  alpha?: number;
  /** Observations an hour-of-week bucket needs before it is trusted. Default 12. */
  minSamples?: number;
  /** Least standard deviation used, so a camera that is always empty at night is not "anomalous" at the first car. Default 0.75. */
  floor?: number;
  /** Time zone for "hour of the week", minutes ahead of UTC. Default 330 (India). */
  tzMinutes?: number;
}

/** 0..167: day of week (Monday = 0) times 24 plus hour, in the camera's local time. */
export function hourOfWeek(at: Date, tzMinutes = 330): number {
  const local = new Date(at.getTime() + tzMinutes * 60_000);
  const dow = (local.getUTCDay() + 6) % 7;
  return dow * 24 + local.getUTCHours();
}

export function createBaseline(o: BaselineOptions = {}) {
  const alpha = o.alpha ?? 0.1, minSamples = o.minSamples ?? 12, floor = o.floor ?? 0.75, tz = o.tzMinutes ?? 330;
  const buckets = new Map<string, BucketState>();
  const idOf = (key: string, metric: Metric, h: number) => `${key}|${metric}|${h}`;

  function score(obs: Observation): Score {
    const b = buckets.get(idOf(obs.key, obs.metric, hourOfWeek(obs.at, tz)));
    if (!b || b.n === 0) return { samples: 0, expected: 0, stdev: floor, z: null };
    const stdev = Math.max(floor, Math.sqrt(b.m2));
    return { samples: b.n, expected: b.mean, stdev, z: b.n >= minSamples ? (obs.value - b.mean) / stdev : null };
  }

  return {
    /** Scores a value against what is usual, then learns it. Scoring first, so a value is never judged against itself. */
    observe(obs: Observation): Score {
      const s = score(obs);
      const id = idOf(obs.key, obs.metric, hourOfWeek(obs.at, tz));
      const b = buckets.get(id);
      if (!b) buckets.set(id, { n: 1, mean: obs.value, m2: 0 });
      else {
        // EWMA mean and variance (West 1979 style): the variance follows the mean without storing the history.
        const diff = obs.value - b.mean, incr = alpha * diff;
        b.mean += incr;
        b.m2 = (1 - alpha) * (b.m2 + diff * incr);
        b.n++;
      }
      return s;
    },
    score,
    /** For saving between runs. */
    export: (): Record<string, BucketState> => Object.fromEntries([...buckets.entries()].map(([k, v]) => [k, { ...v }])),
    import(state: Record<string, BucketState>) {
      for (const [k, v] of Object.entries(state ?? {})) if (v && Number.isFinite(v.n) && Number.isFinite(v.mean) && Number.isFinite(v.m2) && v.n > 0) buckets.set(k, { n: v.n, mean: v.mean, m2: Math.max(0, v.m2) });
    },
    size: () => buckets.size,
  };
}
export type Baseline = ReturnType<typeof createBaseline>;
