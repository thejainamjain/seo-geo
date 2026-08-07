'use client';

import { use } from 'react';
import { useLatestAudit, useCodeChangeTypeCounts } from '@/lib/hooks';
import { Skeleton } from '@/components/ui/skeleton';
import { Badge } from '@/components/ui/badge';
import { CheckCircle2, XCircle, FileSearch } from 'lucide-react';
import { scoreToGrade } from '@/lib/utils/grade';
import { REAL_DIFF_TYPES } from '@/components/technical-seo/type-labels';

/**
 * app/(app)/projects/[projectId]/audit/page.tsx — "Website Audit"
 *
 * Matches the reference product's A-/A+ score card + "Technical SEO
 * Factors" pass/fail table. Was previously a hybrid page mixing this
 * concept with the Technical SEO & GEO page's code-change browser — that
 * content moved to app/(app)/projects/[projectId]/technical-seo/page.tsx.
 *
 * FACTOR LIST — mapped from the 9 rows visible in the reference
 * screenshot, in the same order, to real CodeChange types:
 *   1. Title relevant + keywords          -> title
 *   2. Description relevant + keywords    -> description
 *   3. Open Graph tags present            -> open_graph
 *   4. One canonical tag                  -> canonical
 *   5. External links have target attr   -> link_target
 *   6. Links have descriptive titles      -> link_title
 *   7. Images have descriptive alt text   -> alt_text
 *   8. Links have valid, non-broken hrefs -> broken_link
 *   9. >=3 internal links per page        -> internal_link
 * A 10th row was visible but cut off in the screenshot we were given —
 * ASSUMPTION FLAGGED: mapped to missing_h1 ("Page should have an H1
 * tag") since that's the one remaining implemented check with no home
 * elsewhere on this page, but the exact wording shown in the reference
 * for that row hasn't actually been seen and should be verified against
 * a screenshot of the un-cropped table before treating this as final.
 */
const FACTORS: Array<{ type: string; label: string }> = [
  { type: 'title',         label: 'Title should be relevant and contain keywords' },
  { type: 'description',   label: 'Description should be relevant and contain keywords' },
  { type: 'open_graph',    label: 'Open Graph tags should be present for better social media sharing.' },
  { type: 'canonical',     label: 'Page should have one canonical tag.' },
  { type: 'link_target',   label: 'External links should have a target attribute.' },
  { type: 'link_title',    label: 'Links should have descriptive title attributes.' },
  { type: 'alt_text',      label: 'Images should have descriptive alt text.' },
  { type: 'broken_link',   label: 'Links should have valid hrefs without broken or empty URLs.' },
  { type: 'internal_link', label: 'Page should have at least 3 internal links for better site navigation.' },
  { type: 'missing_h1',    label: 'Page should have exactly one H1 tag.' }, // ⚠ unverified wording — see comment above
];

export default function WebsiteAuditPage({ params }: { params: Promise<{ projectId: string }> }) {
  const { projectId } = use(params);
  const { data: audit, isLoading: auditLoading } = useLatestAudit(projectId);
  const { data: counts, isLoading: countsLoading } = useCodeChangeTypeCounts(projectId);

  const isLoading = auditLoading || countsLoading;

  return (
    <div className="p-8">
      <div className="flex items-center gap-3 mb-6">
        <div className="h-9 w-9 rounded-lg bg-primary/10 flex items-center justify-center">
          <FileSearch className="h-4 w-4 text-primary" />
        </div>
        <div>
          <h1 className="text-xl font-semibold">Website Audit</h1>
          <p className="text-sm text-muted-foreground">Technical SEO analysis</p>
        </div>
      </div>

      {isLoading && <Skeleton className="h-96 w-full" />}

      {!isLoading && !audit && (
        <p className="text-sm text-muted-foreground py-16 text-center">
          No completed audit yet. Run the pipeline to generate one.
        </p>
      )}

      {!isLoading && audit && (
        <>
          {/* Score card */}
          <div className="border border-border rounded-lg p-8 mb-8 flex flex-col items-center text-center">
            <div className="flex items-center gap-4 mb-4">
              {audit.previousScore !== null && (
                <>
                  <div>
                    <p className="text-4xl font-bold text-muted-foreground">{scoreToGrade(audit.previousScore)}</p>
                    <p className="text-xs text-muted-foreground mt-1 uppercase tracking-wide">Before</p>
                  </div>
                  <span className="text-2xl text-muted-foreground">→</span>
                </>
              )}
              <div>
                <p className="text-4xl font-bold text-green-500">
                  {audit.summary?.score !== undefined ? scoreToGrade(audit.summary.score) : '—'}
                </p>
                {audit.previousScore !== null && (
                  <p className="text-xs text-muted-foreground mt-1 uppercase tracking-wide">After</p>
                )}
              </div>
            </div>

            {(counts?.activeTotal ?? 0) === 0 && (counts?.total ?? 0) > 0 && (
              <Badge variant="outline" className="mb-3 border-green-500/30 text-green-500">
                Fully Optimized
              </Badge>
            )}

            <p className="text-sm text-muted-foreground max-w-md">
              {audit.summary?.scoreReasoning ??
                'Enterprise-grade SEO optimization improving search visibility, crawlability, and ranking potential across all critical factors.'}
            </p>
          </div>

          {/* Technical SEO Factors table */}
          <div className="border border-border rounded-lg">
            <div className="px-6 py-4 border-b border-border">
              <h2 className="font-semibold">Technical SEO Factors</h2>
              <p className="text-sm text-muted-foreground mt-0.5">
                {FACTORS.length} critical factors evaluated and optimized
              </p>
            </div>

            <table className="w-full text-sm">
              <thead>
                <tr className="text-xs text-muted-foreground uppercase tracking-wide text-left border-b border-border">
                  <th className="px-6 py-2 font-medium">Factor</th>
                  <th className="px-6 py-2 font-medium">Before</th>
                  <th className="px-6 py-2 font-medium">After</th>
                </tr>
              </thead>
              <tbody>
                {FACTORS.map(({ type, label }) => {
                  const c = counts?.byType[type];
                  const totalIssues = c ? c.pending + c.applied + c.disabled + c.failed : 0;
                  const stillPending = c?.pending ?? 0;
                  const hasRealFix = REAL_DIFF_TYPES.has(type);

                  return (
                    <tr key={type} className="border-b border-border last:border-0">
                      <td className="px-6 py-3">{label}</td>
                      <td className="px-6 py-3">
                        {totalIssues === 0 ? (
                          <span className="inline-flex items-center gap-1.5 text-green-500">
                            <CheckCircle2 className="h-3.5 w-3.5" /> Pass
                          </span>
                        ) : (
                          <span className="inline-flex items-center gap-1.5 text-red-500">
                            <XCircle className="h-3.5 w-3.5" /> {totalIssues}
                          </span>
                        )}
                      </td>
                      <td className="px-6 py-3">
                        {totalIssues === 0 ? (
                          <span className="inline-flex items-center gap-1.5 text-green-500">
                            <CheckCircle2 className="h-3.5 w-3.5" /> Pass
                          </span>
                        ) : stillPending === 0 ? (
                          <span className="inline-flex items-center gap-1.5 text-green-500">
                            <CheckCircle2 className="h-3.5 w-3.5" /> Fixed
                          </span>
                        ) : (
                          <span className="text-muted-foreground">{stillPending} pending{hasRealFix ? '' : ' (recommendation only)'}</span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          <p className="text-xs text-muted-foreground mt-3">
            Want to see or apply individual fixes? Head to{' '}
            <a href={`../technical-seo`} className="text-blue-400 hover:underline">Technical SEO & GEO</a>.
          </p>
        </>
      )}
    </div>
  );
}
