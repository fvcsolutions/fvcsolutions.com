// Lambda behind the fvcsolutions.com contact form, reached through its public function URL.
// The function URL's own CORS settings (infra/contact.yaml) admit https://fvcsolutions.com.
//   GET  /challenge  a signed ALTCHA challenge, valid for 10 minutes
//   POST /message    {topic, message, altcha, website, name?} -> Pipebrain feedback item in FVCW
//                    Each solved challenge files one message only (spent.mjs).
import { createChallenge, randomInt, verifySolution } from 'altcha-lib';
import { deriveKey } from 'altcha-lib/algorithms/pbkdf2';
import {
  FEEDBACK_URL,
  SubmissionError,
  altchaSecrets,
  decodeAltchaPayload,
  feedbackRequest,
  parseSubmission,
} from './contact.mjs';
import { spend } from './spent.mjs';

/** Swappable in tests. */
export const deps = { spend, spendTimeoutMs: 2_500 };

const CHALLENGE_TTL_SECONDS = 600;
const MAX_BODY_BYTES = 16_000;

function reply(statusCode, body) {
  return {
    statusCode,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
    body: JSON.stringify(body),
  };
}

async function challenge() {
  const secrets = altchaSecrets(process.env.ALTCHA_KEY);
  const result = await createChallenge({
    algorithm: 'PBKDF2/SHA-256',
    cost: 5_000,
    counter: randomInt(5_000, 10_000),
    deriveKey,
    expiresAt: Math.floor(Date.now() / 1000) + CHALLENGE_TTL_SECONDS,
    hmacSignatureSecret: secrets.signature,
    hmacKeySignatureSecret: secrets.keySignature,
  });
  return reply(200, result);
}

async function submit(event) {
  const raw = event.isBase64Encoded ? Buffer.from(event.body ?? '', 'base64').toString('utf8') : (event.body ?? '');
  if (Buffer.byteLength(raw) > MAX_BODY_BYTES) return reply(400, { error: 'invalid_body' });
  let body;
  try {
    body = JSON.parse(raw);
  } catch {
    return reply(400, { error: 'invalid_body' });
  }

  let submission;
  try {
    submission = parseSubmission(body);
    const { challenge, solution } = decodeAltchaPayload(submission.altcha);
    const secrets = altchaSecrets(process.env.ALTCHA_KEY);
    const result = await verifySolution({
      challenge,
      solution,
      deriveKey,
      hmacSignatureSecret: secrets.signature,
      hmacKeySignatureSecret: secrets.keySignature,
    });
    if (!result.verified) throw new SubmissionError(result.expired ? 'captcha_expired' : 'captcha_failed');
    // Spend the solution so it files one message only. If the store is down, accept it unrecorded:
    // the work was still proved, and a broken table must not stop people reaching us.
    const expiresAt = Number(challenge.parameters?.expiresAt) || Math.floor(Date.now() / 1000) + CHALLENGE_TTL_SECONDS;
    let timer;
    const fresh = await Promise.race([
      deps.spend(String(challenge.signature), expiresAt),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('spend timed out')), deps.spendTimeoutMs);
      }),
    ])
      .catch(error => {
        console.error('spent-solution store unavailable; accepting unrecorded', error?.message);
        return true;
      })
      .finally(() => clearTimeout(timer));
    if (!fresh) throw new SubmissionError('captcha_reused');
  } catch (error) {
    if (error instanceof SubmissionError) {
      const status = error.code.startsWith('captcha') ? 422 : 400;
      return reply(status, { error: error.code });
    }
    console.error('verification error', error?.name);
    return reply(422, { error: 'captcha_failed' });
  }

  // Server to server, with no Origin header, so Pipebrain's allowed-origins list does not apply.
  const response = await fetch(FEEDBACK_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(
      feedbackRequest({
        projectKey: process.env.FEEDBACK_KEY,
        topic: submission.topic,
        message: submission.message,
        name: submission.name,
      }),
    ),
    signal: AbortSignal.timeout(8_000),
  }).catch(error => ({ ok: false, status: 0, error }));
  if (response.status === 429) return reply(429, { error: 'busy' });
  if (!response.ok) {
    console.error('pipebrain refused', response.status);
    return reply(502, { error: 'unavailable' });
  }
  return reply(200, { ok: true, receivedAt: new Date().toISOString() });
}

export async function handler(event) {
  const method = event.requestContext?.http?.method ?? 'GET';
  const path = (event.rawPath ?? '').replace(/\/+$/, '');
  try {
    if (path === '/challenge' && method === 'GET') return await challenge();
    if (path === '/message' && method === 'POST') return await submit(event);
    return reply(405, { error: 'method_not_allowed' });
  } catch (error) {
    console.error('contact handler failed', error?.name, error?.message);
    return reply(500, { error: 'unavailable' });
  }
}
