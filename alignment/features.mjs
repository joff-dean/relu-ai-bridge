import { AlignmentError } from "./errors.mjs";
import { DEFAULT_LIMITS } from "./limits.mjs";
import { validateTimeSeries } from "./series.mjs";

function meanAndScale(matrix, epsilon, guard) {
  const dimensions = matrix[0].length;
  const means = new Float64Array(dimensions);
  const m2 = new Float64Array(dimensions);
  for (let row = 0; row < matrix.length; row += 1) {
    const count = row + 1;
    for (let dimension = 0; dimension < dimensions; dimension += 1) {
      const delta = matrix[row][dimension] - means[dimension];
      means[dimension] += delta / count;
      m2[dimension] += delta * (matrix[row][dimension] - means[dimension]);
    }
    if ((row & 255) === 255) guard?.checkpoint(dimensions * 256);
  }
  guard?.checkpoint(dimensions * (matrix.length & 255));
  const scales = new Float64Array(dimensions);
  const constantChannels = [];
  for (let dimension = 0; dimension < dimensions; dimension += 1) {
    const standardDeviation = Math.sqrt(m2[dimension] / Math.max(1, matrix.length - 1));
    if (standardDeviation <= epsilon) constantChannels.push(dimension);
    scales[dimension] = Math.max(standardDeviation, epsilon);
  }
  return { means: Array.from(means), scales: Array.from(scales), constantChannels };
}

function standardizeMatrix(matrix, { clip, epsilon, guard }) {
  const stats = meanAndScale(matrix, epsilon, guard);
  const normalized = new Array(matrix.length);
  for (let row = 0; row < matrix.length; row += 1) {
    const output = new Array(matrix[row].length);
    for (let dimension = 0; dimension < output.length; dimension += 1) {
      const value = (matrix[row][dimension] - stats.means[dimension]) / stats.scales[dimension];
      output[dimension] = Math.max(-clip, Math.min(clip, value));
    }
    normalized[row] = output;
    if ((row & 255) === 255) guard?.checkpoint(output.length * 256);
  }
  guard?.checkpoint(matrix[0].length * (matrix.length & 255));
  return { values: normalized, stats };
}

function median(values) {
  const sorted = values.slice().sort((left, right) => left - right);
  const middle = sorted.length >>> 1;
  return sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle];
}

export function normalizeSeries(input, { limits, guard, name = "series", clip = 8, epsilon = 1e-9 } = {}) {
  limits ??= DEFAULT_LIMITS;
  if (!Number.isFinite(clip) || clip <= 0 || !Number.isFinite(epsilon) || epsilon <= 0) {
    throw new AlignmentError("INVALID_OPTIONS", "clip과 epsilon은 0보다 큰 유한수여야 합니다.");
  }
  const series = validateTimeSeries(input, { name, limits });
  const normalized = standardizeMatrix(series.values, { clip, epsilon, guard });
  return {
    ...series,
    values: normalized.values,
    normalization: normalized.stats,
  };
}

export function extractFeatures(
  input,
  {
    limits,
    guard,
    name = "series",
    mode = "raw+delta+activity",
    clip = 8,
    epsilon = 1e-9,
    deltaWeight = 0.7,
    activityWeight = 0.25,
  } = {},
) {
  limits ??= DEFAULT_LIMITS;
  const supportedModes = new Set(["raw", "raw+delta", "raw+delta+activity"]);
  if (!supportedModes.has(mode)) throw new AlignmentError("INVALID_OPTIONS", `지원하지 않는 feature mode입니다: ${mode}`);
  if (![deltaWeight, activityWeight].every((value) => Number.isFinite(value) && value >= 0)) {
    throw new AlignmentError("INVALID_OPTIONS", "feature weight는 0 이상의 유한수여야 합니다.");
  }

  const normalized = normalizeSeries(input, { limits, guard, name, clip, epsilon });
  if (mode === "raw") {
    return {
      ...normalized,
      featureDimensions: normalized.dimensions,
      featureMetadata: { mode, medianStep: null, deltaWeight: 0, activityWeight: 0 },
    };
  }

  const steps = new Array(normalized.sampleCount - 1);
  for (let index = 1; index < normalized.sampleCount; index += 1) {
    steps[index - 1] = normalized.timestamps[index] - normalized.timestamps[index - 1];
  }
  const medianStep = median(steps);
  const deltas = new Array(normalized.sampleCount);
  for (let index = 0; index < normalized.sampleCount; index += 1) {
    const left = Math.max(0, index - 1);
    const right = Math.min(normalized.sampleCount - 1, index + 1);
    const timeScale = (normalized.timestamps[right] - normalized.timestamps[left]) / medianStep;
    const row = new Array(normalized.dimensions);
    for (let dimension = 0; dimension < normalized.dimensions; dimension += 1) {
      row[dimension] = (normalized.values[right][dimension] - normalized.values[left][dimension]) / Math.max(epsilon, timeScale);
    }
    deltas[index] = row;
  }
  const normalizedDeltas = standardizeMatrix(deltas, { clip, epsilon, guard });

  let normalizedActivity;
  if (mode === "raw+delta+activity") {
    normalizedActivity = standardizeMatrix(
      normalizedDeltas.values.map((row) => row.map(Math.abs)),
      { clip, epsilon, guard },
    );
  }

  const featureValues = new Array(normalized.sampleCount);
  for (let index = 0; index < normalized.sampleCount; index += 1) {
    const row = normalized.values[index].slice();
    for (const value of normalizedDeltas.values[index]) row.push(value * deltaWeight);
    if (normalizedActivity) {
      for (const value of normalizedActivity.values[index]) row.push(value * activityWeight);
    }
    featureValues[index] = row;
  }
  const featureDimensions = featureValues[0].length;
  if (featureValues.length * featureDimensions > limits.maxFeatureValues) {
    throw new AlignmentError("LIMIT_EXCEEDED", "추출된 feature 값 개수가 제한을 초과했습니다.", {
      limit: "maxFeatureValues",
      maximum: limits.maxFeatureValues,
      observed: featureValues.length * featureDimensions,
    });
  }

  return {
    ...normalized,
    values: featureValues,
    featureDimensions,
    featureMetadata: {
      mode,
      medianStep,
      deltaWeight,
      activityWeight: normalizedActivity ? activityWeight : 0,
      rawNormalization: normalized.normalization,
      deltaNormalization: normalizedDeltas.stats,
      activityNormalization: normalizedActivity?.stats,
    },
  };
}
