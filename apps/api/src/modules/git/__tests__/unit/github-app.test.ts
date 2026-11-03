import { describe, expect, it } from 'bun:test';
import { createVerify, generateKeyPairSync } from 'node:crypto';
import { HttpError } from '#shared/lib';
import { githubAppJwt } from '../../github-app';

const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const pkcs1 = privateKey.export({ type: 'pkcs1', format: 'pem' }) as string;
const pkcs8 = privateKey.export({ type: 'pkcs8', format: 'pem' }) as string;

function decode(part: string) {
  return JSON.parse(Buffer.from(part, 'base64url').toString('utf8')) as Record<string, unknown>;
}

function verifies(jwt: string): boolean {
  const [header, payload, signature] = jwt.split('.');
  return createVerify('RSA-SHA256')
    .update(`${header}.${payload}`)
    .verify(publicKey, Buffer.from(signature!, 'base64url'));
}

describe('githubAppJwt', () => {
  it.each([
    ['PKCS#1', pkcs1],
    ['PKCS#8', pkcs8],
  ])('signs a JWT that the public key verifies from a %s key', (_name, pem) => {
    expect(verifies(githubAppJwt('12345', pem, 1_700_000_000))).toBe(true);
  });

  it('sets the header, issuer and a ten minute window starting a minute ago', () => {
    const [header, payload] = githubAppJwt('Iv1.abc', pkcs1, 1_700_000_000).split('.');
    expect(decode(header!)).toEqual({ alg: 'RS256', typ: 'JWT' });
    expect(decode(payload!)).toEqual({
      iat: 1_700_000_000 - 60,
      exp: 1_700_000_000 + 540,
      iss: 'Iv1.abc',
    });
  });

  it('reads the clock when no time is given', () => {
    const before = Math.floor(Date.now() / 1000);
    const payload = decode(githubAppJwt('1', pkcs1).split('.')[1]!);
    expect(payload.iat).toBeGreaterThanOrEqual(before - 60);
    expect(payload.iat).toBeLessThanOrEqual(before - 60 + 5);
  });

  it('rejects a key that is not a PEM private key with a 400', () => {
    let thrown: unknown;
    try {
      githubAppJwt('1', 'not a key');
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(HttpError);
    expect(thrown).toMatchObject({
      status: 400,
      message: 'privateKey is not a valid PEM private key',
    });
  });
});
