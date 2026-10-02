/**
 * Turns a raw Gemini frame analysis into the Firestore `logs` document.
 * Mirrors the logic that used to live inline in App.tsx's
 * captureAndAnalyzeCamera so browser- and server-produced logs are
 * indistinguishable to the rest of the app.
 */
export type Sentiment = 'calm' | 'neutral' | 'tense' | 'critical';
const SENTIMENTS: readonly Sentiment[] = ['calm', 'neutral', 'tense', 'critical'];

export interface AnalysisResult {
  summary?: string;
  counts?: { people: number; vehicles: number; other: number };
  brands?: string[];
  people_identified?: string[];
  alerts?: string[];
  isUnusual?: boolean;
  isUnusualReason?: string;
  detected_plates?: string[];
  watchlistMatches?: string[];
  sentiment?: string;
}

export interface CameraForLog {
  id: string;
  name: string;
  sensitivity: number;
  userId: string;
}

export function buildLogDocument(camera: CameraForLog, data: AnalysisResult, now: Date) {
  const detectedPlates = data.detected_plates ?? [];
  const watchlistMatches = data.watchlistMatches ?? [];
  const isWatchlistMatch = watchlistMatches.length > 0;
  const sentiment: Sentiment = SENTIMENTS.includes(data.sentiment as Sentiment) ? (data.sentiment as Sentiment) : 'neutral';
  const people = data.people_identified ?? [];
  const unknownPerson = people.includes('Unknown Person');

  const summary = `${data.summary ?? ''}${data.brands?.length ? ` Detected brands: ${data.brands.join(', ')}.` : ''} People: ${people.join(', ') || 'N/A'}`;
  const alerts = [...(data.alerts ?? [])];
  if (isWatchlistMatch) alerts.unshift(`Watchlist match: ${watchlistMatches.join(', ')}`);

  const isUnusual = isWatchlistMatch || Boolean(data.isUnusual) || (unknownPerson && camera.sensitivity > 3);
  return {
    cameraId: camera.id,
    cameraName: camera.name,
    summary,
    detectedItems: people,
    timestamp: now,
    userId: camera.userId,
    counts: data.counts ?? { people: 0, vehicles: 0, other: 0 },
    sentiment,
    isUnusual,
    unusualReason: data.isUnusualReason || (unknownPerson ? 'Unknown identity detected near camera' : ''),
    alerts,
    detectedPlates,
    isWatchlistMatch,
    // Marks logs the server produced, so they can be told apart if needed.
    analyzedBy: 'server' as const,
  };
}
