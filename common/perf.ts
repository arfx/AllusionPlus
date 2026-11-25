import fse from 'fs-extra';

const FLUSH_INTERVAL_MS = 2000;
const MAX_SAMPLES_PER_WINDOW = 10000;

type PerfBucket = {
  count: number;
  sum: number;
  min: number;
  max: number;
  samples: number[];
};

const buckets = new Map<string, PerfBucket>();
const pendingEvents = new Map<string, number>();
const pendingGauges = new Map<string, number>();

export const isPerfEnabled = (): boolean => process.env.ALLUSION_PERF === '1';

const round = (value: number): number => Math.round(value * 10) / 10;

const writeLine = (line: string): void => {
  if (!isPerfEnabled()) return;
  console.info(line);
  const filePath = process.env.ALLUSION_PERF_FILE;
  if (filePath) {
    void fse.appendFile(filePath, `${line}\n`, { encoding: 'utf8' }).catch(() => undefined);
  }
};

const getBucket = (category: string): PerfBucket => {
  let bucket = buckets.get(category);
  if (!bucket) {
    bucket = { count: 0, sum: 0, min: Infinity, max: -Infinity, samples: [] };
    buckets.set(category, bucket);
  }
  return bucket;
};

/** Record a duration. Slow individual operations produce one compact detail line. */
export const recordPerf = (
  category: string,
  durationMs: number,
  options: { thresholdMs?: number; detail?: string } = {},
): void => {
  if (!isPerfEnabled() || !Number.isFinite(durationMs)) return;
  const bucket = getBucket(category);
  bucket.count++;
  bucket.sum += durationMs;
  bucket.min = Math.min(bucket.min, durationMs);
  bucket.max = Math.max(bucket.max, durationMs);
  if (bucket.samples.length < MAX_SAMPLES_PER_WINDOW) bucket.samples.push(durationMs);
  if (options.thresholdMs !== undefined && durationMs >= options.thresholdMs) {
    writeLine(`[perf] ${category} slow=${round(durationMs)}ms${options.detail ? ` ${options.detail}` : ''}`);
  }
};

/** Add counters/gauges that are emitted together with the next category summary. */
export const recordPerfEvent = (category: string, name: string, amount = 1): void => {
  if (!isPerfEnabled()) return;
  const key = `${category}.${name}`;
  pendingEvents.set(key, (pendingEvents.get(key) ?? 0) + amount);
};

export const setPerfGauge = (category: string, name: string, value: number): void => {
  if (!isPerfEnabled()) return;
  pendingGauges.set(`${category}.${name}`, value);
};

const percentile = (samples: number[], fraction: number): number => {
  if (!samples.length) return 0;
  const sorted = [...samples].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1)];
};

const flush = (): void => {
  if (!isPerfEnabled()) return;
  const categories = new Set([
    ...buckets.keys(),
    ...[...pendingEvents.keys(), ...pendingGauges.keys()].map((key) => key.split('.')[0]),
  ]);
  for (const category of categories) {
    const bucket = getBucket(category);
    if (!bucket.count && ![...pendingEvents.keys(), ...pendingGauges.keys()].some((key) => key.startsWith(`${category}.`))) continue;
    const samples = bucket.samples;
    const fields = [`n=${bucket.count}`, `sum=${round(bucket.sum)}ms`, `min=${round(bucket.min)}ms`,
      `p50=${round(percentile(samples, 0.5))}ms`, `p95=${round(percentile(samples, 0.95))}ms`,
      `max=${round(bucket.max)}ms`];
    for (const [key, value] of pendingEvents) {
      if (key.startsWith(`${category}.`)) fields.push(`${key.slice(category.length + 1)}=${round(value)}`);
    }
    if (category === 'thumbnail') {
      const generated = pendingEvents.get('thumbnail.generated') ?? 0;
      const cacheHits = pendingEvents.get('thumbnail.cacheHits') ?? 0;
      const cacheMisses = pendingEvents.get('thumbnail.cacheMisses') ?? 0;
      const totalCacheRequests = cacheHits + cacheMisses;
      fields.push(`perSec=${round(generated / (FLUSH_INTERVAL_MS / 1000))}`);
      fields.push(`cacheHitRate=${round(totalCacheRequests ? cacheHits / totalCacheRequests * 100 : 0)}%`);
    }
    for (const [key, value] of pendingGauges) {
      if (key.startsWith(`${category}.`)) fields.push(`${key.slice(category.length + 1)}=${round(value)}`);
    }
    writeLine(`[perf] ${category} ${fields.join(' ')}`);
    buckets.set(category, { count: 0, sum: 0, min: Infinity, max: -Infinity, samples: [] });
  }
  pendingEvents.clear();
  pendingGauges.clear();
};

if (typeof setInterval !== 'undefined') {
  const interval = setInterval(flush, FLUSH_INTERVAL_MS);
  if (typeof interval === 'object' && 'unref' in interval) interval.unref();
}
