// Pure logic for the fvcsolutions.com contact form Lambda: validating a submission and building the
// Pipebrain feedback request. No network or AWS calls here, so tests can run it directly.
// Adapted from kyntiq-site's functions/contact.
import { createHmac } from 'node:crypto';

/** Topics a visitor can choose, keyed by the value the form sends. */
export const TOPICS = {
  legal: 'Legal',
  privacy: 'Privacy',
  support: 'Support',
  business: 'New Business',
};

/** Pipebrain caps a feedback message at 4000 characters; the heading and name lines take the rest. */
export const MAX_MESSAGE = 3700;

/** Longest name the form accepts. */
export const MAX_NAME = 120;

export const FEEDBACK_URL = 'https://api.pipebrain.dev/api/v1/feedback';

export class SubmissionError extends Error {
  /** @param {string} code */
  constructor(code) {
    super(code);
    this.name = 'SubmissionError';
    this.code = code;
  }
}

/**
 * Checks a parsed JSON body from the form and returns its clean fields.
 * Throws SubmissionError with a code the page maps to a message.
 * @param {unknown} body
 * @returns {{ topic: keyof typeof TOPICS, message: string, altcha: string, name: string }}
 */
export function parseSubmission(body) {
  if (!body || typeof body !== 'object') throw new SubmissionError('invalid_body');
  const { topic, message, altcha, website, name } = /** @type {Record<string, unknown>} */ (body);
  // The hidden "website" field is a honeypot: people never see it, form-filling bots fill it in.
  if (typeof website === 'string' && website.trim() !== '') throw new SubmissionError('rejected');
  if (typeof topic !== 'string' || !Object.hasOwn(TOPICS, topic)) throw new SubmissionError('invalid_topic');
  if (typeof message !== 'string') throw new SubmissionError('invalid_message');
  const text = message.replace(/\r\n?/g, '\n').trim();
  if (text.length < 2 || text.length > MAX_MESSAGE) throw new SubmissionError('invalid_message');
  if (typeof altcha !== 'string' || altcha.length === 0 || altcha.length > 8000) {
    throw new SubmissionError('captcha_missing');
  }
  let cleanName = '';
  if (typeof name === 'string') {
    cleanName = name.replace(/\s+/g, ' ').trim();
    if (cleanName.length > MAX_NAME) throw new SubmissionError('invalid_name');
  }
  return { topic: /** @type {keyof typeof TOPICS} */ (topic), message: text, altcha, name: cleanName };
}

/**
 * Decodes the ALTCHA widget's form value (base64 JSON holding challenge and solution).
 * @param {string} value
 * @returns {{ challenge: any, solution: any }}
 */
export function decodeAltchaPayload(value) {
  let parsed;
  try {
    parsed = JSON.parse(Buffer.from(value, 'base64').toString('utf8'));
  } catch {
    throw new SubmissionError('captcha_failed');
  }
  if (!parsed || typeof parsed !== 'object' || !parsed.challenge || !parsed.solution) {
    throw new SubmissionError('captcha_failed');
  }
  return { challenge: parsed.challenge, solution: parsed.solution };
}

/**
 * ALTCHA's deterministic mode needs two HMAC secrets; both are derived from the one stored key
 * so only one secret has to be kept.
 * @param {string | undefined} key
 */
export function altchaSecrets(key) {
  if (!key) throw new Error('ALTCHA_KEY is not set');
  const derive = label => createHmac('sha256', key).update(label).digest('base64url');
  return { signature: derive('fvc-contact-signature'), keySignature: derive('fvc-contact-key-signature') };
}

/**
 * The body for Pipebrain's feedback endpoint. Pipebrain titles the item from the first line,
 * so that line names the topic and starts the message.
 * @param {{ projectKey: string, topic: keyof typeof TOPICS, message: string, name?: string }} input
 */
export function feedbackRequest({ projectKey, topic, message, name = '' }) {
  const label = TOPICS[topic];
  const firstLine = message.split('\n', 1)[0].slice(0, 90);
  return {
    projectKey,
    environment: 'prod',
    message: `Contact form (${label}): ${firstLine}\n\n${name ? `Name: ${name}\n\n` : ''}${message}`,
    pageUrl: 'https://fvcsolutions.com/contact',
    metadata: { source: 'fvcsolutions.com contact form', topic: label },
  };
}
