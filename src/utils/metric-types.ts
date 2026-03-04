/**
 * Prometheus-style metric primitives: Counter, Gauge, Histogram.
 */

import { getLogger } from './logger.js';

export type MetricValue = number;
export type MetricLabels = Record<string, string>;

interface MetricPoint {
  value: MetricValue;
  timestamp: number;
  labels: MetricLabels;
}

/**
 * Base metric class with label support
 */
export abstract class Metric {
  protected name: string;
  protected description: string;
  protected logger = getLogger().child({ module: 'Metrics' });

  constructor(name: string, description: string) {
    this.name = name;
    this.description = description;
  }

  getName(): string {
    return this.name;
  }

  getDescription(): string {
    return this.description;
  }

  protected serializeLabels(labels: MetricLabels): string {
    return Object.entries(labels)
      .map(([k, v]) => `${k}="${v}"`)
      .join(',');
  }

  abstract toPrometheusFormat(): string;
}

/**
 * Counter metric - monotonically increasing values
 */
export class Counter extends Metric {
  private values: Map<string, MetricPoint> = new Map();

  inc(labels: MetricLabels = {}, value = 1): void {
    const key = this.serializeLabels(labels);
    const existing = this.values.get(key);
    if (existing) {
      existing.value += value;
    } else {
      this.values.set(key, {
        value,
        timestamp: Date.now(),
        labels,
      });
    }
  }

  get(labels: MetricLabels = {}): number {
    const key = this.serializeLabels(labels);
    return this.values.get(key)?.value ?? 0;
  }

  toPrometheusFormat(): string {
    const lines = [`# HELP ${this.name} ${this.description}`, `# TYPE ${this.name} counter`];
    for (const [, point] of this.values) {
      const labelStr = Object.entries(point.labels)
        .map(([k, v]) => `${k}="${v}"`)
        .join(',');
      lines.push(`${this.name}{${labelStr}} ${String(point.value)}`);
    }
    return lines.join('\n');
  }
}

/**
 * Gauge metric - values that can go up and down
 */
export class Gauge extends Metric {
  private values: Map<string, MetricPoint> = new Map();

  set(labels: MetricLabels = {}, value: number): void {
    const key = this.serializeLabels(labels);
    this.values.set(key, {
      value,
      timestamp: Date.now(),
      labels,
    });
  }

  inc(labels: MetricLabels = {}, value = 1): void {
    const key = this.serializeLabels(labels);
    const existing = this.values.get(key);
    if (existing) {
      existing.value += value;
    } else {
      this.set(labels, value);
    }
  }

  dec(labels: MetricLabels = {}, value = 1): void {
    this.inc(labels, -value);
  }

  get(labels: MetricLabels = {}): number {
    const key = this.serializeLabels(labels);
    return this.values.get(key)?.value ?? 0;
  }

  toPrometheusFormat(): string {
    const lines = [`# HELP ${this.name} ${this.description}`, `# TYPE ${this.name} gauge`];
    for (const [, point] of this.values) {
      const labelStr = Object.entries(point.labels)
        .map(([k, v]) => `${k}="${v}"`)
        .join(',');
      lines.push(`${this.name}{${labelStr}} ${String(point.value)}`);
    }
    return lines.join('\n');
  }
}

/**
 * Histogram metric - distribution of values
 */
export class Histogram extends Metric {
  private buckets: number[];
  private counts: Map<string, number[]> = new Map();
  private sums: Map<string, number> = new Map();
  private counts_total: Map<string, number> = new Map();

  constructor(name: string, description: string, buckets: readonly number[] = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10]) {
    super(name, description);
    this.buckets = [...buckets].sort((a, b) => a - b);
  }

  observe(labels: MetricLabels = {}, value: number): void {
    const key = this.serializeLabels(labels);

    if (!this.counts.has(key)) {
      this.counts.set(key, new Array<number>(this.buckets.length).fill(0));
      this.sums.set(key, 0);
      this.counts_total.set(key, 0);
    }

    const bucketCounts = this.counts.get(key);
    if (!bucketCounts) return;
    for (let i = 0; i < this.buckets.length; i++) {
      const bucketValue = this.buckets[i];
      if (bucketValue !== undefined && value <= bucketValue) {
        const currentCount = bucketCounts[i];
        if (currentCount !== undefined) {
          bucketCounts[i] = currentCount + 1;
        }
      }
    }

    this.sums.set(key, (this.sums.get(key) ?? 0) + value);
    this.counts_total.set(key, (this.counts_total.get(key) ?? 0) + 1);
  }

  toPrometheusFormat(): string {
    const lines = [`# HELP ${this.name} ${this.description}`, `# TYPE ${this.name} histogram`];

    for (const [key, bucketCounts] of this.counts) {
      const labelEntries: [string, string][] = key
        .split(',')
        .filter((s) => s)
        .map((s) => {
          const [k, v] = s.split('=');
          return [k ?? '', v?.replace(/"/g, '') ?? ''];
        });

      for (let i = 0; i < this.buckets.length; i++) {
        const bucketValue = this.buckets[i];
        const bucketCount = bucketCounts[i];
        if (bucketValue === undefined || bucketCount === undefined) continue;
        const labels = [...labelEntries, ['le', bucketValue.toString()] as [string, string]]
          .map(([k, v]) => `${k}="${v}"`)
          .join(',');
        lines.push(`${this.name}_bucket{${labels}} ${String(bucketCount)}`);
      }

      const infLabels = [...labelEntries, ['le', '+Inf'] as [string, string]].map(([k, v]) => `${k}="${v}"`).join(',');
      const totalCount = this.counts_total.get(key);
      if (totalCount !== undefined) {
        lines.push(`${this.name}_bucket{${infLabels}} ${String(totalCount)}`);
      }

      const baseLabels = labelEntries.map(([k, v]) => `${k}="${v}"`).join(',');
      const sumValue = this.sums.get(key);
      if (sumValue !== undefined) {
        lines.push(`${this.name}_sum{${baseLabels}} ${String(sumValue)}`);
      }
      if (totalCount !== undefined) {
        lines.push(`${this.name}_count{${baseLabels}} ${String(totalCount)}`);
      }
    }

    return lines.join('\n');
  }

  getBuckets(): number[] {
    return [...this.buckets];
  }

  getCountsSnapshot(): Map<string, number[]> {
    const snapshot = new Map<string, number[]>();
    for (const [key, bucketCounts] of this.counts.entries()) {
      snapshot.set(key, [...bucketCounts]);
    }
    return snapshot;
  }

  getTotalsSnapshot(): Map<string, number> {
    return new Map(this.counts_total);
  }
}
