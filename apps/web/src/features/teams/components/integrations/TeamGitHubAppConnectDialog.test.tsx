import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { act } from 'react';
import type { Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { NextIntlClientProvider } from 'next-intl';
import { JSDOM } from 'jsdom';
import settings from '../../../../../messages/en/settings.json';

// A GitHub App connection is made from the App's id, an installation id and the App's
// private key. The dialog sends them to the team's github-app route and closes when the
// connection exists.

const git = settings.git;
const PRIVATE_KEY = '-----BEGIN RSA PRIVATE KEY-----\nabc\n-----END RSA PRIVATE KEY-----\n';

let dom: JSDOM;
let root: Root;
let queryClient: QueryClient;
let originals: Map<string, PropertyDescriptor | undefined>;
let originalFetch: typeof fetch;
let calls: { method: string; path: string; body: unknown }[];
let openChanges: boolean[];

const wait = (ms = 20) => act(() => new Promise<void>((resolve) => setTimeout(resolve, ms)));

async function render() {
  const { default: TeamGitHubAppConnectDialog } = await import('./TeamGitHubAppConnectDialog');
  await act(async () =>
    root.render(
      <NextIntlClientProvider locale="en" messages={{ settings }} timeZone="UTC">
        <QueryClientProvider client={queryClient}>
          <TeamGitHubAppConnectDialog
            teamId={7}
            open
            onOpenChange={(open) => openChanges.push(open)}
          />
        </QueryClientProvider>
      </NextIntlClientProvider>,
    ),
  );
  await wait();
}

function field(label: string) {
  const element = [...document.querySelectorAll('label')].find(
    (candidate) => candidate.textContent === label,
  );
  assert.ok(element, `Missing label: ${label}`);
  return document.getElementById(element.htmlFor) as HTMLInputElement | HTMLTextAreaElement;
}

async function type(label: string, value: string) {
  const target = field(label);
  const prototype =
    target.tagName === 'TEXTAREA' ? dom.window.HTMLTextAreaElement : dom.window.HTMLInputElement;
  await act(async () => {
    Object.getOwnPropertyDescriptor(prototype.prototype, 'value')!.set!.call(target, value);
    target.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
  });
}

const submitButton = () =>
  [...document.querySelectorAll('button')].find(
    (element) => element.type === 'submit',
  ) as HTMLButtonElement;

beforeEach(async () => {
  dom = new JSDOM('<div id="root"></div>', {
    url: 'https://planner.test/teams/7/settings',
    pretendToBeVisual: true,
  });
  dom.window.__ITSAPLAN_ENV__ = { apiUrl: 'http://api.test', privacyUrl: '', termsUrl: '' };
  const globals = {
    window: dom.window,
    document: dom.window.document,
    navigator: dom.window.navigator,
    HTMLElement: dom.window.HTMLElement,
    HTMLInputElement: dom.window.HTMLInputElement,
    HTMLTextAreaElement: dom.window.HTMLTextAreaElement,
    HTMLFormElement: dom.window.HTMLFormElement,
    Element: dom.window.Element,
    Node: dom.window.Node,
    NodeFilter: dom.window.NodeFilter,
    CustomEvent: dom.window.CustomEvent,
    MutationObserver: dom.window.MutationObserver,
    getComputedStyle: dom.window.getComputedStyle.bind(dom.window),
    requestAnimationFrame: dom.window.requestAnimationFrame.bind(dom.window),
    cancelAnimationFrame: dom.window.cancelAnimationFrame.bind(dom.window),
    IS_REACT_ACT_ENVIRONMENT: true,
  };
  originals = new Map(
    Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]),
  );
  for (const [key, value] of Object.entries(globals))
    Object.defineProperty(globalThis, key, { configurable: true, value });
  originalFetch = globalThis.fetch;
  calls = [];
  openChanges = [];
  globalThis.fetch = (async (input, init) => {
    calls.push({
      method: init?.method ?? 'GET',
      path: new URL(String(input)).pathname,
      body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined,
    });
    return Response.json({ id: 1 }, { status: 201 });
  }) as typeof fetch;
  const { createRoot } = await import('react-dom/client');
  root = createRoot(document.getElementById('root')!);
  queryClient = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
});

afterEach(async () => {
  await act(() => root.unmount());
  await wait(5);
  queryClient.clear();
  globalThis.fetch = originalFetch;
  dom.window.close();
  for (const [key, descriptor] of originals) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  }
});

describe('TeamGitHubAppConnectDialog', () => {
  it('asks for the provider URL, App ID, installation ID and private key', async () => {
    await render();

    assert.ok(document.body.textContent?.includes(git.nativeGithubAppHint));
    assert.equal(field(git.nativeBaseUrl).value, 'https://github.com');
    assert.ok(field(git.nativeAppId));
    assert.ok(field(git.nativeInstallationId));
    assert.equal(field(git.nativePrivateKey).tagName, 'TEXTAREA');
    assert.equal(field(git.nativePrivateKey).getAttribute('dir'), 'ltr');
  });

  it('keeps Connect disabled until the App ID, installation ID and key are filled in', async () => {
    await render();
    assert.equal(submitButton().disabled, true);

    await type(git.nativeAppId, '123456');
    await type(git.nativeInstallationId, '   ');
    await type(git.nativePrivateKey, PRIVATE_KEY);
    assert.equal(submitButton().disabled, true);

    await type(git.nativeInstallationId, '98765');
    assert.equal(submitButton().disabled, false);

    await type(git.nativeAppId, '  ');
    assert.equal(submitButton().disabled, true);
    await type(git.nativeAppId, '123456');

    await type(git.nativePrivateKey, '  ');
    assert.equal(submitButton().disabled, true);
  });

  it("connects through the team's github-app route and closes the dialog", async () => {
    await render();
    await type(git.nativeAppId, ' 123456 ');
    await type(git.nativeInstallationId, ' 98765 ');
    await type(git.nativePrivateKey, PRIVATE_KEY);

    await act(async () => {
      submitButton().click();
      await new Promise<void>((resolve) => setTimeout(resolve, 20));
    });

    assert.deepEqual(calls, [
      {
        method: 'POST',
        path: '/teams/7/settings/git/connections/github-app',
        body: {
          baseUrl: 'https://github.com',
          appId: '123456',
          installationId: '98765',
          privateKey: PRIVATE_KEY,
        },
      },
    ]);
    assert.deepEqual(openChanges, [false]);
  });
});
