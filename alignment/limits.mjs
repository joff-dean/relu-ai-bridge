import { AlignmentError } from "./errors.mjs";

export const DEFAULT_LIMITS = Object.freeze({
  maxSamples: 100_000,
  maxDimensions: 16,
  maxFeatureValues: 1_600_000,
  maxCoarseSamples: 2_048,
  maxCoarseOperations: 12_000_000,
  maxDtwSamples: 2_048,
  maxDtwCells: 3_000_000,
  maxMappingPoints: 1_024,
  maxOperations: 50_000_000,
  timeBudgetMs: 15_000,
});

export const HARD_LIMITS = Object.freeze({
  maxSamples: 1_000_000,
  maxDimensions: 64,
  maxFeatureValues: 16_000_000,
  maxCoarseSamples: 8_192,
  maxCoarseOperations: 100_000_000,
  maxDtwSamples: 8_192,
  maxDtwCells: 16_000_000,
  maxMappingPoints: 8_192,
  maxOperations: 200_000_000,
  timeBudgetMs: 60_000,
});

export const MIN_LIMITS = Object.freeze({
  maxSamples: 2,
  maxDimensions: 1,
  maxFeatureValues: 2,
  maxCoarseSamples: 8,
  maxCoarseOperations: 64,
  maxDtwSamples: 2,
  maxDtwCells: 1,
  maxMappingPoints: 2,
  maxOperations: 1,
  timeBudgetMs: 1,
});

export function resolveLimits(overrides = {}) {
  if (overrides === null || typeof overrides !== "object" || Array.isArray(overrides)) {
    throw new AlignmentError("INVALID_OPTIONS", "limits는 객체여야 합니다.");
  }

  const resolved = { ...DEFAULT_LIMITS };
  for (const [key, value] of Object.entries(overrides)) {
    if (!(key in DEFAULT_LIMITS)) {
      throw new AlignmentError("INVALID_OPTIONS", `알 수 없는 limit 항목입니다: ${key}`);
    }
    if (!Number.isSafeInteger(value) || value < MIN_LIMITS[key] || value > HARD_LIMITS[key]) {
      throw new AlignmentError(
        "INVALID_OPTIONS",
        `${key}는 ${MIN_LIMITS[key]} 이상 ${HARD_LIMITS[key]} 이하의 안전한 정수여야 합니다.`,
        { key, value, minimum: MIN_LIMITS[key], hardMaximum: HARD_LIMITS[key] },
      );
    }
    resolved[key] = value;
  }
  return Object.freeze(resolved);
}
