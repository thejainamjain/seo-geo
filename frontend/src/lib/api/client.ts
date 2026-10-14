// lib/api/client.ts
import axios, { type AxiosError } from 'axios';
import { logger } from '@/lib/logger';

export const apiClient = axios.create({
  baseURL: process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3000/api/v1',
  headers: { 'Content-Type': 'application/json' },
  timeout: 30_000,
  // The login JWT is an httpOnly cookie set by the API. The browser attaches
  // it automatically as long as credentials are included; no token is ever
  // stored in or read from JS.
  withCredentials: true,
});

apiClient.interceptors.request.use((config) => {
  // BUG FIX: this instance sets a default 'Content-Type: application/json'
  // header above. Axios does NOT strip an already-explicit Content-Type
  // just because config.data is a FormData instance — that "let the
  // browser set multipart/form-data with the right boundary" behavior
  // only happens when NO Content-Type is configured at all. Because one
  // was set (for the JSON case), every multipart upload on this instance
  // (hero images, blog images, knowledge files) was being sent as
  // 'Content-Type: application/json' with a multipart body — the
  // boundary was missing, so multer couldn't parse any of it and
  // req.file/req.files was always undefined server-side, regardless of
  // what the client actually sent. Deleting the header here (rather than
  // per-call-site) lets axios's browser/XHR adapter set the correct
  // 'multipart/form-data; boundary=...' header itself, and fixes this
  // for every current and future FormData upload through this client.
  if (typeof FormData !== 'undefined' && config.data instanceof FormData) {
    delete config.headers['Content-Type'];
  }

  return config;
});

// Several queries can 401 at the same moment; only handle it once.
let handlingUnauthorized = false;

// Auth endpoints whose 401 means "wrong credentials", not "session expired" —
// the login/register form must show the error instead of reloading the page.
const AUTH_FORM_URLS = ['/auth/login', '/auth/register'];

async function handleUnauthorized(): Promise<void> {
  if (handlingUnauthorized) return;
  handlingUnauthorized = true;

  // Clear the (now invalid) cookie first. Otherwise the proxy would see a
  // cookie on /login, bounce the user back into the app, and loop.
  try {
    await fetch(`${apiClient.defaults.baseURL}/auth/logout`, {
      method: 'POST',
      credentials: 'include',
    });
  } catch {
    /* best effort — still send them to /login */
  }

  const { pathname, search } = window.location;
  const onAuthPage = pathname === '/login' || pathname === '/register';
  const next = onAuthPage ? '' : `?next=${encodeURIComponent(pathname + search)}`;
  window.location.href = `/login${next}`;
}

apiClient.interceptors.response.use(
  (res) => res,
  (error: AxiosError) => {
    // Previously silent — a failed request had zero trace anywhere unless
    // the calling component happened to render `.isError`. Log every one.
    logger.error('API request failed', {
      method: error.config?.method,
      url:    error.config?.url,
      status: error.response?.status,
      data:   error.response?.data,
      message: error.message,
    });

    const url = error.config?.url ?? '';
    const isAuthForm = AUTH_FORM_URLS.some(u => url.startsWith(u));

    if (error.response?.status === 401 && !isAuthForm && typeof window !== 'undefined') {
      void handleUnauthorized();
    }
    return Promise.reject(error);
  },
);

/**
 * Extracts the real backend-provided error message from a caught API
 * error, for display to the user.
 *
 * WHY THIS EXISTS: the response interceptor above only LOGS failed
 * requests — it does not rewrite the error's `.message`. So
 * `err.message` on a caught AxiosError is always a generic string like
 * "Request failed with status code 400", never the actual reason the
 * backend rejected the request (e.g. "This URL slug is already used by
 * another post"). Every backend error is shaped as
 * `{ error: { code, message } }` (see backend/src/utils/errors.ts) — this
 * reads that, falling back to a generic message only if the response
 * isn't in that shape at all (network failure, unexpected server error).
 */
export function extractApiErrorMessage(err: unknown, fallback = 'Something went wrong. Please try again.'): string {
  if (axios.isAxiosError(err)) {
    const data = err.response?.data as { error?: { message?: string } } | undefined;
    if (data?.error?.message) return data.error.message;
  }
  return fallback;
}
