'use client';

import { QueryClient, QueryClientProvider, QueryCache, MutationCache } from '@tanstack/react-query';
import { ReactQueryDevtools } from '@tanstack/react-query-devtools';
import { useState } from 'react';
import { logger } from '@/lib/logger';

export function Providers({ children }: { children: React.ReactNode }) {
  const [queryClient] = useState(() => new QueryClient({
    defaultOptions: {
      queries: {
        staleTime:  60_000,
        retry:      1,
      },
    },
    // Previously no error visibility at the react-query layer at all —
    // see lib/logger.ts for the full audit. The axios interceptor logs
    // HTTP-level detail; this adds the query/mutation key + variables,
    // which axios has no visibility into.
    queryCache: new QueryCache({
      onError: (error, query) => {
        logger.error('Query failed', {
          queryKey: query.queryKey,
          message:  error instanceof Error ? error.message : String(error),
        });
      },
    }),
    mutationCache: new MutationCache({
      onError: (error, variables, _context, mutation) => {
        logger.error('Mutation failed', {
          mutationKey: mutation.options.mutationKey,
          variables,
          message:     error instanceof Error ? error.message : String(error),
        });
      },
    }),
  }));

  return (
    <QueryClientProvider client={queryClient}>
      {children}
      <ReactQueryDevtools initialIsOpen={false} />
    </QueryClientProvider>
  );
}
