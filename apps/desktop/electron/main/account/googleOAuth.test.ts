import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';

import { googleSignIn } from './googleOAuth';

/** Plays the browser: follows Google's redirect back to the loopback server with a code. */
const browser = (code: string | null, tamperState = false) => async (url: string): Promise<void> => {
  const u = new URL(url);
  const back = new URL(u.searchParams.get('redirect_uri')!);
  back.searchParams.set('state', tamperState ? 'evil' : u.searchParams.get('state')!);
  if (code) back.searchParams.set('code', code);
  else back.searchParams.set('error', 'access_denied');
  setTimeout(() => void fetch(back), 10);
};

describe('googleSignIn (loopback + PKCE)', () => {
  it('exchanges the code with the matching PKCE verifier and returns the ID token', async () => {
    let challenge = '';
    let sent: URLSearchParams | null = null;
    const token = await googleSignIn({
      clientId: 'cid', clientSecret: 'csecret',
      openBrowser: async (url) => {
        const u = new URL(url);
        expect(u.origin + u.pathname).toBe('https://accounts.google.com/o/oauth2/v2/auth');
        expect(u.searchParams.get('code_challenge_method')).toBe('S256');
        expect(new URL(u.searchParams.get('redirect_uri')!).hostname).toBe('127.0.0.1');
        challenge = u.searchParams.get('code_challenge')!;
        await browser('auth-code')(url);
      },
      fetch: (async (_url: string, init: RequestInit) => {
        sent = new URLSearchParams(init.body as URLSearchParams);
        return new Response(JSON.stringify({ id_token: 'the-id-token' }), { status: 200 });
      }) as typeof fetch,
    });
    expect(token).toBe('the-id-token');
    expect(sent!.get('code')).toBe('auth-code');
    expect(createHash('sha256').update(sent!.get('code_verifier')!).digest('base64url')).toBe(challenge);
  });

  it('rejects a callback with the wrong state or a denial', async () => {
    const fetchNever = (async () => { throw new Error('must not exchange'); }) as typeof fetch;
    await expect(googleSignIn({ clientId: 'c', clientSecret: 's', openBrowser: browser('x', true), fetch: fetchNever })).rejects.toThrow(/invalid OAuth callback/);
    await expect(googleSignIn({ clientId: 'c', clientSecret: 's', openBrowser: browser(null), fetch: fetchNever })).rejects.toThrow(/access_denied/);
  });
});
