import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from 'jose';

export interface GoogleIdentity {
  sub: string;
  email: string;
}

export type GoogleVerifier = (idToken: string) => Promise<GoogleIdentity | null>;

const GOOGLE_JWKS = new URL('https://www.googleapis.com/oauth2/v3/certs');

/**
 * Verifies a Google OpenID Connect ID token: signature (Google JWKS, cached by jose), issuer,
 * audience (our OAuth client IDs), expiry, and a verified email.
 */
export function googleVerifier(clientIds: string[], keys: JWTVerifyGetKey = createRemoteJWKSet(GOOGLE_JWKS)): GoogleVerifier {
  return async (idToken) => {
    try {
      const { payload } = await jwtVerify(idToken, keys, {
        issuer: ['https://accounts.google.com', 'accounts.google.com'],
        audience: clientIds,
        algorithms: ['RS256'],
      });
      if (typeof payload.sub !== 'string' || typeof payload.email !== 'string' || payload.email_verified !== true) return null;
      return { sub: payload.sub, email: payload.email };
    } catch {
      return null;
    }
  };
}
