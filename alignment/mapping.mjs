import { AlignmentError, alignmentInvariant } from "./errors.mjs";
import { DEFAULT_LIMITS } from "./limits.mjs";

function perpendicularError(point, start, end) {
  const referenceSpan = end.refTime - start.refTime;
  if (referenceSpan === 0) return Math.abs(point.dutTime - start.dutTime);
  const ratio = (point.refTime - start.refTime) / referenceSpan;
  const expected = start.dutTime + (end.dutTime - start.dutTime) * ratio;
  return Math.abs(point.dutTime - expected);
}

function simplifyRdp(points, tolerance) {
  if (points.length <= 2 || tolerance <= 0) return points.slice();
  const keep = new Uint8Array(points.length);
  keep[0] = 1;
  keep[points.length - 1] = 1;
  const stack = [[0, points.length - 1]];
  while (stack.length > 0) {
    const [start, end] = stack.pop();
    let maximumError = -1;
    let maximumIndex = -1;
    for (let index = start + 1; index < end; index += 1) {
      const error = perpendicularError(points[index], points[start], points[end]);
      if (error > maximumError) {
        maximumError = error;
        maximumIndex = index;
      }
    }
    if (maximumError > tolerance) {
      keep[maximumIndex] = 1;
      stack.push([start, maximumIndex], [maximumIndex, end]);
    }
  }
  return points.filter((_, index) => keep[index] === 1);
}

function capPoints(points, maximum) {
  if (points.length <= maximum) return points;
  const selected = new Array(maximum);
  for (let index = 0; index < maximum; index += 1) {
    selected[index] = points[Math.round((index * (points.length - 1)) / (maximum - 1))];
  }
  return selected;
}

export function buildTimeMapping(path, { limits, tolerance } = {}) {
  limits ??= DEFAULT_LIMITS;
  alignmentInvariant(Array.isArray(path) && path.length >= 2, "INVALID_MAPPING", "mapping을 만들 DTW path가 부족합니다.");
  for (let pointIndex = 0; pointIndex < path.length; pointIndex += 1) {
    const point = path[pointIndex];
    alignmentInvariant(
      point && Number.isFinite(point.referenceTime) && Number.isFinite(point.dutTime),
      "INVALID_MAPPING",
      "DTW path의 timestamp가 유효하지 않습니다.",
      { pointIndex },
    );
    if (pointIndex > 0) {
      alignmentInvariant(
        point.referenceTime >= path[pointIndex - 1].referenceTime && point.dutTime >= path[pointIndex - 1].dutTime,
        "INVALID_MAPPING",
        "DTW path는 두 시간축에서 단조 증가해야 합니다.",
        { pointIndex },
      );
    }
  }
  const collapsed = [];
  let index = 0;
  while (index < path.length) {
    const referenceTime = path[index].referenceTime;
    let dutTotal = 0;
    let count = 0;
    while (index < path.length && path[index].referenceTime === referenceTime) {
      dutTotal += path[index].dutTime;
      count += 1;
      index += 1;
    }
    const dutTime = dutTotal / count;
    const previous = collapsed.at(-1);
    collapsed.push({ refTime: referenceTime, dutTime: previous ? Math.max(previous.dutTime, dutTime) : dutTime });
  }
  alignmentInvariant(collapsed.length >= 2, "INVALID_MAPPING", "서로 다른 REF timestamp가 두 개 이상 필요합니다.");

  const dutDuration = collapsed.at(-1).dutTime - collapsed[0].dutTime;
  const effectiveTolerance = tolerance ?? Math.max(Math.abs(dutDuration) * 0.001, Number.EPSILON * 32);
  if (!Number.isFinite(effectiveTolerance) || effectiveTolerance < 0) {
    throw new AlignmentError("INVALID_OPTIONS", "mapping tolerance는 0 이상의 유한수여야 합니다.");
  }
  const toleranceSimplified = simplifyRdp(collapsed, effectiveTolerance);
  const simplified = capPoints(toleranceSimplified, limits.maxMappingPoints);
  return {
    points: simplified,
    refRange: { start: simplified[0].refTime, end: simplified.at(-1).refTime },
    dutRange: { start: simplified[0].dutTime, end: simplified.at(-1).dutTime },
    diagnostics: {
      sourcePoints: path.length,
      collapsedPoints: collapsed.length,
      mappingPoints: simplified.length,
      tolerance: effectiveTolerance,
      capped: toleranceSimplified.length > limits.maxMappingPoints,
    },
  };
}

function normalizePoints(mappingOrPoints, direction) {
  const source = Array.isArray(mappingOrPoints) ? mappingOrPoints : mappingOrPoints?.points;
  alignmentInvariant(Array.isArray(source) && source.length >= 2, "INVALID_MAPPING", "두 개 이상의 mapping point가 필요합니다.");
  for (let pointIndex = 0; pointIndex < source.length; pointIndex += 1) {
    const point = source[pointIndex];
    alignmentInvariant(
      point && Number.isFinite(point.refTime) && Number.isFinite(point.dutTime),
      "INVALID_MAPPING",
      "mapping point의 timestamp가 유효하지 않습니다.",
      { pointIndex },
    );
    if (pointIndex > 0) {
      alignmentInvariant(
        point.refTime > source[pointIndex - 1].refTime && point.dutTime >= source[pointIndex - 1].dutTime,
        "INVALID_MAPPING",
        "mapping point는 REF에서 엄격 증가하고 DUT에서 단조 증가해야 합니다.",
        { pointIndex },
      );
    }
  }
  if (direction === "forward") return source.map((point) => ({ input: point.refTime, output: point.dutTime }));

  const inverse = [];
  let index = 0;
  while (index < source.length) {
    const dutTime = source[index].dutTime;
    let referenceTotal = 0;
    let count = 0;
    while (index < source.length && source[index].dutTime === dutTime) {
      referenceTotal += source[index].refTime;
      count += 1;
      index += 1;
    }
    inverse.push({ input: dutTime, output: referenceTotal / count });
  }
  alignmentInvariant(inverse.length >= 2, "INVALID_MAPPING", "역방향 mapping에 서로 다른 DUT timestamp가 두 개 이상 필요합니다.");
  return inverse;
}

function interpolatePoints(points, value, extrapolation) {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new AlignmentError("INVALID_TIMESTAMP", "mapping할 timestamp는 유한수여야 합니다.");
  }
  const first = points[0];
  const last = points.at(-1);
  if (value <= first.input) {
    if (value === first.input || extrapolation === "clamp") return first.output;
    if (extrapolation === "error") throw new AlignmentError("OUTSIDE_MAPPING", "timestamp가 mapping 범위보다 작습니다.", { value, minimum: first.input });
    const next = points[1];
    return first.output + ((value - first.input) * (next.output - first.output)) / (next.input - first.input);
  }
  if (value >= last.input) {
    if (value === last.input || extrapolation === "clamp") return last.output;
    if (extrapolation === "error") throw new AlignmentError("OUTSIDE_MAPPING", "timestamp가 mapping 범위보다 큽니다.", { value, maximum: last.input });
    const previous = points.at(-2);
    return last.output + ((value - last.input) * (last.output - previous.output)) / (last.input - previous.input);
  }

  let low = 1;
  let high = points.length - 1;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (points[middle].input < value) low = middle + 1;
    else high = middle;
  }
  const right = points[low];
  const left = points[low - 1];
  const ratio = (value - left.input) / (right.input - left.input);
  return left.output + (right.output - left.output) * ratio;
}

function validateExtrapolation(extrapolation) {
  if (!["clamp", "linear", "error"].includes(extrapolation)) {
    throw new AlignmentError("INVALID_OPTIONS", "extrapolation은 clamp, linear, error 중 하나여야 합니다.");
  }
}

export function mapRefToDut(mappingOrPoints, referenceTimestamp, { extrapolation = "clamp" } = {}) {
  validateExtrapolation(extrapolation);
  return interpolatePoints(normalizePoints(mappingOrPoints, "forward"), referenceTimestamp, extrapolation);
}

export function mapDutToRef(mappingOrPoints, dutTimestamp, { extrapolation = "clamp" } = {}) {
  validateExtrapolation(extrapolation);
  return interpolatePoints(normalizePoints(mappingOrPoints, "inverse"), dutTimestamp, extrapolation);
}

export function createTimeMapper(mapping, options = {}) {
  // mapping point 배열은 복사해 호출자가 사후 변경으로 mapper 동작을 바꾸지 못하게 한다.
  const immutableMapping = {
    ...mapping,
    points: mapping.points.map((point) => Object.freeze({ ...point })),
  };
  Object.freeze(immutableMapping.points);
  Object.freeze(immutableMapping);
  return Object.freeze({
    refToDut: (timestamp) => mapRefToDut(immutableMapping, timestamp, options),
    dutToRef: (timestamp) => mapDutToRef(immutableMapping, timestamp, options),
  });
}
