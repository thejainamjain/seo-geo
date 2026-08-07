'use client';

import { use, useState } from 'react';
import {
  useCodeChanges, useCodeChangeTypeCounts,
  useApplyCodeChange, useDisableCodeChange,
  useFAQs, useTLDRs,
} from '@/lib/hooks';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Button } from '@/components/ui/button';
import { Terminal } from 'lucide-react';
import type { CodeChange, FAQ, TLDR } from '@/types/api';
import { TYPE_LABELS } from '@/components/technical-seo/type-labels';
import { DiffModal } from '@/components/technical-seo/diff-modal';

// ── Sidebar filter ──────────────────────────────────────────────────────────

function FilterSidebar({
  projectId, selected, onChange,
}: {
  projectId: string; selected: string | null; onChange: (t: string | null) => void;
}) {
  const { data, isLoading } = useCodeChangeTypeCounts(projectId);

  if (isLoading) return <Skeleton className="h-96 w-56" />;

  // Only list types that actually have at least one pending change in
  // this audit — no fabricated "0" rows for categories that don't exist
  // in this project's data (or in the backend at all).
  const typesWithCounts = Object.entries(data?.byType ?? {})
    .filter(([, counts]) => counts.pending > 0)
    .sort(([, a], [, b]) => b.pending - a.pending);

  return (
    <div className="w-56 shrink-0 space-y-6">
      <div className="space-y-3">
        <button
          onClick={() => onChange(null)}
          className={`w-full flex items-center justify-between px-2 py-1.5 rounded text-sm ${
            selected === null ? 'text-primary font-medium' : 'text-foreground'
          }`}
        >
          Active
          <span className="text-muted-foreground">{data?.activeTotal ?? 0}</span>
        </button>
        <div className="w-full flex items-center justify-between px-2 py-1.5 rounded text-sm text-muted-foreground">
          Disabled
          <span>{data?.disabledTotal ?? 0}</span>
        </div>
      </div>

      <div className="border-t border-border pt-3 space-y-1">
        <button
          onClick={() => onChange(null)}
          className={`w-full flex items-center justify-between px-2 py-1.5 rounded text-sm ${
            selected === null ? 'bg-accent text-primary font-medium' : 'hover:bg-accent'
          }`}
        >
          All
          <span className="text-muted-foreground">{data?.activeTotal ?? 0}</span>
        </button>
        {typesWithCounts.map(([type, counts]) => (
          <button
            key={type}
            onClick={() => onChange(type === selected ? null : type)}
            className={`w-full flex items-center justify-between px-2 py-1.5 rounded text-sm ${
              selected === type ? 'bg-accent text-primary font-medium' : 'hover:bg-accent'
            }`}
          >
            <span className="truncate">{TYPE_LABELS[type] ?? type}</span>
            <span className="text-muted-foreground shrink-0 ml-2">{counts.pending}</span>
          </button>
        ))}
      </div>
    </div>
  );
}

// ── Code change table ────────────────────────────────────────────────────────

function ChangeTable({ changes, onSelect }: { changes: CodeChange[]; onSelect: (c: CodeChange) => void }) {
  const byUrl = changes.reduce<Record<string, CodeChange[]>>((acc, c) => {
    (acc[c.url] ??= []).push(c);
    return acc;
  }, {});

  return (
    <div className="space-y-1">
      {Object.entries(byUrl).map(([url, urlChanges]) => (
        <div key={url}>
          <button
            className="w-full flex items-center justify-between px-4 py-3 hover:bg-accent rounded-lg transition-colors text-left"
            onClick={() => onSelect(urlChanges[0]!)}
          >
            <span className="text-sm text-blue-400 hover:underline truncate">{url}</span>
            <span className="text-xs text-muted-foreground shrink-0 ml-2">
              {urlChanges.length} fix{urlChanges.length !== 1 ? 'es' : ''}
            </span>
          </button>
          <div className="ml-4 border-l border-border pl-4 mb-2">
            {urlChanges.map(change => (
              <button
                key={change._id}
                onClick={() => onSelect(change)}
                className="w-full flex items-center justify-between py-2 px-2 hover:bg-accent rounded text-left transition-colors"
              >
                <span className="text-xs text-muted-foreground">{TYPE_LABELS[change.type] ?? change.type}</span>
                <Badge variant="outline" className="text-xs capitalize">{change.status}</Badge>
              </button>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

// ── FAQ / TLDR lists (unchanged from the previous hybrid page) ─────────────

function FAQList({ faqs }: { faqs: FAQ[] }) {
  const [expanded, setExpanded] = useState<string | null>(null);

  const withQuestions = faqs.filter(f => f.questions && f.questions.length > 0);
  if (withQuestions.length === 0) {
    return (
      <p className="text-sm text-muted-foreground py-8 text-center">
        {faqs.length === 0 ? 'No FAQs generated yet. Complete the pipeline to generate FAQs.' : 'FAQs are pending LLM generation.'}
      </p>
    );
  }

  return (
    <div className="space-y-1">
      {withQuestions.map(faq => (
        <div key={faq._id}>
          <button
            className="w-full flex items-center justify-between px-4 py-3 hover:bg-accent rounded-lg transition-colors text-left"
            onClick={() => setExpanded(expanded === faq._id ? null : faq._id)}
          >
            <span className="text-sm text-blue-400 truncate">{faq.sourceUrl}</span>
            <div className="flex items-center gap-2 shrink-0 ml-2">
              <span className="text-xs text-muted-foreground">
                {faq.questions?.length} question{faq.questions?.length !== 1 ? 's' : ''}
              </span>
              <Badge variant="outline" className="text-xs capitalize">{faq.status}</Badge>
            </div>
          </button>
          {expanded === faq._id && faq.questions && (
            <div className="ml-4 border-l border-border pl-4 mb-2 space-y-3 py-2">
              {faq.questions.map((q, i) => (
                <div key={i} className="space-y-1">
                  <p className="text-xs font-medium">{q.question}</p>
                  <p className="text-xs text-muted-foreground leading-relaxed">{q.answer}</p>
                </div>
              ))}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

function TLDRList({ tldrs }: { tldrs: TLDR[] }) {
  const withText = tldrs.filter(t => t.tldrText);
  if (withText.length === 0) {
    return (
      <p className="text-sm text-muted-foreground py-8 text-center">
        {tldrs.length === 0 ? 'No TL;DRs generated yet. Complete the pipeline to generate summaries.' : 'TL;DRs are pending LLM generation.'}
      </p>
    );
  }

  return (
    <div className="space-y-1">
      {withText.map(tldr => (
        <div key={tldr._id} className="px-4 py-3 border border-border rounded-lg space-y-1.5">
          <div className="flex items-center justify-between">
            <span className="text-sm text-blue-400 truncate">{tldr.sourceUrl}</span>
            <Badge variant="outline" className="text-xs capitalize shrink-0 ml-2">{tldr.status}</Badge>
          </div>
          <p className="text-xs text-muted-foreground leading-relaxed">{tldr.tldrText}</p>
        </div>
      ))}
    </div>
  );
}

// ── Page ──────────────────────────────────────────────────────────────────

export default function TechnicalSeoPage({ params }: { params: Promise<{ projectId: string }> }) {
  const { projectId } = use(params);
  const [typeFilter, setTypeFilter] = useState<string | null>(null);
  const [selected, setSelected]     = useState<CodeChange | null>(null);

  const { data: changes, isLoading } = useCodeChanges(
    projectId,
    typeFilter ? { type: typeFilter, status: 'pending' } : { status: 'pending' },
  );
  const { data: faqs,  isLoading: faqLoading }  = useFAQs(projectId);
  const { data: tldrs, isLoading: tldrLoading } = useTLDRs(projectId);

  const applyChange   = useApplyCodeChange(projectId);
  const disableChange = useDisableCodeChange(projectId);

  return (
    <div className="p-8">
      <div className="flex items-start justify-between mb-6">
        <div className="flex items-center gap-3">
          <div className="h-9 w-9 rounded-lg bg-primary/10 flex items-center justify-center">
            <Terminal className="h-4 w-4 text-primary" />
          </div>
          <div>
            <h1 className="text-xl font-semibold">Technical SEO & GEO</h1>
            <p className="text-sm text-muted-foreground">Code optimization recommendations</p>
          </div>
        </div>

        {/* NOTE: bulk-apply semantics not yet decided — the backend only
            supports applying one CodeChange at a time
            (auditService.applyCodeChange), and this audit can have
            2000+ pending changes. Applying them one-by-one from the
            client would mean thousands of sequential requests; a real
            bulk-apply needs its own backend endpoint/design (batching,
            partial failure handling, whether it should also trigger a
            CMS resync). Disabled here rather than faked. */}
        <Button disabled title="Bulk apply isn't built yet — see code comment">
          Apply Changes
        </Button>
      </div>

      <div className="flex gap-6">
        <FilterSidebar projectId={projectId} selected={typeFilter} onChange={setTypeFilter} />

        <div className="flex-1 min-w-0">
          <Tabs defaultValue="active">
            <TabsList>
              <TabsTrigger value="active">Active code changes</TabsTrigger>
              <TabsTrigger value="faqs">FAQs</TabsTrigger>
              <TabsTrigger value="tldrs">TL;DRs</TabsTrigger>
            </TabsList>

            <TabsContent value="active">
              <p className="text-sm text-muted-foreground mb-4">
                Aligns your site with technical SEO best practices to ensure your site is
                search-engine-friendly, improving overall ranking potential.
              </p>
              {isLoading ? (
                <Skeleton className="h-96 w-full" />
              ) : !changes || changes.length === 0 ? (
                <p className="text-sm text-muted-foreground py-8 text-center">
                  {typeFilter ? 'No pending fixes for this type.' : 'No pending fixes. Run the pipeline to detect issues.'}
                </p>
              ) : (
                <ChangeTable changes={changes} onSelect={setSelected} />
              )}
            </TabsContent>

            <TabsContent value="faqs">
              {faqLoading ? <Skeleton className="h-64 w-full" /> : <FAQList faqs={faqs ?? []} />}
            </TabsContent>

            <TabsContent value="tldrs">
              {tldrLoading ? <Skeleton className="h-64 w-full" /> : <TLDRList tldrs={tldrs ?? []} />}
            </TabsContent>
          </Tabs>
        </div>
      </div>

      {selected && (
        <DiffModal
          change={selected}
          onClose={() => setSelected(null)}
          onApply={(id) => { applyChange.mutate(id); setSelected(null); }}
          onDisable={(id) => { disableChange.mutate(id); setSelected(null); }}
          isApplying={applyChange.isPending}
          isDisabling={disableChange.isPending}
        />
      )}
    </div>
  );
}
