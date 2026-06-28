'use client';

import { use, useState } from 'react';
import { useCodeChanges, useLatestAudit } from '@/lib/hooks';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import type { CodeChange } from '@/types/api';

const TYPE_LABELS: Record<string, string> = {
  title:             'Optimize title',
  description:       'Optimize description',
  open_graph:        'Add Open Graph tags',
  canonical:         'Add canonical tag',
  alt_text:          'Add image alt text',
  link_title:        'Add link title',
  schema:            'Add schema markup',
  broken_link:       'Fix broken link',
  redirect_chain:    'Fix redirect chain',
  thin_content:      'Expand thin content',
  page_speed:        'Improve page speed',
  non_self_canonical:'Fix canonical mismatch',
  missing_h1:        'Add H1 tag',
  schema_invalid:    'Fix invalid schema',
  page_size:         'Reduce page size',
};

function TypeFilter({
  types,
  selected,
  onChange,
}: {
  types: string[];
  selected: string | null;
  onChange: (t: string | null) => void;
}) {
  return (
    <div className="flex flex-wrap gap-1.5 mb-4">
      <button
        onClick={() => onChange(null)}
        className={`px-2.5 py-1 rounded text-xs transition-colors ${
          selected === null
            ? 'bg-foreground text-background'
            : 'bg-muted text-muted-foreground hover:text-foreground'
        }`}
      >
        All
      </button>
      {types.map(t => (
        <button
          key={t}
          onClick={() => onChange(t === selected ? null : t)}
          className={`px-2.5 py-1 rounded text-xs transition-colors ${
            selected === t
              ? 'bg-foreground text-background'
              : 'bg-muted text-muted-foreground hover:text-foreground'
          }`}
        >
          {TYPE_LABELS[t] ?? t}
        </button>
      ))}
    </div>
  );
}

function DiffModal({ change, onClose }: { change: CodeChange; onClose: () => void }) {
  return (
    <Dialog open onOpenChange={onClose}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>{TYPE_LABELS[change.type] ?? change.type}</DialogTitle>
        </DialogHeader>
        <p className="text-xs text-muted-foreground truncate mb-4">{change.url}</p>
        <div className="grid grid-cols-2 gap-4">
          <div>
            <p className="text-xs font-medium text-muted-foreground mb-2 uppercase tracking-wide">Before</p>
            <pre className="text-xs bg-muted/50 border border-border rounded p-3 overflow-auto max-h-48 whitespace-pre-wrap break-all">
              {change.oldHtml || '(empty)'}
            </pre>
          </div>
          <div>
            <p className="text-xs font-medium text-green-500 mb-2 uppercase tracking-wide">After</p>
            <pre className="text-xs bg-green-500/5 border border-green-500/20 rounded p-3 overflow-auto max-h-48 whitespace-pre-wrap break-all">
              {change.newHtml || '(pending LLM generation)'}
            </pre>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

export default function AuditPage({ params }: { params: Promise<{ projectId: string }> }) {
  const { projectId }   = use(params);
  const [typeFilter, setTypeFilter] = useState<string | null>(null);
  const [selected, setSelected]     = useState<CodeChange | null>(null);

  const { data: audit }   = useLatestAudit(projectId);
  const { data: changes, isLoading } = useCodeChanges(
    projectId,
    typeFilter ? { type: typeFilter } : undefined,
  );

  const allTypes   = [...new Set(changes?.map(c => c.type) ?? [])].sort();
  const pending    = changes?.filter(c => c.status === 'pending')  ?? [];
  const applied    = changes?.filter(c => c.status === 'applied')  ?? [];

  return (
    <div className="p-8">
      <div className="flex items-start justify-between mb-8">
        <div>
          <h1 className="text-2xl font-semibold">Technical SEO</h1>
          <p className="text-sm text-muted-foreground mt-1">
            Code changes detected and generated for every page on your site
          </p>
        </div>
        {audit?.summary?.score && (
          <div className="text-right shrink-0">
            <p className="text-3xl font-semibold">{audit.summary.score}</p>
            <p className="text-xs text-muted-foreground">SEO score / 100</p>
            {audit.summary.scoreReasoning && (
              <p className="text-xs text-muted-foreground mt-1 max-w-48">{audit.summary.scoreReasoning}</p>
            )}
          </div>
        )}
      </div>

      {/* Summary cards */}
      {audit?.summary && (
        <div className="grid grid-cols-4 gap-4 mb-8">
          {[
            { label: 'Pages crawled', value: audit.summary.totalPages },
            { label: 'SEO fixes',     value: audit.summary.totalFixes },
            { label: 'Schemas added', value: audit.summary.totalSchemas },
            { label: 'FAQs generated',value: audit.summary.totalFaqs },
          ].map(({ label, value }) => (
            <div key={label} className="border border-border rounded-lg p-4">
              <p className="text-xs text-muted-foreground uppercase tracking-wide">{label}</p>
              <p className="text-2xl font-semibold mt-1">{value}</p>
            </div>
          ))}
        </div>
      )}

      <Tabs defaultValue="pending">
        <TabsList className="mb-4">
          <TabsTrigger value="pending">
            Active {pending.length > 0 ? `(${pending.length})` : ''}
          </TabsTrigger>
          <TabsTrigger value="applied">
            Applied {applied.length > 0 ? `(${applied.length})` : ''}
          </TabsTrigger>
        </TabsList>

        {isLoading && <Skeleton className="h-64 w-full" />}

        {!isLoading && (
          <>
            <TypeFilter
              types={allTypes}
              selected={typeFilter}
              onChange={setTypeFilter}
            />

            <TabsContent value="pending">
              {pending.length === 0 ? (
                <p className="text-sm text-muted-foreground py-8 text-center">
                  {typeFilter ? 'No pending fixes for this type.' : 'No pending fixes. Run the pipeline to detect issues.'}
                </p>
              ) : (
                <ChangeTable changes={pending} onSelect={setSelected} />
              )}
            </TabsContent>

            <TabsContent value="applied">
              {applied.length === 0 ? (
                <p className="text-sm text-muted-foreground py-8 text-center">No applied fixes yet.</p>
              ) : (
                <ChangeTable changes={applied} onSelect={setSelected} />
              )}
            </TabsContent>
          </>
        )}
      </Tabs>

      {selected && <DiffModal change={selected} onClose={() => setSelected(null)} />}
    </div>
  );
}

function ChangeTable({
  changes,
  onSelect,
}: {
  changes: CodeChange[];
  onSelect: (c: CodeChange) => void;
}) {
  // Group by URL
  const byUrl = changes.reduce<Record<string, CodeChange[]>>((acc, c) => {
    if (!acc[c.url]) acc[c.url] = [];
    acc[c.url]!.push(c);
    return acc;
  }, {});

  return (
    <div className="space-y-1">
      {Object.entries(byUrl).map(([url, urlChanges]) => (
        <div key={url}>
          <button
            className="w-full flex items-center justify-between px-4 py-3 hover:bg-accent rounded-lg transition-colors group text-left"
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
                <span className="text-xs text-muted-foreground">
                  {TYPE_LABELS[change.type] ?? change.type}
                </span>
                <Badge variant="outline" className="text-xs capitalize">
                  {change.status}
                </Badge>
              </button>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}
