import { createHash, randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';

export interface GoogleOAuthOptions {
  clientId: string;
  /** Google issues "Desktop app" clients a secret that is not confidential (RFC 8252 §8.5); PKCE protects the flow. */
  clientSecret: string;
  openBrowser: (url: string) => Promise<void>;
  fetch?: typeof fetch;
  timeoutMs?: number;
}

const b64url = (b: Buffer): string => b.toString('base64url');

const DONE_PAGE = `<!doctype html><meta charset="utf-8"><title>Clipply</title>
<body style="font-family:system-ui;background:#14161c;color:#eee;display:grid;place-items:center;height:100vh;margin:0">
<p>Signed in. You can close this tab and return to Clipply.</p></body>`;

/**
 * Google sign-in for a native app (RFC 8252): system browser, loopback redirect on 127.0.0.1 with a
 * random port, PKCE S256 and a state check. Returns the Google ID token, which only identifies the
 * account; it grants no vault access.
 */
export async function googleSignIn(o: GoogleOAuthOptions): Promise<string> {
  const doFetch = o.fetch ?? fetch;
  const verifier = b64url(randomBytes(32));
  const challenge = b64url(createHash('sha256').update(verifier).digest());
  const state = b64url(randomBytes(16));

  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const redirectUri = `http://127.0.0.1:${(server.address() as AddressInfo).port}/callback`;

  try {
    const code = await new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('sign-in timed out')), o.timeoutMs ?? 5 * 60_000);
      server.on('request', (req, res) => {
        const url = new URL(req.url ?? '/', redirectUri);
        if (url.pathname !== '/callback') {
          res.writeHead(404).end();
          return;
        }
        const ok = url.searchParams.get('state') === state && url.searchParams.get('code');
        res.writeHead(ok ? 200 : 400, { 'content-type': 'text/html; charset=utf-8' }).end(ok ? DONE_PAGE : 'Sign-in failed.');
        clearTimeout(timer);
        if (ok) resolve(url.searchParams.get('code')!);
        else reject(new Error(url.searchParams.get('error') ?? 'invalid OAuth callback'));
      });
      const auth = new URL('https://accounts.google.com/o/oauth2/v2/auth');
      auth.search = new URLSearchParams({
        client_id: o.clientId, redirect_uri: redirectUri, response_type: 'code', scope: 'openid email',
        code_challenge: challenge, code_challenge_method: 'S256', state, prompt: 'select_account',
      }).toString();
      o.openBrowser(auth.toString()).catch(reject);
    });

    const res = await doFetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code, client_id: o.clientId, client_secret: o.clientSecret, redirect_uri: redirectUri,
        grant_type: 'authorization_code', code_verifier: verifier,
      }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) throw new Error(`Google token exchange failed (${res.status})`);
    const json = (await res.json()) as { id_token?: unknown };
    if (typeof json.id_token !== 'string') throw new Error('Google returned no ID token');
    return json.id_token;
  } finally {
    server.close();
  }
}
