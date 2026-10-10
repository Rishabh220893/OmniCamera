/** Reads the address a source is pulled from (login included) out of its record. */
import { SecretKeyError, type SecretBox } from './secretBox';
import type { SourceRecord } from './store';

export function openSourceAddress(rec: Pick<SourceRecord, 'sealed' | 'cameraId'>, box: SecretBox | null): { rtspUrl: string } {
  if (!rec.sealed) throw new SecretKeyError(`Source ${rec.cameraId} has no stored address.`);
  // A value that needs no secret (a camera with no login) is stored as plain JSON; everything else is sealed.
  if (!rec.sealed.startsWith('v1.')) return JSON.parse(rec.sealed) as { rtspUrl: string };
  if (!box) throw new SecretKeyError('SOURCE_SECRET_KEY is not set, so the stored login cannot be read.');
  return JSON.parse(box.open(rec.sealed)) as { rtspUrl: string };
}
