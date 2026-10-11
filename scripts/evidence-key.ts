/**
 * Makes the Ed25519 key that signs evidence manifests (server/recording/evidence.ts).
 *
 *   npm run evidence-key                  prints the setting to add and writes the public key to evidence-public-key.pem
 *   npm run evidence-key -- --verify <manifest.json> <signature.json> [public-key.pem]
 *                                         checks a manifest and its signature offline, with nothing from the server
 *
 * Put the printed line in the server's environment (scale.local / .env.local) as EVIDENCE_SIGNING_KEY and keep the private key safe: whoever
 * holds it can sign manifests that verify. Keep a copy of the public key somewhere the server cannot change, so a signature can be checked
 * later even if the server is gone. A new key does not invalidate old signatures: verify each with the public key it names (`keyId`).
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { generateEvidenceKey, verifyManifest } from '../server/recording/evidence';

const args = process.argv.slice(2);
if (args[0] === '--verify') {
  const [, manifestFile, sigFile, pubFile = 'evidence-public-key.pem'] = args;
  if (!manifestFile || !sigFile || !existsSync(manifestFile) || !existsSync(sigFile) || !existsSync(pubFile)) { console.error('Usage: npm run evidence-key -- --verify <manifest.json> <manifest.sig.json> [public-key.pem]'); process.exit(2); }
  const ok = verifyManifest(JSON.parse(readFileSync(manifestFile, 'utf8')), JSON.parse(readFileSync(sigFile, 'utf8')), readFileSync(pubFile, 'utf8'));
  console.log(ok ? 'VALID: the manifest is the one the key signed.' : 'INVALID: the manifest was changed, or this is not the key that signed it.');
  process.exit(ok ? 0 : 1);
}
const k = generateEvidenceKey();
writeFileSync('evidence-public-key.pem', k.publicPem);
console.log(`Key id: ${k.keyId}\nPublic key written to evidence-public-key.pem (keep a copy somewhere safe; it is not secret).\n\nAdd this line to the server's environment (keep it secret):\n`);
console.log(`EVIDENCE_SIGNING_KEY="${k.privatePem.trim().replace(/\n/g, '\\n')}"`);
