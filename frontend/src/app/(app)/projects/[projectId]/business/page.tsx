'use client';

import { use, useState } from 'react';
import { useBusinessContext, useSaveBusinessSection } from '@/lib/hooks';
import { Skeleton } from '@/components/ui/skeleton';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';

// ── Small helpers ─────────────────────────────────────────────────────────

function Field({
  label,
  value,
  onChange,
  multiline = false,
  placeholder = '',
}: {
  label:        string;
  value:        string;
  onChange:     (v: string) => void;
  multiline?:   boolean;
  placeholder?: string;
}) {
  return (
    <div className="space-y-1.5">
      <Label className="text-xs text-muted-foreground uppercase tracking-wide">{label}</Label>
      {multiline ? (
        <Textarea
          value={value}
          onChange={e => onChange(e.target.value)}
          placeholder={placeholder}
          className="text-sm resize-none min-h-20"
        />
      ) : (
        <Input
          value={value}
          onChange={e => onChange(e.target.value)}
          placeholder={placeholder}
          className="text-sm"
        />
      )}
    </div>
  );
}

function Section({
  title,
  note,
  children,
  onSave,
  saving,
  saved,
}: {
  title:    string;
  note?:    string;
  children: React.ReactNode;
  onSave:   () => void;
  saving:   boolean;
  saved:    boolean;
}) {
  return (
    <div className="border border-border rounded-lg p-6 space-y-4">
      <div className="flex items-start justify-between gap-4">
        <div>
          <p className="text-sm font-medium">{title}</p>
          {note && <p className="text-xs text-muted-foreground mt-0.5">{note}</p>}
        </div>
        <div className="flex items-center gap-2 shrink-0">
          {saved && <span className="text-xs text-green-500">Saved</span>}
          <Button size="sm" variant="outline" onClick={onSave} disabled={saving}>
            {saving ? 'Saving…' : 'Save'}
          </Button>
        </div>
      </div>
      <div className="space-y-3">{children}</div>
    </div>
  );
}

// ── Page ──────────────────────────────────────────────────────────────────

export default function BusinessPage({
  params,
}: {
  params: Promise<{ projectId: string }>;
}) {
  const { projectId } = use(params);
  const { data: bc, isLoading } = useBusinessContext(projectId);
  const save = useSaveBusinessSection(projectId);

  // Track which section was last saved for "Saved" confirmation
  const [lastSaved, setLastSaved] = useState<number | null>(null);

  // ── Step 1: Company ───────────────────────────────────────────────────
  const [companyName,    setCompanyName]    = useState('');
  const [website,        setWebsite]        = useState('');
  const [description,    setDescription]    = useState('');
  const [targetRegions,  setTargetRegions]  = useState('');

  // ── Step 2: Product ───────────────────────────────────────────────────
  const [whatItSells,    setWhatItSells]    = useState('');
  const [keyFeatures,    setKeyFeatures]    = useState('');
  const [pricingTiers,   setPricingTiers]   = useState('');

  // ── Step 3: Customers ─────────────────────────────────────────────────
  const [segments,       setSegments]       = useState('');
  const [painPoints,     setPainPoints]     = useState('');
  const [keywords,       setKeywords]       = useState('');
  const [topUseCases,    setTopUseCases]    = useState('');

  // ── Step 4: Competition ───────────────────────────────────────────────
  const [competitors,    setCompetitors]    = useState('');
  const [differentiation,setDifferentiation]= useState('');
  const [strengths,      setStrengths]      = useState('');
  const [tradeOffs,      setTradeOffs]      = useState('');

  // ── Step 5: Social proof ──────────────────────────────────────────────
  const [caseStudies,    setCaseStudies]    = useState('');
  const [discussions,    setDiscussions]    = useState('');
  const [socialMedia,    setSocialMedia]    = useState('');

  // Populate local state once data loads — only on first load
  const [initialized, setInitialized] = useState(false);
  if (bc && !initialized) {
    setInitialized(true);
    setCompanyName(bc.company?.name ?? '');
    setWebsite(bc.company?.website ?? '');
    setDescription(bc.company?.description ?? '');
    // Defensive: targetRegions should be a string[], but company is stored
    // as Schema.Types.Mixed on the backend (no schema-level cast), so a
    // legacy/corrupted record — or a bug in another writer — could hand us
    // a string instead. Array.isArray guards against the
    // "targetRegions.join is not a function" crash regardless of what's
    // actually in the DB.
    const rawTargetRegions = bc.company?.targetRegions;
    setTargetRegions((Array.isArray(rawTargetRegions) ? rawTargetRegions : []).join(', '));
    setWhatItSells(bc.product?.whatItSells ?? '');
    setKeyFeatures(bc.product?.keyFeatures ?? '');
    setPricingTiers(bc.product?.pricingTiers ?? '');
    setSegments((bc.customers?.segments ?? []).join('\n'));
    setPainPoints(bc.customers?.painPoints ?? '');
    setKeywords(bc.customers?.keywordsTheyUse ?? '');
    setTopUseCases(bc.customers?.topUseCases ?? '');
    // Stored competitors are structured entries ({ domain, verified, … }), not
    // strings — show the domain. (join() on the objects printed "[object Object]".)
    setCompetitors(
      (bc.competition?.mainCompetitors ?? [])
        .map(entry => (typeof entry === 'string' ? entry : entry?.domain ?? ''))
        .filter(Boolean)
        .join('\n'),
    );
    setDifferentiation(bc.competition?.differentiation ?? '');
    setStrengths(bc.competition?.uniqueStrengths ?? '');
    setTradeOffs(bc.competition?.tradeOffs ?? '');
    setCaseStudies(bc.socialProof?.caseStudies ?? '');
    setDiscussions(bc.socialProof?.organicDiscussions ?? '');
    setSocialMedia(bc.socialProof?.socialMediaPresence ?? '');
  }

  // Each section is saved on its own through the Business-page endpoint, which
  // writes only the fields sent. (These used to go to the onboarding-wizard
  // endpoint, whose steps mean something different — saves landed in the wrong
  // place or wiped neighbouring data.)
  const SECTION_BY_STEP = ['company', 'product', 'customers', 'competition', 'socialProof'] as const;

  function doSave(step: 1 | 2 | 3 | 4 | 5, data: Record<string, unknown>) {
    save.mutate(
      { section: SECTION_BY_STEP[step - 1], data },
      {
        onSuccess: () => {
          setLastSaved(step);
          setTimeout(() => setLastSaved(null), 2500);
        },
      },
    );
  }

  if (isLoading) {
    return (
      <div className="p-8 max-w-2xl mx-auto space-y-4">
        <Skeleton className="h-8 w-48" />
        {[1, 2, 3, 4, 5].map(i => <Skeleton key={i} className="h-48 w-full" />)}
      </div>
    );
  }

  return (
    <div className="p-8 max-w-2xl mx-auto space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">Business profile</h1>
        <p className="text-sm text-muted-foreground mt-1">
          This data is read by the AI on every blog generation and keyword research call. Keep it accurate.
        </p>
      </div>

      {/* Step 1 — Company */}
      <Section
        title="Company"
        note="Basic identity — who you are and where you operate"
        onSave={() =>
          doSave(1, {
            name:          companyName,
            website,
            description,
            targetRegions: targetRegions.split(',').map(s => s.trim()).filter(Boolean),
          })
        }
        saving={save.isPending && lastSaved === null}
        saved={lastSaved === 1}
      >
        <Field label="Company name"   value={companyName}   onChange={setCompanyName}   placeholder="Javaria Agency" />
        <Field label="Website"        value={website}        onChange={setWebsite}        placeholder="https://javaria-agency.in" />
        <Field label="Description"    value={description}    onChange={setDescription}    placeholder="What the business does in 2–3 sentences" multiline />
        <Field label="Target regions" value={targetRegions}  onChange={setTargetRegions}  placeholder="Udaipur, Rajasthan, India — comma separated" />
      </Section>

      {/* Step 2 — Product */}
      <Section
        title="Product"
        note="What you sell, how it's priced, and what makes it valuable"
        onSave={() =>
          doSave(2, {
            whatItSells:  whatItSells,
            keyFeatures:  keyFeatures,
            pricingTiers: pricingTiers,
          })
        }
        saving={save.isPending && lastSaved === null}
        saved={lastSaved === 2}
      >
        <Field label="What it sells"  value={whatItSells}  onChange={setWhatItSells}  placeholder="One sentence describing the core product or service" />
        <Field label="Key features"   value={keyFeatures}  onChange={setKeyFeatures}  placeholder="One feature per line" multiline />
        <Field label="Pricing tiers"  value={pricingTiers} onChange={setPricingTiers} placeholder="Free: basic. Pro: ₹999/mo full access." multiline />
      </Section>

      {/* Step 3 — Customers */}
      <Section
        title="Customers"
        note="Who buys from you, what problems they have, and how they search"
        onSave={() =>
          doSave(3, {
            segments:       segments.split('\n').map(s => s.trim()).filter(Boolean),
            painPoints,
            keywordsTheyUse: keywords,
            topUseCases,
          })
        }
        saving={save.isPending && lastSaved === null}
        saved={lastSaved === 3}
      >
        <Field label="Customer segments"    value={segments}    onChange={setSegments}    placeholder="One segment per line e.g. Households\nSmall businesses\nHotels" multiline />
        <Field label="Pain points"          value={painPoints}  onChange={setPainPoints}  placeholder="What problems do they have before finding you?" multiline />
        <Field label="Keywords they search" value={keywords}    onChange={setKeywords}    placeholder="cleaning products below MRP, personal care wholesale" multiline />
        <Field label="Top use cases"        value={topUseCases} onChange={setTopUseCases} placeholder="Buy cleaning supplies in bulk, find genuine products under MRP" multiline />
      </Section>

      {/* Step 4 — Competition */}
      <Section
        title="Competition"
        note="Who you compete with and why customers choose you"
        onSave={() =>
          doSave(4, {
            mainCompetitors: competitors.split('\n').map(s => s.trim()).filter(Boolean),
            differentiation,
            uniqueStrengths: strengths,
            tradeOffs,
          })
        }
        saving={save.isPending && lastSaved === null}
        saved={lastSaved === 4}
      >
        <Field label="Competitors"      value={competitors}     onChange={setCompetitors}     placeholder="One domain per line e.g. bigbasket.com\njiomart.com" multiline />
        <Field label="Differentiation"  value={differentiation} onChange={setDifferentiation} placeholder="What makes you different from these competitors?" multiline />
        <Field label="Unique strengths" value={strengths}       onChange={setStrengths}       placeholder="What are you genuinely better at?" multiline />
        <Field label="Trade-offs"       value={tradeOffs}       onChange={setTradeOffs}       placeholder="What do you not do or do worse than competitors?" multiline />
      </Section>

      {/* Step 5 — Social proof */}
      <Section
        title="Social proof"
        note="Evidence that builds trust — used to make blogs more credible"
        onSave={() =>
          doSave(5, {
            caseStudies:         caseStudies,
            organicDiscussions:  discussions,
            socialMediaPresence: socialMedia,
          })
        }
        saving={save.isPending && lastSaved === null}
        saved={lastSaved === 5}
      >
        <Field label="Case studies"        value={caseStudies}  onChange={setCaseStudies}  placeholder="Customer results, testimonials, success stories" multiline />
        <Field label="Organic discussions" value={discussions}  onChange={setDiscussions}  placeholder="Reddit threads, reviews, forums mentioning you" multiline />
        <Field label="Social media"        value={socialMedia}  onChange={setSocialMedia}  placeholder="Instagram, Facebook, WhatsApp Business — where are you active?" />
      </Section>
    </div>
  );
}
