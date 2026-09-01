function gaussian(value, center, width) {
  const normalized = (value - center) / width;
  return Math.exp(-0.5 * normalized * normalized);
}

export function referenceSignal(timestamp, duration = 2_990) {
  const progress = timestamp / duration;
  const first =
    Math.sin(progress * Math.PI * 6.2)
    + 0.38 * Math.sin(progress * Math.PI * 17.4 + 0.3)
    + 1.2 * gaussian(progress, 0.19, 0.025)
    - 0.9 * gaussian(progress, 0.47, 0.035)
    + 1.5 * gaussian(progress, 0.78, 0.02);
  const second =
    0.7 * Math.cos(progress * Math.PI * 4.6 + 0.2)
    + 0.3 * Math.sin(progress * Math.PI * 22.1)
    - 1.1 * gaussian(progress, 0.32, 0.018)
    + 0.8 * gaussian(progress, 0.66, 0.045);
  return [first, second];
}

function deterministicNoise(index, dimension) {
  return 0.012 * Math.sin(index * 1.731 + dimension * 0.91) + 0.007 * Math.cos(index * 0.377 + dimension);
}

export function createSyntheticTracePair({
  referenceSamples = 300,
  referenceStep = 10,
  dutStep = 10,
  offset = 10_000,
  scale = 1.12,
  warpAmplitude = 80,
  prefix = 1_000,
  suffix = 1_000,
} = {}) {
  const referenceDuration = (referenceSamples - 1) * referenceStep;
  const expectedMap = (referenceTimestamp) =>
    offset
    + scale * referenceTimestamp
    + warpAmplitude * Math.sin((Math.PI * referenceTimestamp) / referenceDuration);

  const inverseMap = (dutTimestamp) => {
    let low = 0;
    let high = referenceDuration;
    for (let iteration = 0; iteration < 48; iteration += 1) {
      const middle = (low + high) / 2;
      if (expectedMap(middle) < dutTimestamp) low = middle;
      else high = middle;
    }
    return (low + high) / 2;
  };

  const referenceRows = new Array(referenceSamples);
  for (let index = 0; index < referenceSamples; index += 1) {
    const timestamp = index * referenceStep;
    referenceRows[index] = { timestamp, value: referenceSignal(timestamp, referenceDuration) };
  }

  const dutStart = offset - prefix;
  const dutEnd = expectedMap(referenceDuration) + suffix;
  const dutSamples = Math.floor((dutEnd - dutStart) / dutStep) + 1;
  const dutRows = new Array(dutSamples);
  for (let index = 0; index < dutSamples; index += 1) {
    const timestamp = dutStart + index * dutStep;
    let value;
    if (timestamp >= expectedMap(0) && timestamp <= expectedMap(referenceDuration)) {
      const referenceTimestamp = inverseMap(timestamp);
      value = referenceSignal(referenceTimestamp, referenceDuration).map(
        (channel, dimension) => channel * (dimension === 0 ? 1.18 : 0.87) + (dimension === 0 ? 0.22 : -0.13) + deterministicNoise(index, dimension),
      );
    } else {
      value = [
        0.45 * Math.sin(index * 0.071) + 0.22 * Math.cos(index * 0.19),
        0.35 * Math.cos(index * 0.049 + 1.1) - 0.18 * Math.sin(index * 0.23),
      ];
    }
    dutRows[index] = { timestamp, value };
  }

  return {
    referenceRows,
    dutRows,
    expectedMap,
    metadata: { referenceDuration, offset, scale, warpAmplitude, dutStart, dutEnd },
  };
}
