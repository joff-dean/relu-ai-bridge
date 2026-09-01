import { AlignmentError, alignmentInvariant } from "./errors.mjs";
import { DEFAULT_LIMITS } from "./limits.mjs";

const isArrayLike = (value) => Array.isArray(value) || ArrayBuffer.isView(value);

function rowsToColumns(rows, name) {
  const timestamps = new Array(rows.length);
  const values = new Array(rows.length);
  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index];
    if (row === null || typeof row !== "object" || Array.isArray(row)) {
      throw new AlignmentError("INVALID_SERIES", `${name}[${index}]는 row 객체여야 합니다.`);
    }
    timestamps[index] = row.timestamp;
    values[index] = row.value;
  }
  return { timestamps, values };
}

export function validateTimeSeries(input, { name = "series", limits, minimumSamples = 2 } = {}) {
  limits ??= DEFAULT_LIMITS;
  const source = Array.isArray(input) ? rowsToColumns(input, name) : input;
  alignmentInvariant(
    source !== null && typeof source === "object" && !Array.isArray(source),
    "INVALID_SERIES",
    `${name}는 row 배열 또는 { timestamps, values } 객체여야 합니다.`,
  );
  alignmentInvariant(isArrayLike(source.timestamps), "INVALID_SERIES", `${name}.timestamps가 필요합니다.`);
  alignmentInvariant(isArrayLike(source.values), "INVALID_SERIES", `${name}.values가 필요합니다.`);

  const sampleCount = source.timestamps.length;
  alignmentInvariant(
    Number.isSafeInteger(sampleCount) && sampleCount >= minimumSamples,
    "INVALID_SERIES",
    `${name}에는 최소 ${minimumSamples}개 샘플이 필요합니다.`,
    { sampleCount, minimumSamples },
  );
  alignmentInvariant(
    sampleCount === source.values.length,
    "INVALID_SERIES",
    `${name}의 timestamp와 value 개수가 다릅니다.`,
    { timestamps: sampleCount, values: source.values.length },
  );
  alignmentInvariant(
    sampleCount <= limits.maxSamples,
    "LIMIT_EXCEEDED",
    `${name}의 샘플 수가 제한을 초과했습니다.`,
    { limit: "maxSamples", maximum: limits.maxSamples, observed: sampleCount },
  );

  const timestamps = new Array(sampleCount);
  const values = new Array(sampleCount);
  let dimensions;

  for (let index = 0; index < sampleCount; index += 1) {
    const timestamp = source.timestamps[index];
    if (typeof timestamp !== "number" || !Number.isFinite(timestamp) || Math.abs(timestamp) > Number.MAX_SAFE_INTEGER) {
      throw new AlignmentError("INVALID_TIMESTAMP", `${name}[${index}]의 timestamp가 유효하지 않습니다.`, {
        index,
        timestamp,
      });
    }
    if (index > 0 && timestamp <= timestamps[index - 1]) {
      throw new AlignmentError("NON_MONOTONIC_TIME", `${name}의 timestamp는 엄격히 증가해야 합니다.`, {
        index,
        previous: timestamps[index - 1],
        current: timestamp,
      });
    }
    timestamps[index] = timestamp;

    const rawValue = source.values[index];
    const vector = typeof rawValue === "number" ? [rawValue] : isArrayLike(rawValue) ? Array.from(rawValue) : null;
    if (!vector || vector.length === 0) {
      throw new AlignmentError("INVALID_VALUE", `${name}[${index}]의 value는 숫자 또는 숫자 배열이어야 합니다.`);
    }
    dimensions ??= vector.length;
    if (vector.length !== dimensions) {
      throw new AlignmentError("DIMENSION_MISMATCH", `${name}의 value 차원이 일정하지 않습니다.`, {
        index,
        expected: dimensions,
        observed: vector.length,
      });
    }
    if (dimensions > limits.maxDimensions) {
      throw new AlignmentError("LIMIT_EXCEEDED", `${name}의 value 차원이 제한을 초과했습니다.`, {
        limit: "maxDimensions",
        maximum: limits.maxDimensions,
        observed: dimensions,
      });
    }
    for (let dimension = 0; dimension < vector.length; dimension += 1) {
      if (typeof vector[dimension] !== "number" || !Number.isFinite(vector[dimension])) {
        throw new AlignmentError("INVALID_VALUE", `${name}[${index}].value[${dimension}]가 유효하지 않습니다.`, {
          index,
          dimension,
        });
      }
    }
    values[index] = vector;
  }

  alignmentInvariant(
    sampleCount * dimensions <= limits.maxFeatureValues,
    "LIMIT_EXCEEDED",
    `${name}의 전체 값 개수가 제한을 초과했습니다.`,
    {
      limit: "maxFeatureValues",
      maximum: limits.maxFeatureValues,
      observed: sampleCount * dimensions,
    },
  );

  return { timestamps, values, sampleCount, dimensions };
}

function lowerBound(values, target) {
  let low = 0;
  let high = values.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (values[middle] < target) low = middle + 1;
    else high = middle;
  }
  return low;
}

export function interpolateVectorAt(series, timestamp) {
  const { timestamps, values } = series;
  if (timestamp <= timestamps[0]) return values[0].slice();
  const lastIndex = timestamps.length - 1;
  if (timestamp >= timestamps[lastIndex]) return values[lastIndex].slice();
  const right = lowerBound(timestamps, timestamp);
  if (timestamps[right] === timestamp) return values[right].slice();
  const left = right - 1;
  const ratio = (timestamp - timestamps[left]) / (timestamps[right] - timestamps[left]);
  const output = new Array(values[left].length);
  for (let dimension = 0; dimension < output.length; dimension += 1) {
    output[dimension] = values[left][dimension] + (values[right][dimension] - values[left][dimension]) * ratio;
  }
  return output;
}

export function sampleSeriesRange(series, start, end, maximumSamples) {
  alignmentInvariant(Number.isFinite(start) && Number.isFinite(end) && start < end, "INVALID_RANGE", "샘플 범위가 유효하지 않습니다.", { start, end });
  const sourceStart = series.timestamps[0];
  const sourceEnd = series.timestamps.at(-1);
  alignmentInvariant(start >= sourceStart && end <= sourceEnd, "INVALID_RANGE", "샘플 범위가 시계열 밖에 있습니다.", {
    start,
    end,
    sourceStart,
    sourceEnd,
  });

  const first = lowerBound(series.timestamps, start);
  const last = lowerBound(series.timestamps, end);
  const exactStart = series.timestamps[first] === start;
  const exactEnd = series.timestamps[last] === end;
  const originalEndExclusive = exactEnd ? last + 1 : last;
  const originalPointCount = Math.max(0, originalEndExclusive - first);
  const naturalCount = Math.max(2, originalPointCount + (exactStart ? 0 : 1) + (exactEnd ? 0 : 1));
  const sampleCount = Math.max(2, Math.min(maximumSamples, naturalCount));
  const timestamps = new Array(sampleCount);
  const values = new Array(sampleCount);
  for (let index = 0; index < sampleCount; index += 1) {
    const ratio = index / (sampleCount - 1);
    const timestamp = start + (end - start) * ratio;
    timestamps[index] = timestamp;
    values[index] = interpolateVectorAt(series, timestamp);
  }
  return {
    timestamps,
    values,
    sampleCount,
    dimensions: series.dimensions ?? series.values[0].length,
    sourceRangeSampleCount: naturalCount,
    downsampled: sampleCount < naturalCount,
  };
}

export function selectTimeRange(series, range, maximumSamples = series.sampleCount ?? series.timestamps.length) {
  alignmentInvariant(range !== null && typeof range === "object", "INVALID_RANGE", "selection 범위가 필요합니다.");
  const start = range.start;
  const end = range.end;
  return sampleSeriesRange(series, start, end, maximumSamples);
}
