import { NextResponse, type NextRequest } from 'next/server';
import { getSafeNext } from '@/lib/utils/safe-redirect';

// Must match config.authCookie.name on the backend.
const AUTH_COOKIE = 'auth-token';

const AUTH_PAGES  = ['/login', '/register'];
const PUBLIC_EXACT = ['/'];          // marketing landing page

function isAuthPage(pathname: string): boolean {
  return AUTH_PAGES.some(p => pathname === p || pathname.startsWith(`${p}/`));
}

export function proxy(request: NextRequest) {
  const { pathname, search } = request.nextUrl;
  const hasSession = Boolean(request.cookies.get(AUTH_COOKIE)?.value);

  // Already signed in → keep them off /login and /register.
  if (hasSession && isAuthPage(pathname)) {
    const target = getSafeNext(request.nextUrl.searchParams.get('next'));
    return NextResponse.redirect(new URL(target, request.url));
  }

  // Not signed in → protect every page except the auth pages and landing page.
  // This runs on the server BEFORE the page renders, so there is no flash of
  // protected UI and no dependence on client-side state hydrating first.
  if (!hasSession && !isAuthPage(pathname) && !PUBLIC_EXACT.includes(pathname)) {
    const loginUrl = new URL('/login', request.url);
    loginUrl.searchParams.set('next', `${pathname}${search}`);
    return NextResponse.redirect(loginUrl);
  }

  return NextResponse.next();
}

export const config = {
  // Skip Next internals, the API, and any file with an extension (images, fonts…).
  matcher: ['/((?!_next/static|_next/image|favicon.ico|api|.*\\..*).*)'],
};