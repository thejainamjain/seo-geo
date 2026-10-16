/**
 * lib/mistral.ts
 *
 * Thin client for Mistral's HTTP API, shared by chat completions (lib/llm.ts)
 * and embeddings (lib/embeddings.ts). Plain fetch — no SDK dependency.
 *
 * RATE LIMIT: Mistral's free tier allows 1 request per second. Every call
 * first takes a short-lived Redis slot (SET key NX PX interval), so the limit
 * holds across ALL worker processes, the same way llm.ts shares Groq's limit.
 * On a paid plan set MISTRAL_MIN_INTERVAL_MS=0 to switch the gate off.
 *
 * ENV:
 *   MISTRAL_API_KEY            required to use Mistral at all
 *   MISTRAL_MIN_INTERVAL_MS    min gap between requests, default 1100
 */

import { getRedis } from '../loaders/redis';
import { logger } from '../open-tele';

const MISTRAL_BASE_URL    = 'https://api.mistral.ai/v1';
const DEFAULT_TIMEOUT_MS  = 120_000;
const DEFAULT_INTERVAL_MS = 1_100;     // free tier: 1 req/s, plus a little margin
const SLOT_KEY            = 'llm:mistral:slot';

/** Thrown for every failed Mistral request. status 0 = timeout / network error. */
export class MistralApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly retryAfterMs?: number,
  ) {
    super(message);
    this.name = 'MistralApiError';
  }
}

/** True when a Mistral key is present — checked WITHOUT throwing. */
export function isMistralConfigured(): boolean {
  return Boolean(process.env.MISTRAL_API_KEY?.trim());
}

function minIntervalMs(): number {
  const raw = process.env.MISTRAL_MIN_INTERVAL_MS;
  if (raw === undefined || raw.trim() === '') return DEFAULT_INTERVAL_MS;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : DEFAULT_INTERVAL_MS;
}

const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));

/** Waits until this process may send the next request (cluster-wide). */
async function acquireSlot(): Promise<void> {
  const interval = minIntervalMs();
  if (interval === 0) return;

  const redis = getRedis();
  while (true) {
    const acquired = await redis.set(SLOT_KEY, '1', 'PX', interval, 'NX');
    if (acquired === 'OK') return;

    const ttl = await redis.pttl(SLOT_KEY);
    // small random jitter so several waiting workers don't wake in lockstep
    await sleep(Math.max(25, ttl > 0 ? ttl : 50) + Math.floor(Math.random() * 40));
  }
}

function parseRetryAfter(header: string | null): number | undefined {
  if (!header) return undefined;
  const seconds = Number(header);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const date = Date.parse(header);
  return Number.isNaN(date) ? undefined : Math.max(0, date - Date.now());
}

/**
 * POSTs JSON to a Mistral endpoint (path like "/chat/completions") and
 * returns the parsed JSON body. Throws MistralApiError on any failure.
 */
export async function mistralPost<T>(
  path: string,
  body: unknown,
  options: { timeoutMs?: number; context?: string } = {},
): Promise<T> {
  const apiKey = process.env.MISTRAL_API_KEY?.trim();
  if (!apiKey) throw new MistralApiError('MISTRAL_API_KEY is not defined in environment', 0);

  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  await acquireSlot();

  let res: Awaited<ReturnType<typeof fetch>>;
  try {
    res = await fetch(`${MISTRAL_BASE_URL}${path}`, {
      method:  'POST',
      headers: {
        'Content-Type':  'application/json',
        Accept:          'application/json',
        Authorization:   `Bearer ${apiKey}`,
      },
      body:   JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    const name = err instanceof Error ? err.name : '';
    if (name === 'TimeoutError' || name === 'AbortError') {
      throw new MistralApiError(`Mistral request timed out after ${timeoutMs}ms`, 0);
    }
    throw new MistralApiError(
      `Mistral network error: ${err instanceof Error ? err.message : String(err)}`,
      0,
    );
  }

  const text = await res.text();

  if (!res.ok) {
    const retryAfterMs = parseRetryAfter(res.headers.get('retry-after'));
    logger.warn('Mistral request failed', {
      path,
      status:  res.status,
      context: options.context,
      body:    text.slice(0, 300),
    });
    throw new MistralApiError(
      `Mistral API ${res.status}${res.status === 429 ? ' (rate limit)' : ''}: ${text.slice(0, 300)}`,
      res.status,
      retryAfterMs,
    );
  }

  try {
    return JSON.parse(text) as T;
  } catch {
    throw new MistralApiError(`Mistral returned a non-JSON response (${text.slice(0, 120)})`, res.status);
  }
}
