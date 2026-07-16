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
  /**
   * Max number of distinct label-sets (time series) tracked per metric. High-
   * cardinality labels (order_id, arbitrage_id, ...) create one series per value
   * that is never evicted, leaking memory on a long-running daemon. This cap is a
   * safety net: once reached, new label-sets are dropped (warned once).
   */
  protected maxCardinality = 10000;
  private cardinalityWarned = false;

  constructor(name: string, description: string) {
    if (!/^[a-zA-Z_:][a-zA-Z0-9_:]*$/.test(name)) {
      throw new Error(`Invalid Prometheus metric name: ${name}`);
    }
    this.name = name;
    this.description = description;
  }

  getName(): string {
    return this.name;
  }

  getDescription(): string {
    return this.description;
  }

  setMaxCardinality(cap: number): void {
    this.maxCardinality = cap;
  }

  /**
   * Returns true if a new label-set key may be recorded against `store`. Existing
   * keys always pass; once the cap is hit, novel keys are refused (warned once).
   */
  protected withinCardinality(
    store: { has(key: string): boolean; size: number },
    key: string
  ): boolean {
    if (store.has(key)) return true;
    if (store.size >= this.maxCardinality) {
      if (!this.cardinalityWarned) {
        this.cardinalityWarned = true;
        this.logger.warn('Metric label cardinality cap reached; dropping new label sets', {
          metric: this.name,
          cap: this.maxCardinality,
        });
      }
      return false;
    }
    return true;
  }

  protected serializeLabels(labels: MetricLabels): string {
    return JSON.stringify(Object.entries(this.normalizeLabels(labels)));
  }

  protected normalizeLabels(labels: MetricLabels): MetricLabels {
    const normalized: MetricLabels = {};
    for (const [key, value] of Object.entries(labels).sort(([left], [right]) =>
      left.localeCompare(right)
    )) {
      if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(key) || typeof value !== 'string') {
        throw new Error(`Invalid Prometheus label: ${key}`);
      }
      normalized[key] = value;
    }
    return normalized;
  }

  protected formatLabels(labels: MetricLabels): string {
    return Object.entries(labels)
      .map(([key, value]) => `${key}="${this.escapeLabelValue(value)}"`)
      .join(',');
  }

  protected formatHelp(): string {
    return this.description.replace(/\\/g, '\\\\').replace(/\n/g, '\\n');
  }

  private escapeLabelValue(value: string): string {
    return value.replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/"/g, '\\"');
  }

  abstract toPrometheusFormat(): string;
}

/**
 * Counter metric - monotonically increasing values
 */
export class Counter extends Metric {
  private values: Map<string, MetricPoint> = new Map();

  inc(labels: MetricLabels = {}, value = 1): void {
    if (!Number.isFinite(value) || value < 0) {
      throw new Error('Prometheus counter increments must be finite and non-negative');
    }
    const key = this.serializeLabels(labels);
    const existing = this.values.get(key);
    if (existing) {
      existing.value += value;
    } else {
      if (!this.withinCardinality(this.values, key)) return;
      this.values.set(key, {
        value,
        timestamp: Date.now(),
        labels: this.normalizeLabels(labels),
      });
    }
  }

  get(labels: MetricLabels = {}): number {
    const key = this.serializeLabels(labels);
    return this.values.get(key)?.value ?? 0;
  }

  toPrometheusFormat(): string {
    const lines = [`# HELP ${this.name} ${this.formatHelp()}`, `# TYPE ${this.name} counter`];
    for (const [, point] of this.values) {
      const labelStr = this.formatLabels(point.labels);
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
    if (!Number.isFinite(value)) {
      throw new Error('Prometheus gauge values must be finite');
    }
    const key = this.serializeLabels(labels);
    if (!this.values.has(key) && !this.withinCardinality(this.values, key)) return;
    this.values.set(key, {
      value,
      timestamp: Date.now(),
      labels: this.normalizeLabels(labels),
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

  clear(): void {
    this.values.clear();
  }

  toPrometheusFormat(): string {
    const lines = [`# HELP ${this.name} ${this.formatHelp()}`, `# TYPE ${this.name} gauge`];
    for (const [, point] of this.values) {
      const labelStr = this.formatLabels(point.labels);
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
  private labelSets: Map<string, MetricLabels> = new Map();

  constructor(
    name: string,
    description: string,
    buckets: readonly number[] = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10]
  ) {
    super(name, description);
    this.buckets = [...buckets].sort((a, b) => a - b);
  }

  observe(labels: MetricLabels = {}, value: number): void {
    if (!Number.isFinite(value)) {
      throw new Error('Prometheus histogram observations must be finite');
    }
    const key = this.serializeLabels(labels);

    if (!this.counts.has(key)) {
      if (!this.withinCardinality(this.counts, key)) return;
      this.counts.set(key, new Array<number>(this.buckets.length).fill(0));
      this.sums.set(key, 0);
      this.counts_total.set(key, 0);
      this.labelSets.set(key, this.normalizeLabels(labels));
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
    const lines = [`# HELP ${this.name} ${this.formatHelp()}`, `# TYPE ${this.name} histogram`];

    for (const [key, bucketCounts] of this.counts) {
      const baseLabels = this.labelSets.get(key) ?? {};

      for (let i = 0; i < this.buckets.length; i++) {
        const bucketValue = this.buckets[i];
        const bucketCount = bucketCounts[i];
        if (bucketValue === undefined || bucketCount === undefined) continue;
        const labels = this.formatLabels({ ...baseLabels, le: bucketValue.toString() });
        lines.push(`${this.name}_bucket{${labels}} ${String(bucketCount)}`);
      }

      const infLabels = this.formatLabels({ ...baseLabels, le: '+Inf' });
      const totalCount = this.counts_total.get(key);
      if (totalCount !== undefined) {
        lines.push(`${this.name}_bucket{${infLabels}} ${String(totalCount)}`);
      }

      const baseLabelString = this.formatLabels(baseLabels);
      const sumValue = this.sums.get(key);
      if (sumValue !== undefined) {
        lines.push(`${this.name}_sum{${baseLabelString}} ${String(sumValue)}`);
      }
      if (totalCount !== undefined) {
        lines.push(`${this.name}_count{${baseLabelString}} ${String(totalCount)}`);
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
