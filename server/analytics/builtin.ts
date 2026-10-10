/**
 * The analyzers the platform ships with. Gemini and the plate reader used to be called directly from analyzeFrame in server.ts;
 * they are the same code behind the Analyzer contract now, and `sceneFinalizer` does the plate merge and watchlist check as before.
 */
import { mergePlates } from '../plateMerge';
import type { PlateRead } from '../anprClient';
import type { AnalysisResult } from '../logEntry';
import type { Analyzer, FinalizeContext, Finalizer } from './types';

export type GenerateFn = (params: { contents: { parts: unknown[] }; config?: Record<string, unknown> }) => Promise<{ text?: string }>;

export function createGeminiSceneAnalyzer(deps: { generate: GenerateFn; log?: Pick<Console, 'log'> }): Analyzer {
  const log = deps.log ?? console;
  return {
    id: 'gemini-scene',
    label: 'Gemini scene analysis',
    description: 'Describes the scene, counts people and vehicles, recognises known faces, reads brands and judges whether anything is unusual.',
    required: true,
    async analyze({ camera, frame, user }) {
      const faces = (user.knownFaces || []).slice(0, 6);
      const faceDataParts = faces.map((face) => ({
        inlineData: {
          mimeType: 'image/jpeg',
          data: face.imageData.includes(',') ? face.imageData.split(',')[1] : face.imageData,
        },
      }));

      const knownFacesContext = faces.length > 0
        ? `\nREFERENCE DATA: I have provided ${faceDataParts.length} images of known people as reference.
       Their names are: ${faces.map((f) => f.name).join(', ')}.
       If you see a person in the MAIN FEED FRAME, compare them visually to these reference images.
       - If they match a reference image, identify them by that name.
       - If they do NOT match any reference image, label them as "Unknown Person".`
        : '';

      log.log(`[GEMINI VISION] Analyzing frame for camera: "${camera?.name ?? 'Unknown'}"`);

      const response = await deps.generate({
        contents: {
          parts: [
            { text: 'KNOWN INDIVIDUALS REFERENCE IMAGES (If provided):' },
            ...faceDataParts,
            { text: 'MAIN CAMERA FEED FRAME TO ANALYZE:' },
            { inlineData: { mimeType: 'image/jpeg', data: frame.base64 } },
            {
              text: `Act as a security AI monitoring a camera feed.
          Objective: Provide a real-time summary, count objects, identify people, and detect brands.

          Current System Configuration:
          - Camera Name: ${camera?.name ?? 'Unknown'}
          - Anomaly Sensitivity: ${camera?.sensitivity ?? 5}/10
          - People count (informational, for the trend chart only — NOT grounds for an alert on its own): ${camera?.peopleThreshold ?? 5}
          - Vehicle count (informational, for the trend chart only — NOT grounds for an alert on its own): ${camera?.vehicleThreshold ?? 2}
          ${camera?.suspiciousRules ? `- CUSTOM SUSPICIOUS RULES: ${camera.suspiciousRules}` : ''}
          ${knownFacesContext}

          Tasks:
          1. A brief summary of events. IMPORTANT: Mention identified people by their names in the summary.
          2. Count people, vehicles, and notable objects.
          3. Identify any visible brands on products, clothing, or environment.
          4. Check for genuinely malicious, harmful, or suspicious activity — weapons, forced entry,
             vandalism, trespassing, loitering with intent, an unknown person behaving suspiciously, or
             anything matching the custom suspicious rules above. A busy or crowded scene is NOT by
             itself unusual — do not flag isUnusual or write an alert merely because a lot of people or
             vehicles are present. Only raise isUnusual/alerts for content that would actually warrant a
             human operator's attention for security reasons.
          5. Read any vehicle license/number plates that are legible in the frame.
          6. Rate the overall mood/threat level of the scene as one of: "calm" (ordinary, nothing of
             note), "neutral" (unremarkable activity), "tense" (something worth watching but not yet
             alarming), "critical" (matches an alert-worthy situation from task 4).

          Output MUST be strict JSON:
          {
            "summary": "Short 1-sentence summary mentioning names if identified",
            "counts": { "people": number, "vehicles": number, "other": number },
            "brands": ["List of identified brands"],
            "people_identified": ["Names of identified known members or 'Unknown Person'"],
            "alerts": ["List of specific malicious/harmful/suspicious warnings only — do NOT include plain crowd/traffic-count observations here"],
            "isUnusual": boolean,
            "isUnusualReason": "Explain WHY it was marked unusual — must be a malicious/harmful/suspicious reason, never just a headcount",
            "detected_plates": ["Any legible vehicle plate numbers, uppercase, no spaces"],
            "sentiment": "calm" | "neutral" | "tense" | "critical"
          }`,
            },
          ],
        },
        config: { responseMimeType: 'application/json' },
      });
      return { fields: JSON.parse(response.text || '{}') as Partial<AnalysisResult> };
    },
  };
}

/** The dedicated plate reader. Not required: when it is down the scene analysis still goes through with Gemini's plates. */
export function createAnprAnalyzer(client: { detect(jpeg: Buffer): Promise<PlateRead[]> }): Analyzer {
  return {
    id: 'anpr-plates',
    label: 'Plate reader (ANPR)',
    description: 'Reads vehicle plates with a dedicated detector and OCR. When it answers, its plates replace the ones Gemini guessed.',
    async analyze({ frame }) {
      return { signals: { reads: await client.detect(frame.jpeg) } };
    },
  };
}

/**
 * Decides which plates the frame reports (ANPR when it answered, else Gemini's) and checks them against the user's watchlist.
 * Behaves exactly as the old inline code in analyzeFrame did.
 */
export function createSceneFinalizer(log: Pick<Console, 'warn'> = console): Finalizer {
  return (data: AnalysisResult, ctx: FinalizeContext): AnalysisResult => {
    const o = ctx.outcomes.get('anpr-plates');
    const anpr = !o || o.skipped ? null : o.ok ? { reads: (o.output?.signals?.reads ?? []) as PlateRead[] } : { error: o.error };
    const merged = mergePlates((data.detected_plates || []).map(String), anpr);
    const watchlistSet = new Set((ctx.input.user.watchlist || []).map((p) => String(p).toUpperCase().replace(/[^A-Z0-9]/g, '')));
    const watchlistMatches = merged.plates.filter((p) => watchlistSet.has(p));
    if (watchlistMatches.length > 0) {
      log.warn(`[WATCHLIST MATCH] Camera "${ctx.input.camera?.name ?? 'Unknown'}" — plates: ${watchlistMatches.join(', ')} (source: ${merged.source})`);
    }
    return { ...data, detected_plates: merged.plates, watchlistMatches, plate_reads: merged.reads, plate_source: merged.source };
  };
}
