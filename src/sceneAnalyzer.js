export const ANALYSIS_INTERVAL_MS = 30_000;

export function createEmptySignals() {
  return {
    people: 0,
    vehicles: 0,
    faces: 0,
    brightness: 0,
    motion: 0,
    dominantTone: 'unknown',
    observedFaces: [],
    timestamp: new Date().toISOString(),
  };
}

export function toneFromRgb(r, g, b) {
  const max = Math.max(r, g, b);
  if (max < 35) return 'very dark';
  if (r > g * 1.15 && r > b * 1.15) return 'warm/red';
  if (g > r * 1.1 && g > b * 1.05) return 'green/outdoor';
  if (b > r * 1.1 && b > g * 1.05) return 'cool/blue';
  if (max > 205) return 'bright/neutral';
  return 'neutral';
}

export function estimateObjectsFromFrame({ brightness, motion, edgeDensity, faceCount = 0 }) {
  const people = Math.max(faceCount, Math.round(edgeDensity * 2.4 + motion * 1.8));
  const vehicles = Math.max(0, Math.round(edgeDensity * 1.6 + (brightness > 0.55 ? motion : 0) - faceCount * 0.35));

  return {
    people: Math.min(12, people),
    vehicles: Math.min(8, vehicles),
  };
}

export function summarizeScene(signals, cameraName = 'Camera') {
  const parts = [];
  parts.push(`${cameraName} shows a ${signals.dominantTone} scene`);

  if (signals.people > 0) {
    parts.push(`${signals.people} possible ${signals.people === 1 ? 'person' : 'people'}`);
  } else {
    parts.push('no obvious people');
  }

  if (signals.vehicles > 0) {
    parts.push(`${signals.vehicles} possible ${signals.vehicles === 1 ? 'vehicle' : 'vehicles'}`);
  }

  if (signals.faces > 0) {
    const named = signals.observedFaces.filter(Boolean);
    parts.push(named.length ? `recognized: ${named.join(', ')}` : `${signals.faces} face candidate${signals.faces === 1 ? '' : 's'}`);
  }

  if (signals.motion > 0.45) parts.push('active motion detected');
  if (signals.motion <= 0.12) parts.push('little movement');

  return `${parts.join('; ')}.`;
}

export function analyzeImageData(imageData, previousImageData, faceNames = []) {
  if (!imageData?.data?.length) return createEmptySignals();

  const data = imageData.data;
  const prev = previousImageData?.data;
  let total = 0;
  let r = 0;
  let g = 0;
  let b = 0;
  let changed = 0;
  let edges = 0;
  const sampleStride = 16;

  for (let i = 0; i < data.length; i += 4 * sampleStride) {
    const cr = data[i];
    const cg = data[i + 1];
    const cb = data[i + 2];
    const luminance = (cr + cg + cb) / 3;
    r += cr;
    g += cg;
    b += cb;
    total += luminance;

    if (prev?.length === data.length) {
      const delta = Math.abs(cr - prev[i]) + Math.abs(cg - prev[i + 1]) + Math.abs(cb - prev[i + 2]);
      if (delta > 75) changed += 1;
    }

    const nextIndex = i + 4 * sampleStride;
    if (nextIndex < data.length) {
      const nextLum = (data[nextIndex] + data[nextIndex + 1] + data[nextIndex + 2]) / 3;
      if (Math.abs(luminance - nextLum) > 38) edges += 1;
    }
  }

  const samples = Math.max(1, Math.floor(data.length / (4 * sampleStride)));
  const brightness = total / samples / 255;
  const motion = prev?.length === data.length ? changed / samples : 0;
  const edgeDensity = edges / samples;
  const faceCount = Math.min(faceNames.length, Math.max(0, Math.round(edgeDensity * 1.8 + (brightness > 0.35 ? 0.5 : 0))));
  const objects = estimateObjectsFromFrame({ brightness, motion, edgeDensity, faceCount });

  return {
    ...objects,
    faces: faceCount,
    brightness: Number(brightness.toFixed(2)),
    motion: Number(motion.toFixed(2)),
    dominantTone: toneFromRgb(r / samples, g / samples, b / samples),
    observedFaces: faceNames.slice(0, faceCount),
    timestamp: new Date().toISOString(),
  };
}
