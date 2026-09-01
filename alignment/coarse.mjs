import { AlignmentError, alignmentInvariant } from "./errors.mjs";
import { DEFAULT_LIMITS } from "./limits.mjs";
import { interpolateVectorAt } from "./series.mjs";

function clamp(value, minimum, maximum) {
  return Math.max(minimum, Math.min(maximum, value));
}

function makeScales({ scales, minScale = 0.7, maxScale = 1.4, scaleSteps = 9 }) {
  if (scales !== undefined) {
    if (!Array.isArray(scales) || scales.length === 0 || scales.length > 64) {
      throw new AlignmentError("INVALID_OPTIONS", "coarse.scales는 1~64개의 scale 배열이어야 합니다.");
    }
    const output = [...new Set(scales)];
    if (!output.every((value) => Number.isFinite(value) && value > 0)) {
      throw new AlignmentError("INVALID_OPTIONS", "모든 coarse scale은 0보다 큰 유한수여야 합니다.");
    }
    return output.sort((left, right) => left - right);
  }
  if (!Number.isFinite(minScale) || !Number.isFinite(maxScale) || minScale <= 0 || maxScale < minScale) {
    throw new AlignmentError("INVALID_OPTIONS", "coarse scale 범위가 유효하지 않습니다.");
  }
  if (!Number.isSafeInteger(scaleSteps) || scaleSteps < 1 || scaleSteps > 64) {
    throw new AlignmentError("INVALID_OPTIONS", "coarse.scaleSteps는 1~64의 정수여야 합니다.");
  }
  if (scaleSteps === 1) return [clamp(1, minScale, maxScale)];
  const output = [];
  for (let index = 0; index < scaleSteps; index += 1) {
    output.push(minScale + ((maxScale - minScale) * index) / (scaleSteps - 1));
  }
  if (minScale <= 1 && maxScale >= 1 && !output.some((value) => Math.abs(value - 1) < 1e-12)) output.push(1);
  return output.sort((left, right) => left - right);
}

function correlation(referenceValues, dutValues) {
  let sumReference = 0;
  let sumDut = 0;
  let sumReferenceSquared = 0;
  let sumDutSquared = 0;
  let sumProduct = 0;
  let count = 0;
  for (let row = 0; row < referenceValues.length; row += 1) {
    for (let dimension = 0; dimension < referenceValues[row].length; dimension += 1) {
      const reference = referenceValues[row][dimension];
      const dut = dutValues[row][dimension];
      sumReference += reference;
      sumDut += dut;
      sumReferenceSquared += reference * reference;
      sumDutSquared += dut * dut;
      sumProduct += reference * dut;
      count += 1;
    }
  }
  const covariance = sumProduct - (sumReference * sumDut) / count;
  const referenceVariance = sumReferenceSquared - (sumReference * sumReference) / count;
  const dutVariance = sumDutSquared - (sumDut * sumDut) / count;
  const denominator = Math.sqrt(Math.max(0, referenceVariance) * Math.max(0, dutVariance));
  return denominator <= 1e-12 ? -1 : clamp(covariance / denominator, -1, 1);
}

function selectDistinctCandidates(rawCandidates, count, separationRatio) {
  const selected = [];
  for (const candidate of rawCandidates) {
    const isSameBasin = selected.some((previous) => {
      const separation = Math.min(previous.duration, candidate.duration) * separationRatio;
      const scaleSimilarity = Math.abs(Math.log(previous.scale / candidate.scale)) < 0.08;
      return scaleSimilarity && Math.abs(previous.dutStart - candidate.dutStart) < separation;
    });
    if (!isSameBasin) selected.push(candidate);
    if (selected.length >= count) break;
  }
  return selected;
}

export function findCoarseCandidates(
  reference,
  dut,
  {
    limits,
    guard,
    scales,
    minScale,
    maxScale,
    scaleSteps,
    probeCount = 128,
    candidateCount = 8,
    separationRatio = 0.12,
  } = {},
) {
  limits ??= DEFAULT_LIMITS;
  alignmentInvariant(reference?.timestamps?.length >= 2 && dut?.timestamps?.length >= 2, "INVALID_SERIES", "coarse matching에는 두 feature 시계열이 필요합니다.");
  const dimensions = reference.values[0]?.length;
  alignmentInvariant(dimensions > 0 && dut.values[0]?.length === dimensions, "DIMENSION_MISMATCH", "REF/DUT feature 차원이 다릅니다.");
  if (!Number.isSafeInteger(probeCount) || probeCount < 8 || probeCount > limits.maxCoarseSamples) {
    throw new AlignmentError("INVALID_OPTIONS", `coarse.probeCount는 8~${limits.maxCoarseSamples}의 정수여야 합니다.`);
  }
  if (!Number.isSafeInteger(candidateCount) || candidateCount < 1 || candidateCount > 64) {
    throw new AlignmentError("INVALID_OPTIONS", "coarse.candidateCount는 1~64의 정수여야 합니다.");
  }
  if (!Number.isFinite(separationRatio) || separationRatio < 0 || separationRatio > 1) {
    throw new AlignmentError("INVALID_OPTIONS", "coarse.separationRatio는 0~1 범위여야 합니다.");
  }

  const searchScales = makeScales({ scales, minScale, maxScale, scaleSteps });
  const referenceStart = reference.timestamps[0];
  const referenceEnd = reference.timestamps.at(-1);
  const referenceDuration = referenceEnd - referenceStart;
  const dutStart = dut.timestamps[0];
  const dutEnd = dut.timestamps.at(-1);
  const dutDuration = dutEnd - dutStart;
  const actualProbeCount = Math.min(probeCount, limits.maxCoarseSamples);
  const referenceProbes = new Array(actualProbeCount);
  for (let probe = 0; probe < actualProbeCount; probe += 1) {
    const ratio = probe / (actualProbeCount - 1);
    referenceProbes[probe] = interpolateVectorAt(reference, referenceStart + referenceDuration * ratio);
  }

  const operationsPerStart = actualProbeCount * dimensions;
  const eligibleScales = searchScales.filter((scale) => referenceDuration * scale <= dutDuration * (1 + 1e-12));
  if (eligibleScales.length === 0) {
    throw new AlignmentError("NO_CANDIDATE", "설정한 scale 범위에서 DUT에 들어가는 후보 구간이 없습니다.", {
      referenceDuration,
      dutDuration,
      scales: searchScales,
    });
  }
  const maximumStartsPerScale = Math.max(
    0,
    Math.min(limits.maxCoarseSamples, Math.floor(limits.maxCoarseOperations / (operationsPerStart * eligibleScales.length))),
  );
  if (maximumStartsPerScale < 1) {
    throw new AlignmentError("LIMIT_EXCEEDED", "coarse matching 연산량 제한으로 후보를 탐색할 수 없습니다.", {
      limit: "maxCoarseOperations",
      maximum: limits.maxCoarseOperations,
    });
  }

  const rawCandidates = [];
  let evaluatedCandidates = 0;
  for (const scale of eligibleScales) {
    const windowDuration = referenceDuration * scale;
    const availableStartDuration = Math.max(0, dutDuration - windowDuration);
    const naturalStarts = availableStartDuration === 0
      ? 1
      : Math.max(2, Math.min(dut.timestamps.length, Math.ceil(availableStartDuration / (referenceDuration / actualProbeCount)) + 1));
    const startCount = Math.min(maximumStartsPerScale, naturalStarts);
    for (let startIndex = 0; startIndex < startCount; startIndex += 1) {
      const startRatio = startCount === 1 ? 0 : startIndex / (startCount - 1);
      const candidateStart = dutStart + availableStartDuration * startRatio;
      const dutProbes = new Array(actualProbeCount);
      for (let probe = 0; probe < actualProbeCount; probe += 1) {
        const ratio = probe / (actualProbeCount - 1);
        dutProbes[probe] = interpolateVectorAt(dut, candidateStart + windowDuration * ratio);
      }
      const score = correlation(referenceProbes, dutProbes);
      rawCandidates.push({
        dutStart: candidateStart,
        dutEnd: candidateStart + windowDuration,
        duration: windowDuration,
        scale,
        score,
      });
      evaluatedCandidates += 1;
      guard?.checkpoint(operationsPerStart);
    }
  }
  if (rawCandidates.length === 0) {
    throw new AlignmentError("NO_CANDIDATE", "설정한 scale 범위에서 DUT에 들어가는 후보 구간이 없습니다.", {
      referenceDuration,
      dutDuration,
      scales: searchScales,
    });
  }

  rawCandidates.sort((left, right) => right.score - left.score || left.dutStart - right.dutStart || left.scale - right.scale);
  const candidates = selectDistinctCandidates(rawCandidates, candidateCount, separationRatio);
  return {
    candidates,
    diagnostics: {
      scales: searchScales,
      probeCount: actualProbeCount,
      evaluatedCandidates,
      bestScore: candidates[0]?.score ?? -1,
      secondDistinctScore: candidates[1]?.score ?? null,
    },
  };
}
