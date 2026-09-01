import { AlignmentError, alignmentInvariant } from "./errors.mjs";
import { DEFAULT_LIMITS } from "./limits.mjs";
import { sampleSeriesRange } from "./series.mjs";

const DIRECTION_DIAGONAL = 0;
const DIRECTION_UP = 1;
const DIRECTION_LEFT = 2;
const DIRECTION_START = 3;

function nearestIndex(timestamps, target) {
  let low = 0;
  let high = timestamps.length - 1;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (timestamps[middle] < target) low = middle + 1;
    else high = middle;
  }
  if (low === 0) return 0;
  return Math.abs(timestamps[low] - target) < Math.abs(timestamps[low - 1] - target) ? low : low - 1;
}

function localDistance(reference, dut) {
  let total = 0;
  for (let dimension = 0; dimension < reference.length; dimension += 1) {
    const difference = Math.max(-8, Math.min(8, reference[dimension] - dut[dimension]));
    total += difference * difference;
  }
  return total / reference.length;
}

function valueAt(row, index) {
  if (!row || index < row.start || index > row.end) return Number.POSITIVE_INFINITY;
  return row.costs[index - row.start];
}

export function constrainedDtw(
  reference,
  dut,
  candidate,
  {
    limits,
    guard,
    bandRatio = 0.14,
    paddingRatio = 0.12,
    transitionPenalty = 0.01,
    endpointPenalty = 0.05,
  } = {},
) {
  limits ??= DEFAULT_LIMITS;
  alignmentInvariant(reference?.timestamps?.length >= 2 && dut?.timestamps?.length >= 2, "INVALID_SERIES", "DTW에는 두 feature 시계열이 필요합니다.");
  alignmentInvariant(candidate && Number.isFinite(candidate.dutStart) && Number.isFinite(candidate.dutEnd), "INVALID_OPTIONS", "DTW candidate가 유효하지 않습니다.");
  if (![bandRatio, paddingRatio, transitionPenalty, endpointPenalty].every((value) => Number.isFinite(value) && value >= 0)) {
    throw new AlignmentError("INVALID_OPTIONS", "DTW 비율과 penalty는 0 이상의 유한수여야 합니다.");
  }
  if (bandRatio > 1 || paddingRatio > 1) {
    throw new AlignmentError("INVALID_OPTIONS", "DTW bandRatio와 paddingRatio는 1 이하여야 합니다.");
  }
  const dimensions = reference.values[0]?.length;
  alignmentInvariant(dimensions > 0 && dut.values[0]?.length === dimensions, "DIMENSION_MISMATCH", "REF/DUT feature 차원이 다릅니다.");

  const referenceSampled = sampleSeriesRange(
    reference,
    reference.timestamps[0],
    reference.timestamps.at(-1),
    limits.maxDtwSamples,
  );
  const candidateDuration = candidate.dutEnd - candidate.dutStart;
  const dutRangeStart = Math.max(dut.timestamps[0], candidate.dutStart - candidateDuration * paddingRatio);
  const dutRangeEnd = Math.min(dut.timestamps.at(-1), candidate.dutEnd + candidateDuration * paddingRatio);
  const dutSampled = sampleSeriesRange(dut, dutRangeStart, dutRangeEnd, limits.maxDtwSamples);
  const referenceCount = referenceSampled.timestamps.length;
  const dutCount = dutSampled.timestamps.length;
  const expectedStart = nearestIndex(dutSampled.timestamps, candidate.dutStart);
  const expectedEnd = nearestIndex(dutSampled.timestamps, candidate.dutEnd);
  const expectedSpan = Math.max(1, expectedEnd - expectedStart);
  const bandRadius = Math.max(3, Math.ceil(expectedSpan * bandRatio));

  const ranges = new Array(referenceCount);
  let cellCount = 0;
  for (let referenceIndex = 0; referenceIndex < referenceCount; referenceIndex += 1) {
    const ratio = referenceCount === 1 ? 0 : referenceIndex / (referenceCount - 1);
    const center = expectedStart + expectedSpan * ratio;
    const start = Math.max(0, Math.floor(center - bandRadius));
    const end = Math.min(dutCount - 1, Math.ceil(center + bandRadius));
    ranges[referenceIndex] = { start, end };
    cellCount += end - start + 1;
  }
  if (cellCount > limits.maxDtwCells) {
    throw new AlignmentError("LIMIT_EXCEEDED", "DTW cell 수가 제한을 초과했습니다.", {
      limit: "maxDtwCells",
      maximum: limits.maxDtwCells,
      observed: cellCount,
      referenceSamples: referenceCount,
      dutSamples: dutCount,
      bandRadius,
    });
  }

  const directionRows = new Array(referenceCount);
  let previousRow;
  for (let referenceIndex = 0; referenceIndex < referenceCount; referenceIndex += 1) {
    const range = ranges[referenceIndex];
    const width = range.end - range.start + 1;
    const costs = new Float64Array(width);
    costs.fill(Number.POSITIVE_INFINITY);
    const directions = new Uint8Array(width);
    directions.fill(DIRECTION_START);
    const currentRow = { start: range.start, end: range.end, costs };

    for (let dutIndex = range.start; dutIndex <= range.end; dutIndex += 1) {
      const offset = dutIndex - range.start;
      const distance = localDistance(referenceSampled.values[referenceIndex], dutSampled.values[dutIndex]);
      if (referenceIndex === 0) {
        const startDeviation = Math.abs(dutIndex - expectedStart) / Math.max(1, bandRadius);
        costs[offset] = distance + endpointPenalty * startDeviation;
        directions[offset] = DIRECTION_START;
        continue;
      }

      const diagonal = valueAt(previousRow, dutIndex - 1);
      const up = valueAt(previousRow, dutIndex) + transitionPenalty;
      const left = dutIndex > range.start ? costs[offset - 1] + transitionPenalty : Number.POSITIVE_INFINITY;
      let best = diagonal;
      let direction = DIRECTION_DIAGONAL;
      if (up < best) {
        best = up;
        direction = DIRECTION_UP;
      }
      if (left < best) {
        best = left;
        direction = DIRECTION_LEFT;
      }
      costs[offset] = distance + best;
      directions[offset] = direction;
    }
    directionRows[referenceIndex] = { start: range.start, end: range.end, directions };
    previousRow = currentRow;
    guard?.checkpoint(width);
  }

  let endDutIndex = previousRow.start;
  let bestEndCost = Number.POSITIVE_INFINITY;
  for (let dutIndex = previousRow.start; dutIndex <= previousRow.end; dutIndex += 1) {
    const deviation = Math.abs(dutIndex - expectedEnd) / Math.max(1, bandRadius);
    const cost = valueAt(previousRow, dutIndex) + endpointPenalty * deviation;
    if (cost < bestEndCost) {
      bestEndCost = cost;
      endDutIndex = dutIndex;
    }
  }
  if (!Number.isFinite(bestEndCost)) {
    throw new AlignmentError("DTW_FAILED", "DTW 경로를 찾지 못했습니다.", { cellCount, bandRadius });
  }

  const reversedPath = [];
  let referenceIndex = referenceCount - 1;
  let dutIndex = endDutIndex;
  while (referenceIndex >= 0) {
    const row = directionRows[referenceIndex];
    if (dutIndex < row.start || dutIndex > row.end) {
      throw new AlignmentError("DTW_FAILED", "DTW 역추적 경로가 band를 벗어났습니다.");
    }
    reversedPath.push({
      referenceIndex,
      dutIndex,
      referenceTime: referenceSampled.timestamps[referenceIndex],
      dutTime: dutSampled.timestamps[dutIndex],
    });
    const direction = row.directions[dutIndex - row.start];
    if (referenceIndex === 0 || direction === DIRECTION_START) break;
    if (direction === DIRECTION_DIAGONAL) {
      referenceIndex -= 1;
      dutIndex -= 1;
    } else if (direction === DIRECTION_UP) {
      referenceIndex -= 1;
    } else {
      dutIndex -= 1;
    }
    if (reversedPath.length > referenceCount + dutCount + 2) {
      throw new AlignmentError("DTW_FAILED", "DTW 경로 길이가 이론상 한계를 초과했습니다.");
    }
  }
  const path = reversedPath.reverse();
  if (path[0]?.referenceIndex !== 0 || path.at(-1)?.referenceIndex !== referenceCount - 1) {
    throw new AlignmentError("DTW_FAILED", "DTW 경로가 REF 전체를 포함하지 않습니다.");
  }

  let localCostTotal = 0;
  let diagonalSteps = 0;
  let upSteps = 0;
  let leftSteps = 0;
  let boundaryHits = 0;
  for (let index = 0; index < path.length; index += 1) {
    const point = path[index];
    localCostTotal += localDistance(referenceSampled.values[point.referenceIndex], dutSampled.values[point.dutIndex]);
    const range = ranges[point.referenceIndex];
    if (point.dutIndex === range.start || point.dutIndex === range.end) boundaryHits += 1;
    if (index > 0) {
      const previous = path[index - 1];
      const referenceDelta = point.referenceIndex - previous.referenceIndex;
      const dutDelta = point.dutIndex - previous.dutIndex;
      if (referenceDelta === 1 && dutDelta === 1) diagonalSteps += 1;
      else if (referenceDelta === 1) upSteps += 1;
      else leftSteps += 1;
    }
  }

  return {
    path,
    normalizedCost: localCostTotal / path.length,
    alignedDutRange: { start: path[0].dutTime, end: path.at(-1).dutTime },
    diagnostics: {
      cellCount,
      bandRadius,
      referenceSamples: referenceCount,
      dutSamples: dutCount,
      pathLength: path.length,
      diagonalSteps,
      upSteps,
      leftSteps,
      boundaryHitRatio: boundaryHits / path.length,
      candidateRange: { start: candidate.dutStart, end: candidate.dutEnd },
      sampledDutRange: { start: dutRangeStart, end: dutRangeEnd },
      downsampled: referenceSampled.downsampled || dutSampled.downsampled,
    },
  };
}
