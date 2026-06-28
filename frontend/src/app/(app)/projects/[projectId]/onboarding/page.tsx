'use client';

import { useState, useEffect } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { useBusinessContext, useSaveOnboardingStep, useStartPipeline } from '@/lib/hooks';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Loader2, X, Plus } from 'lucide-react';
import { cn } from '@/lib/utils';

// ── Step config ────────────────────────────────────────────────────────────

const STEPS = [
  { number: 1, label: 'Company' },
  { number: 2, label: 'Product' },
  { number: 3, label: 'Customers' },
  { number: 4, label: 'Competition' },
  { number: 5, label: 'Social Proof' },
] as const;

// ── Tag input component ────────────────────────────────────────────────────

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
          onChange={(e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => setInput(e.target.value)}
          onKeyDown={e => {
            if (e.key === 'Enter') { e.preventDefault(); add(); }
          }}
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

// ── Step components ────────────────────────────────────────────────────────

function Step1({
  data,
  onChange,
}: {
  data: Record<string, unknown>;
  onChange: (d: Record<string, unknown>) => void;
}) {
  const set = (key: string, val: unknown) => onChange({ ...data, [key]: val });
  return (
    <div className="space-y-5">
      <div className="space-y-1.5">
        <Label>Company name</Label>
        <Input
          placeholder="Acme Inc."
          value={(data.name as string) ?? ''}
          onChange={(e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => set('name', e.target.value)}
        />
      </div>
      <div className="space-y-1.5">
        <Label>Website</Label>
        <Input
          placeholder="https://acme.com"
          value={(data.website as string) ?? ''}
          onChange={(e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => set('website', e.target.value)}
        />
      </div>
      <div className="space-y-1.5">
        <Label>Target regions or languages</Label>
        <Input
          placeholder="e.g. United States, English"
          value={(data.targetRegions as string) ?? ''}
          onChange={(e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => set('targetRegions', e.target.value)}
        />
        <p className="text-xs text-muted-foreground">Primary markets your business targets</p>
      </div>
      <div className="space-y-1.5">
        <Label>Business description</Label>
        <Textarea
          placeholder="What does your company do in 2–3 sentences?"
          value={(data.description as string) ?? ''}
          onChange={(e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => set('description', e.target.value)}
          rows={3}
        />
      </div>
    </div>
  );
}

function Step2({
  data,
  onChange,
}: {
  data: Record<string, unknown>;
  onChange: (d: Record<string, unknown>) => void;
}) {
  const set = (key: string, val: unknown) => onChange({ ...data, [key]: val });
  return (
    <div className="space-y-5">
      <div className="space-y-1.5">
        <Label>What the business sells</Label>
        <Textarea
          placeholder="Describe your main product or service offering"
          value={(data.whatItSells as string) ?? ''}
          onChange={(e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => set('whatItSells', e.target.value)}
          rows={3}
        />
      </div>
      <div className="space-y-1.5">
        <Label>Key features and benefits</Label>
        <Textarea
          placeholder="List the main features and what they mean for customers"
          value={(data.keyFeatures as string) ?? ''}
          onChange={(e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => set('keyFeatures', e.target.value)}
          rows={4}
        />
      </div>
      <div className="space-y-1.5">
        <Label>Product tiers and inclusions</Label>
        <Textarea
          placeholder="Describe your pricing tiers or plan inclusions (or write 'Not applicable')"
          value={(data.pricingTiers as string) ?? ''}
          onChange={(e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => set('pricingTiers', e.target.value)}
          rows={2}
        />
      </div>
      <div className="grid grid-cols-2 gap-4">
        <div className="space-y-1.5">
          <Label>Free trial or demo?</Label>
          <Input
            placeholder="e.g. 14-day free trial"
            value={(data.freeTrialAvailable as string) ?? ''}
            onChange={(e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => set('freeTrialAvailable', e.target.value)}
          />
        </div>
        <div className="space-y-1.5">
          <Label>Avg. lifetime value per client</Label>
          <Input
            placeholder="e.g. $2,400/year"
            value={(data.lifetimeValuePerClient as string) ?? ''}
            onChange={(e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => set('lifetimeValuePerClient', e.target.value)}
          />
        </div>
      </div>
    </div>
  );
}

function Step3({
  data,
  onChange,
}: {
  data: Record<string, unknown>;
  onChange: (d: Record<string, unknown>) => void;
}) {
  const set = (key: string, val: unknown) => onChange({ ...data, [key]: val });
  return (
    <div className="space-y-5">
      <div className="space-y-1.5">
        <Label>Customer segments</Label>
        <p className="text-xs text-muted-foreground">List the primary groups you serve</p>
        <TagInput
          value={(data.segments as string[]) ?? []}
          onChange={v => set('segments', v)}
          placeholder="e.g. Marketing leaders, SMB founders"
        />
      </div>
      <div className="space-y-1.5">
        <Label>Customer pain points</Label>
        <Textarea
          placeholder="What problems do your customers face that you solve?"
          value={(data.painPoints as string) ?? ''}
          onChange={(e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => set('painPoints', e.target.value)}
          rows={4}
        />
      </div>
      <div className="space-y-1.5">
        <Label>Keywords they talk about</Label>
        <Textarea
          placeholder="Words and phrases your customers use when searching or talking about this problem"
          value={(data.keywordsTheyUse as string) ?? ''}
          onChange={(e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => set('keywordsTheyUse', e.target.value)}
          rows={3}
        />
      </div>
      <div className="space-y-1.5">
        <Label>Top use cases to rank for</Label>
        <Textarea
          placeholder="What jobs do customers hire you for? What tasks do they complete with your product?"
          value={(data.topUseCases as string) ?? ''}
          onChange={(e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => set('topUseCases', e.target.value)}
          rows={3}
        />
      </div>
    </div>
  );
}

function Step4({
  data,
  onChange,
}: {
  data: Record<string, unknown>;
  onChange: (d: Record<string, unknown>) => void;
}) {
  const set = (key: string, val: unknown) => onChange({ ...data, [key]: val });
  return (
    <div className="space-y-5">
      <div className="space-y-1.5">
        <Label>Main competitors</Label>
        <p className="text-xs text-muted-foreground">List 3–7 competitors with links where possible</p>
        <TagInput
          value={(data.mainCompetitors as string[]) ?? []}
          onChange={v => set('mainCompetitors', v)}
          placeholder="Enter competitor name or URL"
        />
      </div>
      <div className="space-y-1.5">
        <Label>Differentiation</Label>
        <Textarea
          placeholder="How do you differ from those competitors?"
          value={(data.differentiation as string) ?? ''}
          onChange={(e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => set('differentiation', e.target.value)}
          rows={3}
        />
      </div>
      <div className="space-y-1.5">
        <Label>Unique strengths</Label>
        <Textarea
          placeholder="What can only you claim? Speed, price, niche expertise, integrations…"
          value={(data.uniqueStrengths as string) ?? ''}
          onChange={(e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => set('uniqueStrengths', e.target.value)}
          rows={3}
        />
      </div>
      <div className="space-y-1.5">
        <Label>Trade-offs you accept</Label>
        <Textarea
          placeholder="What do you deliberately not do or not be best at?"
          value={(data.tradeOffs as string) ?? ''}
          onChange={(e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => set('tradeOffs', e.target.value)}
          rows={2}
        />
      </div>
      <div className="space-y-1.5">
        <Label>Proof</Label>
        <Textarea
          placeholder="Claims you can back up — customer count, years in business, certifications, etc."
          value={(data.proof as string) ?? ''}
          onChange={(e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => set('proof', e.target.value)}
          rows={2}
        />
      </div>
    </div>
  );
}

function Step5({
  data,
  onChange,
}: {
  data: Record<string, unknown>;
  onChange: (d: Record<string, unknown>) => void;
}) {
  const set = (key: string, val: unknown) => onChange({ ...data, [key]: val });
  return (
    <div className="space-y-5">
      <div className="space-y-1.5">
        <Label>Case studies</Label>
        <Textarea
          placeholder="Named client results, before/after metrics, success stories"
          value={(data.caseStudies as string) ?? ''}
          onChange={(e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => set('caseStudies', e.target.value)}
          rows={3}
        />
      </div>
      <div className="space-y-1.5">
        <Label>Organic discussions</Label>
        <Textarea
          placeholder="Reddit threads, forum posts, Google reviews, news mentions about you"
          value={(data.organicDiscussions as string) ?? ''}
          onChange={(e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => set('organicDiscussions', e.target.value)}
          rows={3}
        />
      </div>
      <div className="space-y-1.5">
        <Label>Social media presence</Label>
        <Textarea
          placeholder="Active platforms, follower counts, engagement level"
          value={(data.socialMediaPresence as string) ?? ''}
          onChange={(e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => set('socialMediaPresence', e.target.value)}
          rows={3}
        />
      </div>
    </div>
  );
}

// ── Step titles ────────────────────────────────────────────────────────────

const STEP_META = {
  1: { title: 'Company details',            subtitle: 'Confirm your company basics and target regions or languages' },
  2: { title: 'Product & pricing',          subtitle: 'Capture what you sell, how it works, and how it\'s priced' },
  3: { title: 'Target customers',           subtitle: 'Describe your audience and the queries they care about' },
  4: { title: 'Competitors & differentiation', subtitle: 'Share your competitive landscape and how you win' },
  5: { title: 'Social proof & trust',       subtitle: 'Add proof points and public signals that build credibility' },
} as const;

// ── Main page ──────────────────────────────────────────────────────────────

export default function OnboardingPage() {
  const params    = useParams();
  const router    = useRouter();
  const projectId = params.projectId as string;

  const { data: businessContextData, isLoading: isLoadingContext } = useBusinessContext(projectId);
  const saveStep    = useSaveOnboardingStep(projectId);
  const startPipeline = useStartPipeline(projectId);

  const [currentStep, setCurrentStep] = useState<1 | 2 | 3 | 4 | 5>(1);
  const [stepData, setStepData] = useState<Record<number, Record<string, unknown>>>({
    1: {}, 2: {}, 3: {}, 4: {}, 5: {},
  });

  // Pre-fill from existing BusinessContext (edit mode)
  useEffect(() => {
    if (!businessContextData) return;
    const bc = businessContextData;
    setStepData({
      1: (bc.company   as Record<string, unknown>) ?? {},
      2: (bc.product   as Record<string, unknown>) ?? {},
      3: (bc.customers as Record<string, unknown>) ?? {},
      4: (bc.competition as Record<string, unknown>) ?? {},
      5: (bc.socialProof as Record<string, unknown>) ?? {},
    });
    // Jump to first incomplete step
    const completed = bc.completedSteps ?? [];
    const firstIncomplete = ([1, 2, 3, 4, 5] as const).find(s => !completed.includes(s));
    if (firstIncomplete) setCurrentStep(firstIncomplete);
  }, [businessContextData]);

  const handleContinue = async () => {
    await saveStep.mutateAsync({
      step: currentStep,
      data: stepData[currentStep],
    });

    if (currentStep < 5) {
      setCurrentStep((currentStep + 1) as 1 | 2 | 3 | 4 | 5);
    }
  };

  const handleComplete = async () => {
    // Save step 5 first
    await saveStep.mutateAsync({
      step: 5,
      data: stepData[5],
    });
    // Then start pipeline
    await startPipeline.mutateAsync();
    router.push(`/projects/${projectId}/overview`);
  };

  const handleBack = () => {
    if (currentStep > 1) setCurrentStep((currentStep - 1) as 1 | 2 | 3 | 4 | 5);
  };

  const meta      = STEP_META[currentStep];
  const isSaving  = saveStep.isPending;
  const isLast    = currentStep === 5;
  const error     = saveStep.error ?? startPipeline.error;

  if (isLoadingContext) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-background">
      {/* Step progress bar */}
      <div className="border-b border-border">
        <div className="max-w-2xl mx-auto px-6 py-4">
          <div className="flex items-center gap-0">
            {STEPS.map((step, i) => {
              const isActive    = step.number === currentStep;
              const isCompleted = step.number < currentStep;
              return (
                <div key={step.number} className="flex items-center gap-0">
                  <div className="flex items-center gap-2">
                    <div
                      className={cn(
                        'w-6 h-6 rounded-full flex items-center justify-center text-xs font-medium transition-colors',
                        isActive    && 'bg-foreground text-background',
                        isCompleted && 'bg-foreground text-background',
                        !isActive && !isCompleted && 'border border-border text-muted-foreground',
                      )}
                    >
                      {step.number}
                    </div>
                    <span
                      className={cn(
                        'text-sm transition-colors',
                        isActive    && 'text-foreground font-medium',
                        isCompleted && 'text-foreground',
                        !isActive && !isCompleted && 'text-muted-foreground',
                      )}
                    >
                      {step.label}
                    </span>
                  </div>
                  {i < STEPS.length - 1 && (
                    <div className="w-8 h-px bg-border mx-3" />
                  )}
                </div>
              );
            })}
          </div>
        </div>
      </div>

      {/* Form area */}
      <div className="max-w-2xl mx-auto px-6 py-10">
        <div className="mb-8 text-center">
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

          {currentStep === 1 && (
            <Step1
              data={stepData[1]}
              onChange={d => setStepData(prev => ({ ...prev, 1: d }))}
            />
          )}
          {currentStep === 2 && (
            <Step2
              data={stepData[2]}
              onChange={d => setStepData(prev => ({ ...prev, 2: d }))}
            />
          )}
          {currentStep === 3 && (
            <Step3
              data={stepData[3]}
              onChange={d => setStepData(prev => ({ ...prev, 3: d }))}
            />
          )}
          {currentStep === 4 && (
            <Step4
              data={stepData[4]}
              onChange={d => setStepData(prev => ({ ...prev, 4: d }))}
            />
          )}
          {currentStep === 5 && (
            <Step5
              data={stepData[5]}
              onChange={d => setStepData(prev => ({ ...prev, 5: d }))}
            />
          )}

          {/* Nav buttons */}
          <div className="flex items-center justify-between pt-2">
            <Button
              type="button"
              variant="outline"
              onClick={handleBack}
              disabled={currentStep === 1 || isSaving}
            >
              Back
            </Button>

            {isLast ? (
              <Button
                type="button"
                onClick={handleComplete}
                disabled={isSaving || startPipeline.isPending}
              >
                {(isSaving || startPipeline.isPending) ? (
                  <><Loader2 className="h-4 w-4 mr-2 animate-spin" />Starting…</>
                ) : (
                  'Complete & start pipeline'
                )}
              </Button>
            ) : (
              <Button
                type="button"
                onClick={handleContinue}
                disabled={isSaving}
              >
                {isSaving ? (
                  <><Loader2 className="h-4 w-4 mr-2 animate-spin" />Saving…</>
                ) : (
                  'Continue'
                )}
              </Button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
