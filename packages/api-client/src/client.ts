import { z } from 'zod';
import {
  AuthResponse, Device, DeviceList, DownloadUrlResponse, EnrollmentResponse, EnvelopeResponse, PullResponse, PushResponse,
  RecoverResponse, ServerItem, SyncHead, UploadSignatureResponse, VaultStateResponse,
  type ConfirmUploadRequest, type GoogleSignInRequest, type InitVaultRequest, type PublishEnvelopesRequest, type PushRequest,
  type RecoverRequest, type RefreshRequest, type UploadSignatureRequest,
} from '@clipply/shared-schemas';

const NoContent = z.undefined();

export type ApiErrorKind =
  | 'network' | 'timeout' | 'unauthorized' | 'forbidden' | 'not_found' | 'conflict'
  | 'gone' | 'invalid_request' | 'rate_limited' | 'server' | 'bad_response';

/** Error messages carry status and server error code only, never request or response bodies. */
export class ApiError extends Error {
  override name = 'ApiError';

  constructor(
    readonly kind: ApiErrorKind,
    message: string,
    readonly status?: number,
    readonly retryAfterMs?: number,
  ) {
    super(message);
  }

  /** Worth retrying later with backoff. */
  get retryable(): boolean {
    return this.kind === 'network' || this.kind === 'timeout' || this.kind === 'server' || this.kind === 'rate_limited';
  }
}

export interface ApiClientOptions {
  baseUrl: string;
  /** Current access token, or null when signed out. */
  getAccessToken: () => Promise<string | null>;
  /** Called once on 401; resolves true if a new access token is now available. */
  refreshSession?: () => Promise<boolean>;
  fetch?: typeof fetch;
  timeoutMs?: number;
}

const STATUS_KIND: Record<number, ApiErrorKind> = {
  400: 'invalid_request', 401: 'unauthorized', 403: 'forbidden', 404: 'not_found',
  409: 'conflict', 410: 'gone', 413: 'invalid_request', 422: 'invalid_request', 429: 'rate_limited',
};

export function createApiClient(options: ApiClientOptions) {
  const doFetch = options.fetch ?? globalThis.fetch.bind(globalThis);
  const timeoutMs = options.timeoutMs ?? 15_000;
  const base = options.baseUrl.replace(/\/+$/, '');

  async function send(method: string, path: string, body: unknown, authed: boolean): Promise<Response> {
    const token = authed ? await options.getAccessToken() : null;
    const headers: Record<string, string> = { accept: 'application/json' };
    if (token) headers.authorization = `Bearer ${token}`;
    if (body !== undefined) headers['content-type'] = 'application/json';
    try {
      return await doFetch(`${base}${path}`, {
        method,
        headers,
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      const name = (error as { name?: string }).name;
      if (name === 'TimeoutError' || name === 'AbortError') throw new ApiError('timeout', `${method} ${path} timed out`);
      throw new ApiError('network', `${method} ${path} failed: network error`);
    }
  }

  async function request<S extends z.ZodType>(method: string, path: string, schema: S, body?: unknown, authed = true): Promise<z.infer<S>> {
    let res = await send(method, path, body, authed);
    if (authed && res.status === 401 && options.refreshSession && (await options.refreshSession())) {
      res = await send(method, path, body, authed);
    }
    if (!res.ok) {
      let code = '';
      try {
        const err = (await res.json()) as { error?: unknown };
        if (typeof err.error === 'string') code = `: ${err.error.slice(0, 80)}`;
      } catch {
        // Non-JSON error bodies are expected from proxies; the status alone classifies them.
      }
      const retryAfter = Number(res.headers.get('retry-after'));
      throw new ApiError(
        STATUS_KIND[res.status] ?? (res.status >= 500 ? 'server' : 'invalid_request'),
        `${method} ${path} → ${res.status}${code}`,
        res.status,
        Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : undefined,
      );
    }
    if (res.status === 204) {
      if (schema !== (NoContent as z.ZodType)) throw new ApiError('bad_response', `${method} ${path}: unexpected empty response`, 204);
      return undefined as z.infer<S>;
    }
    let json: unknown;
    try {
      json = await res.json();
    } catch {
      throw new ApiError('bad_response', `${method} ${path}: response is not JSON`, res.status);
    }
    const parsed = schema.safeParse(json);
    if (!parsed.success) throw new ApiError('bad_response', `${method} ${path}: response failed validation`, res.status);
    return parsed.data;
  }

  return {
    syncHead: () => request('GET', '/v1/sync/head', SyncHead),
    pull: (cursor: number, limit = 200) =>
      request('GET', `/v1/sync/pull?cursor=${encodeURIComponent(cursor)}&limit=${encodeURIComponent(limit)}`, PullResponse),
    push: (body: PushRequest) => request('POST', '/v1/sync/push', PushResponse, body),
    getItem: (id: string) => request('GET', `/v1/items/${encodeURIComponent(id)}`, ServerItem),

    // Auth calls carry no access token; the refresh token is the credential.
    signInWithGoogle: (body: GoogleSignInRequest) => request('POST', '/v1/auth/google', AuthResponse, body, false),
    refresh: (body: RefreshRequest) => request('POST', '/v1/auth/refresh', AuthResponse, body, false),
    logout: (body: RefreshRequest) => request('POST', '/v1/auth/logout', NoContent, body, false),

    listDevices: () => request('GET', '/v1/devices', DeviceList),
    renameDevice: (id: string, name: string) => request('PATCH', `/v1/devices/${encodeURIComponent(id)}`, Device, { name }),
    revokeDevice: (id: string) => request('POST', `/v1/devices/${encodeURIComponent(id)}/revoke`, Device),

    vaultState: () => request('GET', '/v1/vault/state', VaultStateResponse),
    initVault: (body: InitVaultRequest) => request('POST', '/v1/vault/init', NoContent, body),
    envelope: () => request('GET', '/v1/vault/envelope', EnvelopeResponse),
    claimDevice: (id: string) => request('POST', `/v1/vault/claim/${encodeURIComponent(id)}`, NoContent),
    enrollment: () => request('GET', '/v1/vault/enrollment', EnrollmentResponse),
    publishEnvelopes: (body: PublishEnvelopesRequest) => request('POST', '/v1/vault/envelopes', NoContent, body),
    recover: (body: RecoverRequest) => request('POST', '/v1/vault/recover', RecoverResponse, body),

    uploadSignature: (body: UploadSignatureRequest) => request('POST', '/v1/storage/upload-signature', UploadSignatureResponse, body),
    confirmUpload: (body: ConfirmUploadRequest) => request('POST', '/v1/storage/confirm', NoContent, body),
    downloadUrl: (itemId: string) => request('GET', `/v1/storage/download-url?itemId=${encodeURIComponent(itemId)}`, DownloadUrlResponse),
  };
}

export type ApiClient = ReturnType<typeof createApiClient>;
