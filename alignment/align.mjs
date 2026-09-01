import { AlignmentError, alignmentInvariant } from "./errors.mjs";
import { extractFeatures } from "./features.mjs";
import { findCoarseCandidates } from "./coarse.mjs";
import { constrainedDtw } from "./dtw.mjs";
import { createExecutionGuard } from "./guard.mjs";
import { resolveLimits } from "./limits.mjs";
import { buildTimeMapping, mapRefToDut } from "./mapping.mjs";
import { selectTimeRange, validateTimeSeries } from "./series.mjs";

const clamp01 = (value) => Math.max(0, Math.min(1, value));

function confidenceFor(coarse, dtw, allCandidates, signalQuality) {
  const next = allCandidates.find((candidate) => candidate !== coarse);
  const coarseSimilarity = clamp01(coarse.score);
  const dtwSimilarity = Math.exp(-Math.max(0, dtw.normalizedCost) / 2);
  const uniqueness = next ? clamp01((coarse.score - next.score) / 0.15) : 1;
  const nonDiagonal = dtw.diagnostics.upSteps + dtw.diagnostics.leftSteps;
  const pathQuality = clamp01(1 - nonDiagonal / Math.max(1, dtw.diagnostics.pathLength * 1.5));
  const boundaryQuality = clamp01(1 - dtw.diagnostics.boundaryHitRatio * 2);
  const evidenceScore = clamp01(
    coarseSimilarity * 0.25
      + dtwSimilarity * 0.4
      + uniqueness * 0.15
      + pathQuality * 0.1
      + boundaryQuality * 0.1,
  );
  const total = evidenceScore * signalQuality;
  return {
    total,
    components: { coarseSimilarity, dtwSimilarity, uniqueness, pathQuality, boundaryQuality, signalQuality },
  };
}

function publicCandidate(candidate) {
  return {
    dutStart: candidate.dutStart,
    dutEnd: candidate.dutEnd,
    scale: candidate.scale,
    score: candidate.score,
  };
}

export function alignTimeSeries(referenceInput, dutInput, options = {}) {
  const limits = resolveLimits(options.limits);
  const guard = createExecutionGuard({ signal: options.signal, limits });
  const minimumSamples = options.minimumSamples ?? 8;
  if (!Number.isSafeInteger(minimumSamples) || minimumSamples < 4 || minimumSamples > 1_024) {
    throw new AlignmentError("INVALID_OPTIONS", "minimumSamples는 4~1024의 정수여야 합니다.");
  }
  const reference = validateTimeSeries(referenceInput, { name: "reference", limits, minimumSamples });
  const dut = validateTimeSeries(dutInput, { name: "dut", limits, minimumSamples });
  alignmentInvariant(reference.dimensions === dut.dimensions, "DIMENSION_MISMATCH", "REF와 DUT의 value 차원이 다릅니다.", {
    reference: reference.dimensions,
    dut: dut.dimensions,
  });

  const featureOptions = options.features ?? {};
  const referenceFeatures = extractFeatures(reference, { ...featureOptions, limits, guard, name: "reference" });
  const dutFeatures = extractFeatures(dut, { ...featureOptions, limits, guard, name: "dut" });
  const coarseResult = findCoarseCandidates(referenceFeatures, dutFeatures, {
    ...(options.coarse ?? {}),
    limits,
    guard,
  });
  const referenceInformativeRatio =
    (reference.dimensions - referenceFeatures.normalization.constantChannels.length) / reference.dimensions;
  const dutInformativeRatio =
    (dut.dimensions - dutFeatures.normalization.constantChannels.length) / dut.dimensions;
  const signalQuality = Math.min(referenceInformativeRatio, dutInformativeRatio);

  const fineCandidateCount = options.fineCandidateCount ?? 3;
  if (!Number.isSafeInteger(fineCandidateCount) || fineCandidateCount < 1 || fineCandidateCount > 8) {
    throw new AlignmentError("INVALID_OPTIONS", "fineCandidateCount는 1~8의 정수여야 합니다.");
  }
  const fineResults = [];
  for (const candidate of coarseResult.candidates.slice(0, fineCandidateCount)) {
    const dtw = constrainedDtw(referenceFeatures, dutFeatures, candidate, {
      ...(options.dtw ?? {}),
      limits,
      guard,
    });
    const confidence = confidenceFor(candidate, dtw, coarseResult.candidates, signalQuality);
    fineResults.push({ candidate, dtw, confidence });
  }
  fineResults.sort((left, right) => right.confidence.total - left.confidence.total || left.dtw.normalizedCost - right.dtw.normalizedCost);
  const best = fineResults[0];
  if (!best) throw new AlignmentError("ALIGNMENT_FAILED", "정밀 정렬 결과가 없습니다.");

  const mapping = buildTimeMapping(best.dtw.path, { limits, ...(options.mapping ?? {}) });
  const warnings = [];
  if (best.confidence.total < 0.6) warnings.push("LOW_CONFIDENCE");
  if (signalQuality < 1) warnings.push("CONSTANT_CHANNELS");
  if (best.confidence.components.uniqueness < 0.35) warnings.push("AMBIGUOUS_COARSE_MATCH");
  if (best.dtw.diagnostics.boundaryHitRatio > 0.1) warnings.push("DTW_BAND_CONTACT");
  if (best.dtw.diagnostics.downsampled) warnings.push("DTW_DOWNSAMPLED");

  return {
    mappedRange: { ...mapping.dutRange },
    mapping: {
      points: mapping.points,
      refRange: mapping.refRange,
      dutRange: mapping.dutRange,
    },
    confidence: best.confidence.total,
    diagnostics: {
      input: {
        referenceSamples: reference.sampleCount,
        dutSamples: dut.sampleCount,
        dimensions: reference.dimensions,
        referenceRange: { start: reference.timestamps[0], end: reference.timestamps.at(-1) },
        dutRange: { start: dut.timestamps[0], end: dut.timestamps.at(-1) },
      },
      features: {
        mode: referenceFeatures.featureMetadata.mode,
        dimensions: referenceFeatures.featureDimensions,
        referenceConstantChannels: referenceFeatures.normalization.constantChannels,
        dutConstantChannels: dutFeatures.normalization.constantChannels,
      },
      coarse: {
        ...coarseResult.diagnostics,
        candidates: coarseResult.candidates.map(publicCandidate),
      },
      dtw: {
        normalizedCost: best.dtw.normalizedCost,
        alignedDutRange: best.dtw.alignedDutRange,
        ...best.dtw.diagnostics,
      },
      mapping: mapping.diagnostics,
      confidence: best.confidence.components,
      warnings,
      elapsedMs: guard.elapsedMs,
      operations: guard.operations,
    },
  };
}

export function alignSelection(
  { referenceRows, dutRows, selection },
  options = {},
) {
  const limits = resolveLimits(options.limits);
  const reference = validateTimeSeries(referenceRows, { name: "referenceRows", limits, minimumSamples: 2 });
  alignmentInvariant(selection && Number.isFinite(selection.start) && Number.isFinite(selection.end), "INVALID_RANGE", "selection.start/end가 필요합니다.");
  const selectedReference = selectTimeRange(reference, selection, limits.maxSamples);
  const result = alignTimeSeries(selectedReference, dutRows, options);
  return {
    ...result,
    mappedRange: {
      start: mapRefToDut(result.mapping, selection.start),
      end: mapRefToDut(result.mapping, selection.end),
    },
    diagnostics: {
      ...result.diagnostics,
      selection: { start: selection.start, end: selection.end },
    },
  };
}
