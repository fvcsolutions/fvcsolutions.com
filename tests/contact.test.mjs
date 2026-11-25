// The contact Lambda, run in-process: a real ALTCHA round trip, refusals, and the Pipebrain request.
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { solveChallenge } from 'altcha-lib';
import { deriveKey } from 'altcha-lib/algorithms/pbkdf2';
import { deps, handler } from '../functions/contact/handler.mjs';
import { feedbackRequest, parseSubmission } from '../functions/contact/contact.mjs';

const realFetch = globalThis.fetch;
const realSpend = deps.spend;
let sent;
let spent;

beforeEach(() => {
  process.env.ALTCHA_KEY = 'test-key-not-a-secret';
  process.env.FEEDBACK_KEY = 'pk_test';
  sent = [];
  spent = new Set();
  deps.spend = async signature => (spent.has(signature) ? false : (spent.add(signature), true));
  globalThis.fetch = async (url, init) => {
    sent.push({ url, body: JSON.parse(init.body) });
    return new Response('{"ok":true}', { status: 200 });
  };
});

afterEach(() => {
  globalThis.fetch = realFetch;
  deps.spend = realSpend;
});

const get = path => handler({ rawPath: path, requestContext: { http: { method: 'GET' } } });
const post = body =>
  handler({ rawPath: '/message', requestContext: { http: { method: 'POST' } }, body: JSON.stringify(body) });

async function solvedPayload() {
  const challenge = JSON.parse((await get('/challenge')).body);
  const solution = await solveChallenge({ challenge, deriveKey });
  return Buffer.from(JSON.stringify({ challenge, solution })).toString('base64');
}

test('a solved challenge files one FVCW feedback item with the topic', async () => {
  const altcha = await solvedPayload();
  const res = await post({ topic: 'privacy', message: 'Please delete my data.', website: '', altcha });
  assert.equal(res.statusCode, 200, res.body);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].url, 'https://api.pipebrain.dev/api/v1/feedback');
  assert.equal(sent[0].body.projectKey, 'pk_test');
  assert.equal(sent[0].body.pageUrl, 'https://fvcsolutions.com/contact');
  assert.match(sent[0].body.message, /^Contact form \(Privacy\): Please delete my data\.\n\n/);
  assert.equal(sent[0].body.metadata.topic, 'Privacy');
});

test('each of the four topics is accepted and labelled', async () => {
  for (const [topic, label] of [['legal', 'Legal'], ['privacy', 'Privacy'], ['support', 'Support'], ['business', 'New Business']]) {
    const res = await post({ topic, message: 'hello there', altcha: await solvedPayload() });
    assert.equal(res.statusCode, 200, `${topic}: ${res.body}`);
    assert.equal(sent.at(-1).body.metadata.topic, label);
  }
});

test('the challenge response never carries the Pipebrain key and is not cached', async () => {
  const res = await get('/challenge');
  assert.equal(res.statusCode, 200);
  assert.equal(res.headers['cache-control'], 'no-store');
  assert.ok(!res.body.includes('pk_'));
});

test('missing, altered, expired and honeypot submissions are refused without filing anything', async () => {
  const good = await solvedPayload();
  const decoded = JSON.parse(Buffer.from(good, 'base64').toString());
  const flip = c => (c === '0' ? '1' : '0');
  const altered = Buffer.from(
    JSON.stringify({ ...decoded, solution: { ...decoded.solution, derivedKey: decoded.solution.derivedKey.replace(/^./, flip) } }),
  ).toString('base64');
  const expiredChallenge = { ...decoded.challenge, parameters: { ...decoded.challenge.parameters, expiresAt: 1 } };
  const expired = Buffer.from(JSON.stringify({ challenge: expiredChallenge, solution: decoded.solution })).toString('base64');

  const cases = [
    [{ topic: 'support', message: 'hello there' }, 422],
    [{ topic: 'support', message: 'hello there', altcha: 'not-base64-json' }, 422],
    [{ topic: 'support', message: 'hello there', altcha: altered }, 422],
    [{ topic: 'support', message: 'hello there', altcha: expired }, 422],
    [{ topic: 'support', message: 'hello there', altcha: good, website: 'http://spam.example' }, 400],
    [{ topic: 'sales', message: 'hello there', altcha: good }, 400],
    [{ topic: 'support', message: ' ', altcha: good }, 400],
  ];
  for (const [body, status] of cases) {
    const res = await post(body);
    assert.equal(res.statusCode, status, `${JSON.stringify(body).slice(0, 80)} -> ${res.body}`);
  }
  assert.equal(sent.length, 0);
});

test('unknown routes and methods are refused', async () => {
  assert.equal((await get('/other')).statusCode, 405);
  assert.equal((await get('/message')).statusCode, 405);
});

test('a Pipebrain failure is reported as unavailable, a Pipebrain 429 as busy', async () => {
  globalThis.fetch = async () => new Response('', { status: 500 });
  assert.equal((await post({ topic: 'support', message: 'hello there', altcha: await solvedPayload() })).statusCode, 502);
  globalThis.fetch = async () => new Response('', { status: 429 });
  const busy = await post({ topic: 'support', message: 'hello there', altcha: await solvedPayload() });
  assert.equal(busy.statusCode, 429);
  assert.equal(JSON.parse(busy.body).error, 'busy');
});

test('a solved challenge files one message only; reusing it is refused', async () => {
  const altcha = await solvedPayload();
  const first = await post({ topic: 'support', message: 'first message', altcha });
  const second = await post({ topic: 'support', message: 'second message', altcha });
  assert.equal(first.statusCode, 200, first.body);
  assert.equal(second.statusCode, 422);
  assert.equal(JSON.parse(second.body).error, 'captcha_reused');
  assert.equal(sent.length, 1);
});

test('a valid submission is still filed when the spent-solution store is down or hangs', async () => {
  deps.spend = async () => {
    throw new Error('store down');
  };
  assert.equal((await post({ topic: 'support', message: 'hello there', altcha: await solvedPayload() })).statusCode, 200);
  deps.spend = () => new Promise(() => {});
  deps.spendTimeoutMs = 50;
  try {
    assert.equal((await post({ topic: 'support', message: 'hello there', altcha: await solvedPayload() })).statusCode, 200);
  } finally {
    deps.spendTimeoutMs = 2_500;
  }
  assert.equal(sent.length, 2);
});

test('the optional name is carried on any topic and left out when blank', async () => {
  const named = await post({ topic: 'business', name: '  Pat   Doe ', message: 'We need an app.', altcha: await solvedPayload() });
  const unnamed = await post({ topic: 'support', name: '', message: 'Help please', altcha: await solvedPayload() });
  assert.deepEqual([named.statusCode, unnamed.statusCode], [200, 200]);
  assert.match(sent[0].body.message, /^Contact form \(New Business\): We need an app\.\n\nName: Pat Doe\n\nWe need an app\./);
  assert.ok(!sent[1].body.message.includes('Name:'));
});

test('a name over the limit is refused, and the longest submission fits Pipebrain', async () => {
  const res = await post({ topic: 'legal', name: 'x'.repeat(121), message: 'hello there', altcha: await solvedPayload() });
  assert.equal(res.statusCode, 400);
  const body = feedbackRequest({
    projectKey: 'pk_test',
    ...parseSubmission({ topic: 'business', name: 'x'.repeat(120), message: 'y'.repeat(3700), altcha: 'a' }),
  });
  assert.ok(body.message.length <= 4000, String(body.message.length));
  assert.throws(() => parseSubmission({ topic: 'legal', message: 'y'.repeat(3701), altcha: 'a' }));
});
