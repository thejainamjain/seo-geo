/**
 * lib/logger.ts
 *
 * WHY THIS EXISTS: audited the frontend and found there was no client-side
 * logging anywhere — not in the axios response interceptor, not in
 * react-query's error paths, not in any mutation hook. A failed request
 * just silently rejected; the only signal was whatever a specific
 * component happened to render for `.isError`. That's a real visibility
 * gap for debugging production issues.
 *
 * This is intentionally thin — a console wrapper, not a full logging
 * library. It exists so every call site doesn't reach for raw
 * `console.error` directly, which makes it a single place to swap in a
 * real error-reporting service (Sentry, etc.) later without touching
 * every call site again.
 */

type LogContext = Record<string, unknown>;

function format(message: string, context?: LogContext) {
  return context ? [message, context] as const : [message] as const;
}

export const logger = {
  debug(message: string, context?: LogContext) {
    if (process.env.NODE_ENV !== 'production') {
      console.debug(...format(`[debug] ${message}`, context));
    }
  },
  info(message: string, context?: LogContext) {
    console.info(...format(`[info] ${message}`, context));
  },
  warn(message: string, context?: LogContext) {
    console.warn(...format(`[warn] ${message}`, context));
  },
  error(message: string, context?: LogContext) {
    console.error(...format(`[error] ${message}`, context));
  },
};
