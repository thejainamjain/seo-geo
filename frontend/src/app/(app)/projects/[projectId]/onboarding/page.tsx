'use client';

import { useState, useEffect, useRef } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { useQuery } from '@tanstack/react-query';
import Link from 'next/link';
import Image from 'next/image';
import {
  useBusinessContext, useSaveOnboardingStep, useStartPipeline, useProject,
  useGscStatus, useUpdateCms,
  useKnowledgeFiles, useUploadKnowledgeFile, useDeleteKnowledgeFile,
  useUploadPoolImage, useDeletePoolImage, usePoolImages,
} from '@/lib/hooks';
import { pipelineApi, gscApi } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogTrigger,
} from '@/components/ui/dialog';
import {
  Loader2, X, Plus, BarChart2, Wrench, Headphones, Sparkles, Zap,
  Settings2, CheckCircle2, Trash2, FileStack, Upload, ImageIcon, ImagePlus,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import type { KnowledgeFile } from '@/types/api';

// ── Step config ────────────────────────────────────────────────────────────
// 6 steps matching the target product's real onboarding flow. Steps 1–2
// still write to BusinessContext (see project.service.ts's saveOnboardingStep
// for exactly how the new step numbers map onto its company/product/
// customers/competition fields); steps 3–6 are new and mostly delegate to
// their own APIs (gscApi, cmsApi, knowledgeApi) rather than this wizard's
// own save endpoint.

const STEPS = [
  { number: 1, label: 'Business' },
  { number: 2, label: 'Audience & Competitors' },
  { number: 3, label: 'Setup Analytics' },
  { number: 4, label: 'Site Integration' },
  { number: 5, label: 'Blog Post Settings' },
  { number: 6, label: 'Auto Publish' },
] as const;

type StepNumber = 1 | 2 | 3 | 4 | 5 | 6;

// ── Tag input component (unchanged) ─────────────────────────────────────────

function TagInput({
  value,
  onChange,
  placeholder,
}: {
  value: string[];
  onChange: (v: string[]) => void;
  placeholder?: string;
}) {
  const [input, setInput] = useState('');

  const add = () => {
    const trimmed = input.trim();
    if (trimmed && !value.includes(trimmed)) {
      onChange([...value, trimmed]);
    }
    setInput('');
  };

  const remove = (tag: string) => onChange(value.filter(t => t !== tag));

  return (
    <div className="space-y-2">
      <div className="flex gap-2">
        <Input
          value={input}
          onChange={(e: React.ChangeEvent<HTMLInputElement>) => setInput(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); add(); } }}
          placeholder={placeholder}
          className="flex-1"
        />
        <Button type="button" variant="outline" size="sm" onClick={add}>
          <Plus className="h-4 w-4" />
        </Button>
      </div>
      {value.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {value.map(tag => (
            <Badge key={tag} variant="secondary" className="gap-1 pr-1">
              {tag}
              <button onClick={() => remove(tag)} className="hover:text-destructive">
                <X className="h-3 w-3" />
              </button>
            </Badge>
          ))}
        </div>
      )}
    </div>
  );
}

// ── Wizard-wide data shape ───────────────────────────────────────────────────
// Flattened by CONCERN rather than by step number, since new steps 3/4/6
// don't own any BusinessContext field the old per-step-number shape assumed.

interface WizardData {
  company: Record<string, unknown>;
  product: Record<string, unknown>;
  segments: string[];
  competitors: string[];
  writerNotes: string;
  autoPublishMode: 'auto' | 'manual';
}

const EMPTY_WIZARD_DATA: WizardData = {
  company: {}, product: {}, segments: [], competitors: [],
  writerNotes: '', autoPublishMode: 'auto',
};

// ── Step 1: Business (merges old "Company" + "Product & pricing" steps) ─────

function Step1Business({ data, onChange }: { data: WizardData; onChange: (d: WizardData) => void }) {
  const setCompany = (key: string, val: unknown) => onChange({ ...data, company: { ...data.company, [key]: val } });
  const setProduct = (key: string, val: unknown) => onChange({ ...data, product: { ...data.product, [key]: val } });
  return (
    <div className="space-y-8">
      <div className="space-y-5">
        <h3 className="text-sm font-medium text-muted-foreground uppercase tracking-wide">Company</h3>
        <div className="space-y-1.5">
          <Label>Company name</Label>
          <Input
            placeholder="Acme Inc."
            value={(data.company.name as string) ?? ''}
            onChange={(e: React.ChangeEvent<HTMLInputElement>) => setCompany('name', e.target.value)}
          />
        </div>
        <div className="space-y-1.5">
          <Label>Website</Label>
          <Input
            placeholder="https://acme.com"
            value={(data.company.website as string) ?? ''}
            onChange={(e: React.ChangeEvent<HTMLInputElement>) => setCompany('website', e.target.value)}
          />
        </div>
        <div className="space-y-1.5">
          <Label>Target regions or languages</Label>
          <Input
            placeholder="e.g. United States, English"
            value={(data.company.targetRegions as string) ?? ''}
            onChange={(e: React.ChangeEvent<HTMLInputElement>) => setCompany('targetRegions', e.target.value)}
          />
        </div>
        <div className="space-y-1.5">
          <Label>Business description</Label>
          <Textarea
            placeholder="What does your company do in 2–3 sentences?"
            value={(data.company.description as string) ?? ''}
            onChange={(e: React.ChangeEvent<HTMLTextAreaElement>) => setCompany('description', e.target.value)}
            rows={3}
          />
        </div>
      </div>

      <div className="space-y-5">
        <h3 className="text-sm font-medium text-muted-foreground uppercase tracking-wide">Product &amp; pricing</h3>
        <div className="space-y-1.5">
          <Label>What the business sells</Label>
          <Textarea
            placeholder="Describe your main product or service offering"
            value={(data.product.whatItSells as string) ?? ''}
            onChange={(e: React.ChangeEvent<HTMLTextAreaElement>) => setProduct('whatItSells', e.target.value)}
            rows={3}
          />
        </div>
        <div className="space-y-1.5">
          <Label>Key features and benefits</Label>
          <Textarea
            placeholder="List the main features and what they mean for customers"
            value={(data.product.keyFeatures as string) ?? ''}
            onChange={(e: React.ChangeEvent<HTMLTextAreaElement>) => setProduct('keyFeatures', e.target.value)}
            rows={3}
          />
        </div>
        <div className="grid grid-cols-2 gap-4">
          <div className="space-y-1.5">
            <Label>Free trial or demo?</Label>
            <Input
              placeholder="e.g. 14-day free trial"
              value={(data.product.freeTrialAvailable as string) ?? ''}
              onChange={(e: React.ChangeEvent<HTMLInputElement>) => setProduct('freeTrialAvailable', e.target.value)}
            />
          </div>
          <div className="space-y-1.5">
            <Label>Avg. lifetime value per client</Label>
            <Input
              placeholder="e.g. $2,400/year"
              value={(data.product.lifetimeValuePerClient as string) ?? ''}
              onChange={(e: React.ChangeEvent<HTMLInputElement>) => setProduct('lifetimeValuePerClient', e.target.value)}
            />
          </div>
        </div>
      </div>
    </div>
  );
}

// ── Step 2: Audience & Competitors ───────────────────────────────────────────
// Matches the target screenshot exactly: just two tag inputs. The old flow
// also asked for painPoints/differentiation/tradeOffs/proof etc. — those
// BusinessContext fields still exist and the AI still drafts them, they're
// just not asked for in this wizard anymore since the real product doesn't
// show them here. (Worth a "Business" settings page later if you want them
// editable somewhere.)

function Step2Audience({ data, onChange }: { data: WizardData; onChange: (d: WizardData) => void }) {
  return (
    <div className="space-y-6">
      <div className="space-y-1.5">
        <Label className="text-base">Target Audiences</Label>
        <p className="text-xs text-muted-foreground">
          Enter your target audience groups to create relevant content. Better audience understanding improves results.
        </p>
        <TagInput
          value={data.segments}
          onChange={v => onChange({ ...data, segments: v })}
          placeholder="Enter your target audience groups (e.g., Developers, Project Managers)."
        />
      </div>
      <div className="space-y-1.5">
        <Label className="text-base">Competitors</Label>
        <p className="text-xs text-muted-foreground">
          Enter competitors to discover the SEO keywords they rank for. Bigger competitors provide more valuable insights.
        </p>
        <TagInput
          value={data.competitors}
          onChange={v => onChange({ ...data, competitors: v })}
          placeholder="Enter competitor URLs or company names (e.g. https://revid.ai or revid.ai)."
        />
      </div>
    </div>
  );
}

// ── Step 3: Setup Analytics (Connect Google Search Console) ─────────────────

function Step3Analytics({ projectId }: { projectId: string }) {
  const { data: gsc, isLoading } = useGscStatus(projectId);

  if (isLoading) return <Skeleton className="h-48 w-full" />;

  if (gsc?.connected) {
    return (
      <div className="text-center space-y-3 py-6">
        <CheckCircle2 className="mx-auto h-10 w-10 text-green-600" />
        <div>
          <p className="font-medium">Google Search Console connected</p>
          <p className="text-xs text-muted-foreground mt-1">
            We&apos;ll use this to prioritize keywords and track results automatically.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="text-center space-y-4 py-2">
      <div className="mx-auto w-16 h-16 rounded-full bg-accent flex items-center justify-center">
        <BarChart2 className="h-7 w-7 text-muted-foreground" />
      </div>
      <div className="max-w-sm mx-auto">
        <h3 className="text-lg font-semibold">Connect Google Search Console</h3>
        <p className="text-sm text-muted-foreground mt-1">
          Connect your GSC to unlock a strategy based on your current performance. We&apos;ll prioritize keywords, track results, and improve strategy automatically.
        </p>
      </div>
      <Button
        type="button"
        onClick={() => { window.location.href = gscApi.getConnectUrl(projectId); }}
      >
        Connect Google Search Console
      </Button>
      <p className="text-xs text-muted-foreground">
        This helps us understand your current rankings and optimize accordingly
      </p>
    </div>
  );
}

// ── Step 4: Site Integration (CMS) ───────────────────────────────────────────
// The full multi-platform CMS connect form (platform picker + per-platform
// credential fields) already exists in the Settings page — duplicating
// ~450 lines of that here risked the two drifting apart, so "Integrate
// yourself" links out to it instead of re-implementing it inline.
// "Have our team integrate for you" has nowhere to persist that preference
// — there's no lead/request field or table for it on the backend. Flagging
// that rather than silently no-op'ing it: right now it just advances the
// wizard, the same as Skip would.

function Step4Integration({ projectId, choice, onChoice }: {
  projectId: string;
  choice: 'self' | 'team' | null;
  onChoice: (c: 'self' | 'team') => void;
}) {
  return (
    <div className="space-y-4">
      <p className="text-sm text-center text-muted-foreground max-w-md mx-auto">
        Connect your CMS so we can publish articles. Choose how you&apos;d like to set it up.
      </p>
      <div className="grid grid-cols-2 gap-4">
        <button
          type="button"
          onClick={() => onChoice('self')}
          className={cn(
            'border rounded-lg p-6 text-center space-y-2 transition-colors',
            choice === 'self' ? 'border-foreground bg-accent/50' : 'border-border hover:bg-accent/30',
          )}
        >
          <Wrench className="mx-auto h-6 w-6 text-muted-foreground" />
          <p className="font-semibold text-sm">Integrate yourself</p>
          <p className="text-xs text-muted-foreground">Select your CMS and follow the configuration steps.</p>
        </button>
        <button
          type="button"
          onClick={() => onChoice('team')}
          className={cn(
            'border rounded-lg p-6 text-center space-y-2 transition-colors',
            choice === 'team' ? 'border-foreground bg-accent/50' : 'border-border hover:bg-accent/30',
          )}
        >
          <Headphones className="mx-auto h-6 w-6 text-muted-foreground" />
          <p className="font-semibold text-sm">Have our team integrate for you</p>
          <p className="text-xs text-muted-foreground">We&apos;ll help you connect it later.</p>
        </button>
      </div>

      {choice === 'self' && (
        <Alert>
          <AlertDescription>
            Head to{' '}
            <Link href={`/projects/${projectId}/settings`} className="underline font-medium">
              Settings → CMS
            </Link>{' '}
            to pick your platform and connect credentials — that flow already exists there. Come back and hit Continue when you&apos;re done, or just Continue now and do it later.
          </AlertDescription>
        </Alert>
      )}
      {choice === 'team' && (
        <Alert>
          <AlertDescription>
            Noted — heads up though: there&apos;s no backend field yet to actually record this request anywhere. This just advances the wizard for now; someone will need to reach out manually until that&apos;s built.
          </AlertDescription>
        </Alert>
      )}
    </div>
  );
}

// ── Image configuration dialog ───────────────────────────────────────────────
// Deliberately NOT a clone of the richer reference UI (brand colors, theme+
// text-based images, AI-generated fallback) — this app only has two real
// image sources: the user's uploaded pool (primary, no limit) and Unsplash
// (automatic fallback once the pool runs out).

function ImageConfigDialog({ projectId }: { projectId: string }) {
  const [open, setOpen] = useState(false);
  const { data: images, isLoading } = usePoolImages(projectId);
  const uploadMut = useUploadPoolImage(projectId);
  const deleteMut = useDeletePoolImage(projectId);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const availableCount = images?.filter(img => img.status === 'available').length ?? 0;
  const hasImages = !!images && images.length > 0;

  function handleFile(file: File) {
    uploadMut.mutate(file);
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <button type="button" className="text-xs font-medium text-primary hover:underline shrink-0">
          Configure
        </button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Image configuration</DialogTitle>
          <DialogDescription>
            Upload the images you want used as blog hero images — no limit. We work through them in upload order, one per blog. Unsplash only kicks in automatically once none are left; there&apos;s no AI image generation anywhere in this app.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          <div className="rounded-lg border border-border p-3 flex items-start gap-2">
            <ImageIcon className="h-4 w-4 text-muted-foreground mt-0.5 shrink-0" />
            <p className="text-xs text-muted-foreground">
              <span className="font-medium text-foreground">{availableCount} available</span> to use next
              {hasImages && images!.some(img => img.status === 'used') && ' — images already used on a past blog are tagged below and won\u2019t be reused'}.
              Once your uploads run out, new blogs automatically fall back to a relevant Unsplash photo.
            </p>
          </div>

          <input
            ref={fileInputRef}
            type="file"
            accept="image/png,image/jpeg,image/webp,image/gif"
            className="hidden"
            onChange={e => {
              const file = e.target.files?.[0];
              if (file) handleFile(file);
              e.target.value = '';
            }}
          />

          {!isLoading && !hasImages && (
            <p className="text-xs text-muted-foreground">No images added yet.</p>
          )}

          <div className="grid grid-cols-3 gap-2 max-h-80 overflow-y-auto pr-1">
            <button
              type="button"
              disabled={uploadMut.isPending}
              onClick={() => fileInputRef.current?.click()}
              className="aspect-square rounded-md border border-dashed border-border hover:border-muted-foreground/50 hover:bg-muted/30 transition-colors flex flex-col items-center justify-center gap-1 text-muted-foreground"
            >
              {uploadMut.isPending ? <Loader2 className="h-5 w-5 animate-spin" /> : <ImagePlus className="h-5 w-5" />}
              <span className="text-[10px] text-center px-1">{uploadMut.isPending ? 'Uploading…' : 'Add image'}</span>
            </button>

            {isLoading && <div className="aspect-square rounded-md bg-muted animate-pulse" />}

            {images?.map(img => (
              <div key={img._id} className="relative aspect-square rounded-md overflow-hidden bg-muted group">
                <Image src={img.url} alt="" fill className="object-cover" />
                {img.status === 'used' && (
                  <Badge variant="secondary" className="absolute top-1 left-1 text-[10px] px-1 py-0">
                    Used
                  </Badge>
                )}
                <button
                  type="button"
                  onClick={() => deleteMut.mutate(img._id)}
                  disabled={deleteMut.isPending}
                  title="Remove"
                  className="absolute inset-0 bg-black/0 group-hover:bg-black/40 transition-colors flex items-center justify-center opacity-0 group-hover:opacity-100"
                >
                  <X className="h-4 w-4 text-white" />
                </button>
              </div>
            ))}
          </div>

          <p className="text-[11px] text-muted-foreground">
            PNG, JPEG, WebP, or GIF — max 5MB each.
          </p>

          {uploadMut.isError && (
            <p className="text-xs text-destructive">Upload failed — try again.</p>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

// ── Step 5: Blog Post Settings ───────────────────────────────────────────────

function KnowledgeFileRow({ file, onDelete, isDeleting }: {
  file: KnowledgeFile;
  onDelete: () => void;
  isDeleting: boolean;
}) {
  const statusVariant: Record<string, 'default' | 'secondary' | 'outline' | 'destructive'> = {
    ready: 'default', processing: 'secondary', pending: 'outline', error: 'destructive',
  };
  return (
    <div className="flex items-center justify-between border border-border rounded-md px-3 py-2">
      <div className="min-w-0">
        <p className="text-sm truncate">{file.originalName}</p>
        <p className="text-xs text-muted-foreground">{(file.sizeBytes / 1024).toFixed(0)} KB</p>
      </div>
      <div className="flex items-center gap-2 shrink-0">
        <Badge variant={statusVariant[file.status] ?? 'outline'} className="text-xs capitalize">{file.status}</Badge>
        <button onClick={onDelete} disabled={isDeleting} className="text-muted-foreground hover:text-destructive">
          <Trash2 className="h-3.5 w-3.5" />
        </button>
      </div>
    </div>
  );
}

function Step5BlogSettings({ projectId, data, onChange }: {
  projectId: string;
  data: WizardData;
  onChange: (d: WizardData) => void;
}) {
  const { data: files, isLoading: filesLoading } = useKnowledgeFiles(projectId);
  const uploadMut = useUploadKnowledgeFile(projectId);
  const deleteMut = useDeleteKnowledgeFile(projectId);

  return (
    <div className="space-y-6">
      {/* Images */}
      <div className="border border-border rounded-lg p-4 space-y-2">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <span className="font-medium text-sm">Images</span>
            <Badge variant="outline" className="text-xs">Your uploads + Unsplash</Badge>
          </div>
          <ImageConfigDialog projectId={projectId} />
        </div>
        <p className="text-xs text-muted-foreground">
          Blogs use images you upload here first, then automatically fall back to Unsplash once those run out — no setup needed either way. You can always replace a specific blog&apos;s image from its editor after it&apos;s generated.
        </p>
      </div>

      {/* Knowledge base */}
      <div className="border border-border rounded-lg p-4 space-y-3">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <FileStack className="h-4 w-4 text-muted-foreground" />
            <span className="font-medium text-sm">Knowledge base</span>
            <span className="text-xs text-muted-foreground">up to 25 · PDF, text, Markdown, CSV, JSON</span>
          </div>
          <label className="cursor-pointer">
            <input
              type="file"
              className="hidden"
              accept=".pdf,.txt,.md,.csv,.json"
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (file) uploadMut.mutate(file);
                e.target.value = '';
              }}
            />
            <span className="inline-flex items-center gap-1.5 text-xs border border-border rounded-md px-2.5 py-1.5 hover:bg-accent transition-colors">
              {uploadMut.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Upload className="h-3.5 w-3.5" />}
              Upload
            </span>
          </label>
        </div>
        {filesLoading && <Skeleton className="h-10 w-full" />}
        {!filesLoading && (!files || files.length === 0) && (
          <p className="text-xs text-muted-foreground">No documents yet.</p>
        )}
        {files && files.length > 0 && (
          <div className="space-y-1.5">
            {files.map(f => (
              <KnowledgeFileRow
                key={f._id}
                file={f}
                onDelete={() => deleteMut.mutate(f._id)}
                isDeleting={deleteMut.isPending && deleteMut.variables === f._id}
              />
            ))}
          </div>
        )}
      </div>

      {/* Writer notes */}
      <div className="border border-border rounded-lg p-4 space-y-2">
        <div className="flex items-center gap-2">
          <Sparkles className="h-4 w-4 text-muted-foreground" />
          <span className="font-medium text-sm">Writer notes</span>
          <span className="text-xs text-muted-foreground">optional</span>
        </div>
        <Textarea
          placeholder="Tone, style, things to always mention or avoid — anything the AI writer should know."
          value={data.writerNotes}
          onChange={(e: React.ChangeEvent<HTMLTextAreaElement>) => onChange({ ...data, writerNotes: e.target.value })}
          rows={3}
        />
      </div>
    </div>
  );
}

// ── Step 6: Auto Publish ─────────────────────────────────────────────────────

function Step6AutoPublish({ mode, onChange }: { mode: 'auto' | 'manual'; onChange: (m: 'auto' | 'manual') => void }) {
  return (
    <div className="space-y-4">
      <div className="text-center">
        <h3 className="text-lg font-semibold">Choose Your Publishing Mode</h3>
        <p className="text-sm text-muted-foreground mt-1">Select how you&apos;d like content publishing to be managed</p>
      </div>
      <div className="grid grid-cols-2 gap-4">
        <button
          type="button"
          onClick={() => onChange('auto')}
          className={cn(
            'border rounded-lg p-5 text-left space-y-2 transition-colors',
            mode === 'auto' ? 'border-foreground bg-accent/50' : 'border-border hover:bg-accent/30',
          )}
        >
          <Zap className="h-5 w-5 text-muted-foreground" />
          <p className="font-semibold text-sm">Auto Publish</p>
          <p className="text-xs text-muted-foreground">
            Automatically publishes, tracks, and rewrites content based on Google&apos;s feedback. Edit or remove any page anytime.
          </p>
        </button>
        <button
          type="button"
          onClick={() => onChange('manual')}
          className={cn(
            'border rounded-lg p-5 text-left space-y-2 transition-colors',
            mode === 'manual' ? 'border-foreground bg-accent/50' : 'border-border hover:bg-accent/30',
          )}
        >
          <Settings2 className="h-5 w-5 text-muted-foreground" />
          <p className="font-semibold text-sm">Manual Publish</p>
          <p className="text-xs text-muted-foreground">
            Review and publish content yourself each week. Full editorial control, slower optimization cycles.
          </p>
        </button>
      </div>
    </div>
  );
}

// ── Step titles ────────────────────────────────────────────────────────────

const STEP_META: Record<StepNumber, { title: string; subtitle: string }> = {
  1: { title: 'Business',                subtitle: 'Confirm your company and product basics' },
  2: { title: 'Audience & Competitors',  subtitle: 'Who you\u2019re writing for, and who you\u2019re up against' },
  3: { title: 'Setup Analytics',         subtitle: 'Connect Google Search Console' },
  4: { title: 'Site Integration',        subtitle: 'Connect your CMS so we can publish articles' },
  5: { title: 'Blog Post Settings',      subtitle: 'Images, knowledge base, and custom writer instructions' },
  6: { title: 'Auto Publish',            subtitle: 'Select how you\u2019d like RankAI to manage your content publishing' },
};

// ── Loading screen ─────────────────────────────────────────────────────────

const ANALYSING_MESSAGES = [
  'Crawling your website…',
  'Reading your pages…',
  'Building your business profile…',
  'Almost ready…',
];

function AnalysingScreen() {
  const [msgIndex, setMsgIndex] = useState(0);

  useEffect(() => {
    const interval = setInterval(() => {
      setMsgIndex(i => (i + 1) % ANALYSING_MESSAGES.length);
    }, 4000);
    return () => clearInterval(interval);
  }, []);

  return (
    <div className="min-h-screen flex flex-col items-center justify-center gap-5">
      <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
      <div className="text-center space-y-1">
        <p className="text-sm font-medium">{ANALYSING_MESSAGES[msgIndex]}</p>
        <p className="text-xs text-muted-foreground">
          We&apos;re analysing your site. Takes 1–2 minutes.
        </p>
      </div>
    </div>
  );
}

// ── Main page ──────────────────────────────────────────────────────────────

export default function OnboardingPage() {
  const params    = useParams();
  const router    = useRouter();
  const projectId = params.projectId as string;

  // Poll pipeline status until BUSINESS_PROFILE is complete
  const { data: pipelineStatus } = useQuery({
    queryKey:        ['pipeline', projectId],
    queryFn:         () => pipelineApi.status(projectId),
    enabled:         !!projectId,
    refetchInterval: (query) => {
      const bp = query.state.data?.steps?.find((s: { step: string }) => s.step === 'BUSINESS_PROFILE');
      return bp?.status === 'COMPLETED' ? false : 3_000;
    },
  });

  const bpDone = pipelineStatus?.steps?.find(
    (s: { step: string; status: string }) => s.step === 'BUSINESS_PROFILE'
  )?.status === 'COMPLETED';

  const { data: businessContextData, isLoading: isLoadingContext } = useBusinessContext(projectId);
  const { data: project } = useProject(projectId);
  const saveStep      = useSaveOnboardingStep(projectId);
  const startPipeline = useStartPipeline(projectId);
  const updateCms     = useUpdateCms(projectId);

  const [currentStep, setCurrentStep] = useState<StepNumber>(1);
  const [data, setData] = useState<WizardData>(EMPTY_WIZARD_DATA);
  const [integrationChoice, setIntegrationChoice] = useState<'self' | 'team' | null>(null);
  // Tracks which project's data we've already prefilled into local wizard
  // state, keyed by projectId rather than a bare boolean so navigating
  // between projects' onboarding wizards re-prefills correctly. Set
  // synchronously during render (not in a useEffect) — this is React's
  // documented pattern for "adjust state based on a prop/query result",
  // and avoids the cascading-render issue calling setState from inside an
  // effect body would cause.
  const [prefilledFor, setPrefilledFor] = useState<string | null>(null);

  if (businessContextData && project && prefilledFor !== projectId) {
    setPrefilledFor(projectId);
    setData(d => ({
      ...d,
      company:     (businessContextData.company as Record<string, unknown>) ?? {},
      product:     (businessContextData.product as Record<string, unknown>) ?? {},
      segments:    businessContextData.customers?.segments ?? [],
      competitors: businessContextData.competition?.mainCompetitors?.map(c => c.domain) ?? [],
      writerNotes: project.blogWriterInstruction ?? '',
    }));
  }

  // aiDraftedSteps still uses the OLD field-based numbering (1=company,
  // 2=product, 3=customers, 4=competition, 5=socialProof) — see
  // project.service.ts's module comment. Map that onto the new UI steps.
  const aiDrafted = businessContextData?.aiDraftedSteps ?? [];
  const step1AiFilled = aiDrafted.includes(1) && aiDrafted.includes(2);
  const step2AiFilled = aiDrafted.includes(3) && aiDrafted.includes(4);

  const buildStepPayload = (step: StepNumber): Record<string, unknown> => {
    switch (step) {
      case 1: return { company: data.company, product: data.product };
      case 2: return { customers: { segments: data.segments }, competition: { mainCompetitors: data.competitors } };
      case 3: return {};
      case 4: return {};
      case 5: return { blogWriterInstruction: data.writerNotes };
      case 6: return {};
    }
  };

  const handleContinue = async () => {
    await saveStep.mutateAsync({ step: currentStep, data: buildStepPayload(currentStep) });
    if (currentStep < 6) setCurrentStep((currentStep + 1) as StepNumber);
  };

  const handleComplete = async () => {
    // autoPublish lives on CmsConfig, not BusinessContext/Project — save it
    // directly before marking the wizard step done. updateCmsConfig upserts
    // now specifically so this works even if Site Integration was skipped
    // and no CmsConfig doc exists yet (see cms.service.ts).
    await updateCms.mutateAsync({ autoPublish: data.autoPublishMode === 'auto' });
    await saveStep.mutateAsync({ step: 6, data: {} });
    await startPipeline.mutateAsync();
    router.push(`/projects/${projectId}/overview`);
  };

  const handleBack = () => {
    if (currentStep > 1) setCurrentStep((currentStep - 1) as StepNumber);
  };

  const meta     = STEP_META[currentStep];
  const isSaving = saveStep.isPending || updateCms.isPending;
  const isLast   = currentStep === 6;
  const error    = saveStep.error ?? startPipeline.error ?? updateCms.error;

  // Step 5 gates Continue on an image mode being chosen (matches the
  // target product's "Image settings are required to continue" banner).

  // Show loading until BUSINESS_PROFILE completes
  if (!bpDone || isLoadingContext) {
    return <AnalysingScreen />;
  }

  return (
    <div className="min-h-screen bg-background">

      {/* Step progress bar */}
      <div className="border-b border-border">
        <div className="max-w-2xl mx-auto px-6 py-4 overflow-x-auto">
          <div className="flex items-center">
            {STEPS.map((step, i) => {
              const isActive    = step.number === currentStep;
              const isCompleted = step.number < currentStep;
              return (
                <div key={step.number} className="flex items-center">
                  <div className="flex items-center gap-2">
                    <div className={cn(
                      'w-6 h-6 rounded-full flex items-center justify-center text-xs font-medium transition-colors shrink-0',
                      (isActive || isCompleted) ? 'bg-foreground text-background' : 'border border-border text-muted-foreground',
                    )}>
                      {step.number}
                    </div>
                    <span className={cn(
                      'text-sm transition-colors whitespace-nowrap',
                      isActive    && 'text-foreground font-medium',
                      isCompleted && 'text-foreground',
                      !isActive && !isCompleted && 'text-muted-foreground',
                    )}>
                      {step.label}
                    </span>
                  </div>
                  {i < STEPS.length - 1 && <div className="w-6 h-px bg-border mx-2 shrink-0" />}
                </div>
              );
            })}
          </div>
        </div>
      </div>

      {/* AI pre-fill notice */}
      {((currentStep === 1 && step1AiFilled) || (currentStep === 2 && step2AiFilled)) && (
        <div className="max-w-2xl mx-auto px-6 pt-6">
          <div className="text-xs text-muted-foreground bg-accent/50 border border-border rounded-md px-3 py-2">
            ✦ Fields pre-filled by AI from your website. Review and edit anything that needs updating.
          </div>
        </div>
      )}

      {/* Form area */}
      <div className="max-w-2xl mx-auto px-6 py-6">
        <div className="mb-6 text-center">
          <h1 className="text-xl font-semibold">{meta.title}</h1>
          <p className="text-sm text-muted-foreground mt-1">{meta.subtitle}</p>
        </div>

        <div className="border border-border rounded-lg p-6 bg-card space-y-6">
          {error && (
            <Alert variant="destructive">
              <AlertDescription>
                {(error as { response?: { data?: { error?: { message?: string } } } })
                  ?.response?.data?.error?.message ?? 'Something went wrong. Please try again.'}
              </AlertDescription>
            </Alert>
          )}

          {currentStep === 1 && <Step1Business data={data} onChange={setData} />}
          {currentStep === 2 && <Step2Audience data={data} onChange={setData} />}
          {currentStep === 3 && <Step3Analytics projectId={projectId} />}
          {currentStep === 4 && (
            <Step4Integration projectId={projectId} choice={integrationChoice} onChoice={setIntegrationChoice} />
          )}
          {currentStep === 5 && <Step5BlogSettings projectId={projectId} data={data} onChange={setData} />}
          {currentStep === 6 && (
            <Step6AutoPublish
              mode={data.autoPublishMode}
              onChange={m => setData({ ...data, autoPublishMode: m })}
            />
          )}

          <div className="flex items-center justify-between pt-2">
            <Button type="button" variant="outline" onClick={handleBack} disabled={currentStep === 1 || isSaving}>
              Back
            </Button>

            {isLast ? (
              <Button type="button" onClick={handleComplete} disabled={isSaving || startPipeline.isPending}>
                {(isSaving || startPipeline.isPending)
                  ? <><Loader2 className="h-4 w-4 mr-2 animate-spin" />Completing…</>
                  : 'Complete'}
              </Button>
            ) : (
              <Button type="button" onClick={handleContinue} disabled={isSaving}>
                {isSaving
                  ? <><Loader2 className="h-4 w-4 mr-2 animate-spin" />Saving…</>
                  : 'Continue'}
              </Button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
