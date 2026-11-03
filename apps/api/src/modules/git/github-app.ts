import { createPrivateKey, createSign, type KeyObject } from 'node:crypto';
import { HttpError } from '#shared/lib';
import { pinnedFetch } from '#shared/net';
import { providerErrorMessage } from './connections-provider';

export interface GithubAppCredentials {
  apiBase: string;
  appId: string;
  installationId: string;
  privateKey: string;
}

interface MintedToken {
  token: string;
  expiresAt: number;
}

interface CachedToken {
  promise: Promise<MintedToken>;
  minted?: MintedToken;
}

const REFRESH_MARGIN_MS = 5 * 60_000;
const tokenCache = new Map<string, CachedToken>();

function privateKeyObject(privateKey: string): KeyObject {
  let key: KeyObject | null;
  try {
    key = createPrivateKey(privateKey);
  } catch {
    key = null;
  }
  if (key?.asymmetricKeyType !== 'rsa') {
    throw new HttpError(400, 'privateKey is not a valid PEM private key');
  }
  return key;
}

export function githubAppJwt(
  appId: string,
  privateKey: string,
  nowSeconds = Math.floor(Date.now() / 1000),
): string {
  const key = privateKeyObject(privateKey);
  const part = (value: object) => Buffer.from(JSON.stringify(value)).toString('base64url');
  const signingInput = `${part({ alg: 'RS256', typ: 'JWT' })}.${part({
    iat: nowSeconds - 60,
    exp: nowSeconds + 540,
    iss: appId,
  })}`;
  const signature = createSign('RSA-SHA256').update(signingInput).sign(key).toString('base64url');
  return `${signingInput}.${signature}`;
}

async function appRequest(
  app: GithubAppCredentials,
  path: string,
  method: 'GET' | 'POST',
): Promise<Response> {
  const headers = new Headers({
    authorization: `Bearer ${githubAppJwt(app.appId, app.privateKey)}`,
    accept: 'application/vnd.github+json',
    'x-github-api-version': '2022-11-28',
  });
  let response: Response;
  try {
    response = await pinnedFetch(`${app.apiBase}${path}`, { method, headers, timeoutMs: 15_000 });
  } catch (err) {
    if (err instanceof HttpError) throw err;
    throw new HttpError(
      502,
      'GitHub could not be reached. Check the provider URL and network access.',
    );
  }
  if (response.ok) return response;
  if (response.status === 401) {
    throw new HttpError(400, 'GitHub rejected the App ID or private key.');
  }
  if (response.status === 404) {
    throw new HttpError(400, 'GitHub could not find this installation of the App.');
  }
  const body = (await response.json().catch(() => null)) as { message?: unknown } | null;
  const message = typeof body?.message === 'string' ? body.message : '';
  throw new HttpError(
    response.status === 403 || response.status === 422 ? 400 : 502,
    providerErrorMessage(
      'github',
      response.status,
      message,
      response.headers.get('x-ratelimit-remaining'),
    ),
  );
}

function installationPath(app: GithubAppCredentials): string {
  return `/app/installations/${encodeURIComponent(app.installationId)}`;
}

export async function getGithubAppInstallation(
  app: GithubAppCredentials,
): Promise<{ accountLogin: string }> {
  const response = await appRequest(app, installationPath(app), 'GET');
  const body = (await response.json().catch(() => null)) as {
    account?: { login?: unknown } | null;
  } | null;
  const login = body?.account?.login;
  if (typeof login !== 'string' || !login) {
    throw new HttpError(502, 'GitHub returned an invalid App installation');
  }
  return { accountLogin: login };
}

async function mintInstallationToken(app: GithubAppCredentials): Promise<MintedToken> {
  const response = await appRequest(app, `${installationPath(app)}/access_tokens`, 'POST');
  const body = (await response.json().catch(() => null)) as {
    token?: unknown;
    expires_at?: unknown;
  } | null;
  const expiresAt = typeof body?.expires_at === 'string' ? Date.parse(body.expires_at) : NaN;
  if (typeof body?.token !== 'string' || !body.token || Number.isNaN(expiresAt)) {
    throw new HttpError(502, 'GitHub returned an invalid installation token');
  }
  return { token: body.token, expiresAt };
}

export async function githubInstallationToken(app: GithubAppCredentials): Promise<string> {
  const key = `${app.apiBase}|${app.appId}|${app.installationId}`;
  const cached = tokenCache.get(key);
  if (cached && (!cached.minted || cached.minted.expiresAt - Date.now() >= REFRESH_MARGIN_MS)) {
    return (await cached.promise).token;
  }
  const entry: CachedToken = { promise: mintInstallationToken(app) };
  tokenCache.set(key, entry);
  entry.promise.then(
    (minted) => {
      entry.minted = minted;
    },
    () => {
      if (tokenCache.get(key) === entry) tokenCache.delete(key);
    },
  );
  return (await entry.promise).token;
}
