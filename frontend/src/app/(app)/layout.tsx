'use client';

import axios from 'axios';
import { Sidebar } from '@/components/layout/sidebar';
import { Button } from '@/components/ui/button';
import { useCurrentUser } from '@/lib/hooks';

export default function AppLayout({ children }: { children: React.ReactNode }) {
  // Route protection itself happens on the server in proxy.ts (no cookie →
  // redirect to /login?next=…) before this ever renders. This check confirms
  // the session is still valid; an expired/invalid one returns 401, which the
  // API client turns into a redirect to /login.
  const { data: user, error, isError, isFetching, refetch } = useCurrentUser();

  if (isError) {
    // 401 → redirect to /login is already in progress; render nothing.
    if (axios.isAxiosError(error) && error.response?.status === 401) return null;

    // Anything else (server down, network error) → don't log the user out.
    return (
      <div className="flex h-screen flex-col items-center justify-center gap-3 text-center">
        <p className="text-sm text-muted-foreground">
          Couldn&apos;t reach the server. Your session is still active.
        </p>
        <Button variant="outline" size="sm" onClick={() => refetch()} disabled={isFetching}>
          {isFetching ? 'Retrying…' : 'Retry'}
        </Button>
      </div>
    );
  }

  if (!user) return null;

  return (
    <div className="flex h-screen overflow-hidden">
      <Sidebar />
      <main className="flex-1 overflow-y-auto">
        {children}
      </main>
    </div>
  );
}