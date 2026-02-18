/**
 * Percentile calculation utilities for performance metrics
 */

/**
 * Calculate percentile from an array of values
 * Uses linear interpolation for more accurate results
 *
 * @param values - Array of numeric values
 * @param percentile - Percentile to calculate (0-100)
 * @returns The percentile value
 */
export function calculatePercentile(values: number[], percentile: number): number {
  if (values.length === 0) {
    return 0;
  }

  if (percentile < 0 || percentile > 100) {
    throw new Error('Percentile must be between 0 and 100');
  }

  // Sort values in ascending order
  const sorted = [...values].sort((a, b) => a - b);

  // Calculate index using linear interpolation
  const index = (percentile / 100) * (sorted.length - 1);
  const lowerIndex = Math.floor(index);
  const upperIndex = Math.ceil(index);

  // If index is integer, return exact value
  if (lowerIndex === upperIndex) {
    return sorted[lowerIndex];
  }

  // Linear interpolation between two values
  const weight = index - lowerIndex;
  return sorted[lowerIndex] * (1 - weight) + sorted[upperIndex] * weight;
}

/**
 * Calculate multiple percentiles at once
 *
 * @param values - Array of numeric values
 * @param percentiles - Array of percentiles to calculate (0-100)
 * @returns Record mapping percentile names to values
 */
export function calculatePercentiles(
  values: number[],
  percentiles: number[]
): Record<string, number> {
  const result: Record<string, number> = {};

  for (const p of percentiles) {
    result[`p${p}`] = calculatePercentile(values, p);
  }

  return result;
}

/**
 * Interface for histogram data point
 */
export interface HistogramPoint {
  value: number;
  count: number;
}

/**
 * Calculate percentiles from histogram buckets
 *
 * @param buckets - Array of histogram buckets with upper bound and count
 * @param percentiles - Array of percentiles to calculate (0-100)
 * @returns Record mapping percentile names to values
 */
export function calculateHistogramPercentiles(
  buckets: HistogramPoint[],
  percentiles: number[] = [50, 95, 99]
): Record<string, number> {
  if (buckets.length === 0) {
    return percentiles.reduce((acc, p) => ({ ...acc, [`p${p}`]: 0 }), {});
  }

  // Sort buckets by value
  const sortedBuckets = [...buckets].sort((a, b) => a.value - b.value);

  // Calculate total count
  const totalCount = sortedBuckets.reduce((sum, b) => sum + b.count, 0);

  if (totalCount === 0) {
    return percentiles.reduce((acc, p) => ({ ...acc, [`p${p}`]: 0 }), {});
  }

  const result: Record<string, number> = {};

  for (const percentile of percentiles) {
    const targetCount = (percentile / 100) * totalCount;
    let cumulativeCount = 0;

    for (let i = 0; i < sortedBuckets.length; i++) {
      const bucket = sortedBuckets[i];
      const prevCumulative = cumulativeCount;
      cumulativeCount += bucket.count;

      if (cumulativeCount >= targetCount) {
        // Linear interpolation within the bucket
        const bucketProgress =
          bucket.count > 0
            ? (targetCount - prevCumulative) / bucket.count
            : 0;

        const prevValue = i > 0 ? sortedBuckets[i - 1].value : 0;
        result[`p${percentile}`] = prevValue + (bucket.value - prevValue) * bucketProgress;
        break;
      }
    }

    // Fallback to max value if not found
    if (!(`p${percentile}` in result)) {
      result[`p${percentile}`] = sortedBuckets[sortedBuckets.length - 1]?.value ?? 0;
    }
  }

  return result;
}

/**
 * Sliding window buffer for latency tracking
 */
export class LatencyBuffer {
  private values: number[] = [];
  private readonly maxSize: number;

  constructor(maxSize: number = 10000) {
    this.maxSize = maxSize;
  }

  /**
   * Add a latency value to the buffer
   */
  add(value: number): void {
    this.values.push(value);

    // Remove oldest values if exceeding max size
    if (this.values.length > this.maxSize) {
      this.values.shift();
    }
  }

  /**
   * Get percentiles for current values
   */
  getPercentiles(percentiles: number[] = [50, 95, 99]): Record<string, number> {
    return calculatePercentiles(this.values, percentiles);
  }

  /**
   * Get all statistics
   */
  getStats(): {
    count: number;
    min: number;
    max: number;
    mean: number;
    percentiles: Record<string, number>;
  } {
    if (this.values.length === 0) {
      return {
        count: 0,
        min: 0,
        max: 0,
        mean: 0,
        percentiles: { p50: 0, p95: 0, p99: 0 },
      };
    }

    const sorted = [...this.values].sort((a, b) => a - b);
    const sum = sorted.reduce((a, b) => a + b, 0);

    return {
      count: sorted.length,
      min: sorted[0],
      max: sorted[sorted.length - 1],
      mean: sum / sorted.length,
      percentiles: calculatePercentiles(this.values, [50, 95, 99]),
    };
  }

  /**
   * Clear all values
   */
  clear(): void {
    this.values = [];
  }

  /**
   * Get raw values (for testing)
   */
  getValues(): number[] {
    return [...this.values];
  }
}
