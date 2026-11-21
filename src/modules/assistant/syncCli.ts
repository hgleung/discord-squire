/**
 * Runs the read-only syncs once, now: Calendar, Bookings and Places into
 * Squire/Sync/. The bot also runs them nightly. No model calls, so no API
 * cost; Google and Maps are only read.
 *
 *   npm run sync
 */
import 'dotenv/config';
import { fileURLToPath } from 'node:url';
import { Vault } from '../../vault.js';
import { GoogleAccount } from './google.js';
import { PlaceStore } from './places.js';
import { runSyncs } from './sync.js';
import { systemTimeZone } from './time.js';

const env = (name: string) => process.env[name]?.trim() || undefined;
const root = env('OBSIDIAN_VAULT');
if (!root) {
  console.error('OBSIDIAN_VAULT is not set.');
  process.exit(1);
}
const timeZone = env('ASSISTANT_TIMEZONE') ?? systemTimeZone();
let google: GoogleAccount | undefined;
const clientId = env('GOOGLE_CLIENT_ID');
const clientSecret = env('GOOGLE_CLIENT_SECRET');
if (clientId && clientSecret) {
  try {
    google = new GoogleAccount({ clientId, clientSecret, tokenFile: env('GOOGLE_TOKEN_FILE') ?? fileURLToPath(new URL('../../../data/google-token.json', import.meta.url)) });
  } catch (err) {
    console.error(`Google is off: ${err instanceof Error ? err.message : String(err)}`);
  }
}
// The places the bot already synced from your Maps lists; this reads its file, it doesn't call Maps.
const places = new PlaceStore(env('PLACES_FILE') ?? fileURLToPath(new URL('../../../data/places.json', import.meta.url))).data.places;
const status = await runSyncs(new Vault(root), { google, places: places.length ? places : undefined }, timeZone);
console.log(status.length ? status.join('\n') : 'Nothing to sync: no Google account and no saved places.');
