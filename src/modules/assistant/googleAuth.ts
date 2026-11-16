/**
 * One-time Google sign-in: `npm run google:auth`. Opens the consent page,
 * catches the redirect on a loopback port and saves the refresh token to
 * GOOGLE_TOKEN_FILE (default data/google-token.json).
 *
 * An extra Gmail account: `npm run google:auth -- work`, signed in as that
 * account. It asks for Gmail only, saves to data/google-token-work.json, and
 * needs `work` listed in GOOGLE_EXTRA_ACCOUNTS.
 *
 * Setup, once, at console.cloud.google.com:
 * 1. Create a project and enable the Gmail API and the Google Calendar API.
 * 2. OAuth consent screen: External. Add yourself as a test user, or publish
 *    the app; tokens of apps left in Testing expire after 7 days.
 * 3. Credentials → OAuth client ID → Desktop app. Put its id and secret in
 *    .env as GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET, then run this.
 */
import 'dotenv/config';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CodeChallengeMethod, OAuth2Client } from 'google-auth-library';
import { GMAIL_SCOPES, GOOGLE_SCOPES, MAILBOX_NAME, extraTokenFile } from './google.js';

const clientId = process.env.GOOGLE_CLIENT_ID;
const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
const extra = process.argv[2]?.trim().toLowerCase();
if (extra && !MAILBOX_NAME.test(extra)) {
  console.error(`"${extra}" isn't a usable account name: letters, digits and dashes, not main or all (like work).`);
  process.exit(1);
}
const scopes = extra ? GMAIL_SCOPES : GOOGLE_SCOPES;
const tokenFile = extra ? extraTokenFile(extra) : process.env.GOOGLE_TOKEN_FILE || fileURLToPath(new URL('../../../data/google-token.json', import.meta.url));
if (extra) console.log(`Signing in the "${extra}" Gmail account (mail only). Pick that account on Google's page.`);
if (!clientId || !clientSecret) {
  console.error('Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET in .env first (see the comment at the top of this file).');
  process.exit(1);
}

const state = randomBytes(16).toString('hex');
const server = createServer();
await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
const redirectUri = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

const client = new OAuth2Client({ clientId, clientSecret, redirectUri });
const { codeVerifier, codeChallenge } = await client.generateCodeVerifierAsync();
const url = client.generateAuthUrl({
  access_type: 'offline',
  prompt: extra ? 'consent select_account' : 'consent',
  scope: scopes,
  state,
  code_challenge: codeChallenge,
  code_challenge_method: CodeChallengeMethod.S256,
});

console.log(`Open this URL to sign in:\n\n${url}\n`);
const opener = process.platform === 'win32' ? ['cmd', ['/c', 'start', '""', url]] : [process.platform === 'darwin' ? 'open' : 'xdg-open', [url]];
try {
  // Best effort; the URL is printed above either way.
  spawn(opener[0] as string, opener[1] as string[], { stdio: 'ignore', detached: true }).on('error', () => {}).unref();
} catch {}

const code = await new Promise<string>((resolve, reject) => {
  server.on('request', (req, res) => {
    const params = new URL(req.url ?? '/', redirectUri).searchParams;
    if (!params.has('code') && !params.has('error')) {
      res.writeHead(404).end();
      return;
    }
    const ok = params.get('state') === state && params.get('code');
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end(ok ? 'Squire is signed in. You can close this tab.' : 'Sign-in failed; check the terminal.');
    server.close();
    if (params.get('error')) reject(new Error(`Google returned: ${params.get('error')}`));
    else if (params.get('state') !== state) reject(new Error('State mismatch; ignoring this redirect. Run the command again.'));
    else resolve(params.get('code')!);
  });
}).catch((err: Error) => {
  console.error(err.message);
  process.exit(1);
});

const { tokens } = await client.getToken({ code, codeVerifier });
const granted = new Set((tokens.scope ?? '').split(/\s+/));
const missing = scopes.filter((s) => !granted.has(s));
if (missing.length) {
  console.error(
    `Some permissions weren't granted:\n${missing.map((s) => `  ${s}`).join('\n')}\n` +
      'Google lets you untick boxes on the consent page; run this again and leave them all ticked.',
  );
  process.exit(1);
}
if (!tokens.refresh_token) {
  console.error(
    'Google did not return a refresh token. Remove the app at https://myaccount.google.com/permissions and run this again.',
  );
  process.exit(1);
}

mkdirSync(dirname(tokenFile), { recursive: true });
writeFileSync(tokenFile, JSON.stringify({ refresh_token: tokens.refresh_token, scope: tokens.scope }, null, 2), { mode: 0o600 });
console.log(`Signed in. Token saved to ${tokenFile}.`);
if (extra && !(process.env.GOOGLE_EXTRA_ACCOUNTS ?? '').toLowerCase().split(/[\s,]+/).includes(extra)) {
  console.log(`Add it to .env so Squire reads it: GOOGLE_EXTRA_ACCOUNTS=${extra}`);
}
