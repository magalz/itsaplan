import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { HttpError } from '#shared/lib';
import { getGithubAppInstallation, githubInstallationToken } from '../../github-app';
import type { GithubAppCredentials } from '../../github-app';
import { appKeyPair, isValidAppJwt } from '../helpers';

// A GitHub App served on localhost. The SSRF guard refuses http and loopback hosts under
// NODE_ENV=test, so each case runs as development. Every fake has its own installation id,
// which is part of the token cache key, so no case sees a token another one minted, even when
// the system hands a freed port to a later fake.

const APP_ID = '4242';
let installations = 1000;
const PREFIX = '/api/v3';

const appKeys = appKeyPair();
const otherKeys = appKeyPair();

interface FakeOptions {
  installationStatus?: number;
  installationBody?: unknown;
  expiresIn?: number[];
  failMints?: number;
  mintBody?: unknown;
}

function fakeGithub(options: FakeOptions = {}) {
  const seen: { method: string; path: string; accept: string | null; version: string | null }[] =
    [];
  const installationId = String(++installations);
  const expiresIn = [...(options.expiresIn ?? [])];
  let mints = 0;

  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const path = new URL(req.url).pathname.slice(PREFIX.length);
      seen.push({
        method: req.method,
        path,
        accept: req.headers.get('accept'),
        version: req.headers.get('x-github-api-version'),
      });
      if (!isValidAppJwt(req.headers.get('authorization'), APP_ID, appKeys.publicKey)) {
        return Response.json({ message: 'Bad credentials' }, { status: 401 });
      }
      const installation = `/app/installations/${installationId}`;
      if (path === installation && req.method === 'GET') {
        if (options.installationStatus) {
          return Response.json({}, { status: options.installationStatus });
        }
        return Response.json(
          options.installationBody ?? { id: Number(installationId), account: { login: 'acme' } },
        );
      }
      if (path === `${installation}/access_tokens` && req.method === 'POST') {
        mints += 1;
        await Bun.sleep(20);
        if (mints <= (options.failMints ?? 0)) {
          return Response.json({ message: 'Server Error' }, { status: 500 });
        }
        const seconds = expiresIn.shift() ?? 3600;
        return Response.json(
          options.mintBody ?? {
            token: `ghs_${mints}`,
            expires_at: new Date(Date.now() + seconds * 1000).toISOString(),
          },
          { status: 201 },
        );
      }
      return Response.json({ message: 'Not Found' }, { status: 404 });
    },
  });
  return {
    seen,
    installationId,
    mints: () => mints,
    app: (overrides: Partial<GithubAppCredentials> = {}): GithubAppCredentials => ({
      apiBase: `http://127.0.0.1:${server.port}${PREFIX}`,
      appId: APP_ID,
      installationId,
      privateKey: appKeys.privateKey,
      ...overrides,
    }),
    stop: () => server.stop(true),
  };
}

async function rejection(promise: Promise<unknown>): Promise<HttpError> {
  const error = await promise.then(
    () => null,
    (err: unknown) => err,
  );
  expect(error).toBeInstanceOf(HttpError);
  return error as HttpError;
}

describe('GitHub App credentials', () => {
  const environment = process.env.NODE_ENV;
  let fake: ReturnType<typeof fakeGithub> | null = null;

  function serve(options?: FakeOptions) {
    fake = fakeGithub(options);
    return fake;
  }

  beforeEach(() => {
    process.env.NODE_ENV = 'development';
  });

  afterEach(() => {
    fake?.stop();
    fake = null;
    if (environment === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = environment;
  });

  describe('getGithubAppInstallation', () => {
    it('returns the account the App is installed on', async () => {
      const github = serve();
      await expect(getGithubAppInstallation(github.app())).resolves.toEqual({
        accountLogin: 'acme',
      });
      expect(github.seen).toEqual([
        {
          method: 'GET',
          path: `/app/installations/${github.installationId}`,
          accept: 'application/vnd.github+json',
          version: '2022-11-28',
        },
      ]);
    });

    it('answers 502 when the installation has no account login', async () => {
      const github = serve({ installationBody: { id: 777, account: {} } });
      const error = await rejection(getGithubAppInstallation(github.app()));
      expect(error.status).toBe(502);
      expect(error.message).toBe('GitHub returned an invalid App installation');
    });

    it('answers 400 when GitHub rejects the App ID or the private key', async () => {
      const github = serve();
      const error = await rejection(
        getGithubAppInstallation(github.app({ privateKey: otherKeys.privateKey })),
      );
      expect(error.status).toBe(400);
      expect(error.message).toBe('GitHub rejected the App ID or private key.');
    });

    it('answers 400 when the installation does not exist', async () => {
      const github = serve();
      const error = await rejection(getGithubAppInstallation(github.app({ installationId: '9' })));
      expect(error.status).toBe(400);
      expect(error.message).toBe('GitHub could not find this installation of the App.');
    });

    it('answers 400 for a refused request and 502 for a provider failure', async () => {
      const denied = serve({ installationStatus: 403 });
      const deniedError = await rejection(getGithubAppInstallation(denied.app()));
      expect(deniedError.status).toBe(400);
      expect(deniedError.message).toBe(
        'GitHub denied access. Check the token permissions and organization policy.',
      );
      denied.stop();

      const broken = serve({ installationStatus: 500 });
      const brokenError = await rejection(getGithubAppInstallation(broken.app()));
      expect(brokenError.status).toBe(502);
      expect(brokenError.message).toBe('GitHub request failed with status 500.');
    });

    it('answers 502 when GitHub cannot be reached', async () => {
      const github = serve();
      const app = github.app();
      github.stop();
      const error = await rejection(getGithubAppInstallation(app));
      expect(error.status).toBe(502);
      expect(error.message).toBe(
        'GitHub could not be reached. Check the provider URL and network access.',
      );
    });
  });

  describe('githubInstallationToken', () => {
    it('mints a token and reuses it while it stays valid', async () => {
      const github = serve();
      const app = github.app();
      expect(await githubInstallationToken(app)).toBe('ghs_1');
      expect(await githubInstallationToken(app)).toBe('ghs_1');
      expect(github.mints()).toBe(1);
      expect(github.seen[0]).toMatchObject({
        method: 'POST',
        path: `/app/installations/${github.installationId}/access_tokens`,
        accept: 'application/vnd.github+json',
        version: '2022-11-28',
      });
    });

    it('shares one mint between concurrent callers', async () => {
      const github = serve();
      const app = github.app();
      const tokens = await Promise.all([
        githubInstallationToken(app),
        githubInstallationToken(app),
      ]);
      expect(tokens).toEqual(['ghs_1', 'ghs_1']);
      expect(github.mints()).toBe(1);
    });

    it('replaces a token that has less than five minutes left', async () => {
      const github = serve({ expiresIn: [240, 3600] });
      const app = github.app();
      expect(await githubInstallationToken(app)).toBe('ghs_1');
      expect(await githubInstallationToken(app)).toBe('ghs_2');
      expect(await githubInstallationToken(app)).toBe('ghs_2');
      expect(github.mints()).toBe(2);
    });

    it('keeps a token that has more than five minutes left', async () => {
      const github = serve({ expiresIn: [600] });
      const app = github.app();
      await githubInstallationToken(app);
      await githubInstallationToken(app);
      expect(github.mints()).toBe(1);
    });

    it('does not cache a failed mint', async () => {
      const github = serve({ failMints: 1 });
      const app = github.app();
      const error = await rejection(githubInstallationToken(app));
      expect(error.status).toBe(502);
      expect(await githubInstallationToken(app)).toBe('ghs_2');
      expect(github.mints()).toBe(2);
    });

    it('does not hand a cached token to a caller with another private key', async () => {
      const github = serve();
      expect(await githubInstallationToken(github.app())).toBe('ghs_1');

      const wrongKey = await rejection(
        githubInstallationToken(github.app({ privateKey: otherKeys.privateKey })),
      );
      expect(wrongKey.status).toBe(400);
      expect(wrongKey.message).toBe('GitHub rejected the App ID or private key.');

      const garbage = await rejection(
        githubInstallationToken(github.app({ privateKey: 'not a key' })),
      );
      expect(garbage.status).toBe(400);
      expect(garbage.message).toBe('privateKey is not a valid PEM private key');
      expect(github.mints()).toBe(1);
    });

    it('answers 502 when the response has no token', async () => {
      const github = serve({ mintBody: { expires_at: '2099-01-01T00:00:00Z' } });
      const error = await rejection(githubInstallationToken(github.app()));
      expect(error.status).toBe(502);
      expect(error.message).toBe('GitHub returned an invalid installation token');
    });

    it('answers 502 when the response has no usable expiry', async () => {
      const github = serve({ mintBody: { token: 'ghs_x', expires_at: 'soon' } });
      const error = await rejection(githubInstallationToken(github.app()));
      expect(error.status).toBe(502);
      expect(error.message).toBe('GitHub returned an invalid installation token');
    });

    it('answers 400 when GitHub rejects the private key', async () => {
      const github = serve();
      const error = await rejection(
        githubInstallationToken(github.app({ privateKey: otherKeys.privateKey })),
      );
      expect(error.status).toBe(400);
      expect(error.message).toBe('GitHub rejected the App ID or private key.');
      expect(github.mints()).toBe(0);
    });
  });
});
