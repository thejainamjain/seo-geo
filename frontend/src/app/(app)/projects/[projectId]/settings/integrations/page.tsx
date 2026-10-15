'use client';

import { use, useState } from 'react';
import Link from 'next/link';
import { useProject } from '@/lib/hooks';
import { useCmsConfig, useConnectCms, useDisconnectCms } from '@/lib/hooks';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import {
  CheckCircle2,
  Circle,
  ExternalLink,
  ArrowLeft,
  Loader2,
  BookOpen,
  Unplug,
} from 'lucide-react';
import type { CmsConnectPayload } from '@/types/api';
import { gscApi } from '@/lib/api';

// ── Platform registry ─────────────────────────────────────────────────────────

type CmsPlatformId =
  | 'wordpress'
  | 'webflow'
  | 'shopify'
  | 'wix'
  // | 'framer'
  | 'sanity'
  | 'squarespace'
  | 'gohighlevel';

const CMS_PLATFORMS: { id: CmsPlatformId; label: string; desc: string }[] = [
  { id: 'wordpress',   label: 'WordPress',   desc: 'Connect via Application Password' },
  { id: 'webflow',     label: 'Webflow',     desc: 'Connect via API token' },
  { id: 'shopify',     label: 'Shopify',     desc: 'Connect via app credentials' },
 // { id: 'framer',      label: 'Framer',      desc: 'Connect via plugin' },
  { id: 'wix',         label: 'Wix',         desc: 'Connect via API key' },
  { id: 'sanity',      label: 'Sanity',      desc: 'Connect via project ID + token' },
  { id: 'squarespace', label: 'Squarespace', desc: 'Connect via dashboard URL' },
  { id: 'gohighlevel', label: 'GoHighLevel', desc: 'Connect via private integration token' },
];

// ── Shared step UI primitives ─────────────────────────────────────────────────

function StepNumber({ n, done }: { n: number; done?: boolean }) {
  return (
    <div
      className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-full border text-xs font-semibold
        ${done
          ? 'border-primary bg-primary text-primary-foreground'
          : 'border-border text-muted-foreground'}`}
    >
      {done ? <CheckCircle2 className="h-3.5 w-3.5" /> : n}
    </div>
  );
}

function StepBlock({
  n, title, children, done,
}: {
  n: number; title: string; children: React.ReactNode; done?: boolean;
}) {
  return (
    <div className="flex gap-4">
      <div className="flex flex-col items-center">
        <StepNumber n={n} done={done} />
        <div className="mt-1 w-px flex-1 bg-border" />
      </div>
      <div className="pb-8 flex-1">
        <p className="text-sm font-semibold mb-2">{title}</p>
        {children}
      </div>
    </div>
  );
}

function InstructionList({ items }: { items: string[] }) {
  return (
    <ul className="space-y-1 mb-3">
      {items.map((item, i) => (
        <li key={i} className="flex gap-2 text-sm text-muted-foreground">
          <span className="mt-1 shrink-0">—</span>
          <span>{item}</span>
        </li>
      ))}
    </ul>
  );
}

function FormField({
  label, id, placeholder, type = 'text', value, onChange,
}: {
  label: string; id: string; placeholder: string;
  type?: string; value: string; onChange: (v: string) => void;
}) {
  return (
    <div className="space-y-1.5">
      <Label htmlFor={id} className="text-sm">{label}</Label>
      <Input
        id={id}
        type={type}
        placeholder={placeholder}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="font-mono text-sm"
      />
    </div>
  );
}

function PreviewUrl({ base, path }: { base: string; path: string }) {
  const clean = path.replace(/^\//, '');
  if (!clean) return null;
  return (
    <p className="mt-1.5 text-xs text-muted-foreground font-mono bg-muted px-2 py-1 rounded">
      Preview: https://{base}/{clean}/your-post-slug
    </p>
  );
}

// ── Platform-specific connect forms ──────────────────────────────────────────

type FormProps = {
  onConnect: (payload: Omit<CmsConnectPayload, 'cmsType'>) => void;
  isPending: boolean;
  error: string | null;
};

function WordPressForm({ domain, onConnect, isPending, error }: FormProps & { domain: string }) {
  const [siteUrl,  setSiteUrl]  = useState(domain.startsWith('http') ? domain : `https://${domain}`);
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');

  return (
    <>
      <StepBlock n={1} title="Enter Site URL">
        <FormField label="Site URL" id="wp-url" placeholder="https://yoursite.com"
          value={siteUrl} onChange={setSiteUrl} />
      </StepBlock>

      <StepBlock n={2} title="Get Application Password">
        <InstructionList items={[
          `Go to your WordPress admin profile at ${siteUrl}/wp-admin/profile.php`,
          'Copy your username and paste it below',
          'Locate the Application Password section and create a new application password',
          'Copy the generated application password and paste it below',
        ]} />
        <div className="rounded-md border border-border bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
          Note: some security plugins turn application passwords off by default.
        </div>
      </StepBlock>

      <StepBlock n={3} title="Connect Credentials" done>
        <p className="text-sm text-muted-foreground mb-3">
          Enter your WordPress username and application password
        </p>
        <div className="space-y-3">
          <FormField label="Username" id="wp-user" placeholder="WordPress username"
            value={username} onChange={setUsername} />
          <FormField label="Application Password" id="wp-pass" placeholder="Application password"
            type="password" value={password} onChange={setPassword} />
        </div>
        {error && <p className="mt-2 text-xs text-destructive">{error}</p>}
        <Button
          className="mt-4 w-full"
          onClick={() => onConnect({ credentials: { siteUrl, username, applicationPassword: password } })}
          disabled={isPending || !siteUrl || !username || !password}
        >
          {isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
          Connect
        </Button>
      </StepBlock>
    </>
  );
}

function WebflowForm({ onConnect, isPending, error }: FormProps) {
  const [apiToken,      setApiToken]      = useState('');
  const [collectionId,  setCollectionId]  = useState('');

  return (
    <>
      <StepBlock n={1} title="Access Project Settings">
        <InstructionList items={[
          'Open your Webflow dashboard and select the project',
          'Click Project Settings in the sidebar',
          'Navigate to Apps & Integrations',
          'Locate the API access section',
        ]} />
      </StepBlock>

      <StepBlock n={2} title="Generate API Token">
        <p className="text-sm text-muted-foreground mb-2">
          Click &quot;Generate token&quot; or &quot;Create new token&quot;
        </p>
        <div className="rounded-md border border-border bg-muted/40 p-3 text-xs space-y-1 mb-3">
          <p className="font-semibold text-foreground mb-1">Required permissions</p>
          <p className="text-muted-foreground">CMS: Read and write</p>
          <p className="text-muted-foreground">Pages: Read-only</p>
          <p className="text-muted-foreground">Site: Read-only</p>
        </div>
        <div className="rounded-md border border-border bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
          Copy the token immediately — you won&apos;t be able to view it again.
        </div>
      </StepBlock>

      <StepBlock n={3} title="Get Collection ID">
        <InstructionList items={[
          'In your Webflow project, go to CMS → Collections',
          'Open the blog posts collection',
          'The Collection ID is in the URL: webflow.com/design/...#/collections/{collectionId}',
        ]} />
        <FormField label="Collection ID" id="wf-col" placeholder="Webflow CMS Collection ID"
          value={collectionId} onChange={setCollectionId} />
      </StepBlock>

      <StepBlock n={4} title="Connect Token" done>
        <p className="text-sm text-muted-foreground mb-3">
          Paste your API token below to complete the connection
        </p>
        <FormField label="API Site Token" id="wf-token" placeholder="Paste token here"
          type="password" value={apiToken} onChange={setApiToken} />
        {error && <p className="mt-2 text-xs text-destructive">{error}</p>}
        <Button
          className="mt-4 w-full"
          onClick={() => onConnect({ credentials: { apiToken, collectionId } })}
          disabled={isPending || !apiToken || !collectionId}
        >
          {isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
          Connect
        </Button>
      </StepBlock>
    </>
  );
}

function ShopifyForm({ onConnect, isPending, error }: FormProps) {
  const [storeName,    setStoreName]    = useState('');
  const [accessToken,  setAccessToken]  = useState('');

  return (
    <>
      <StepBlock n={1} title="Get Store Name">
        <InstructionList items={[
          'Your store name is the subdomain before .myshopify.com',
          'e.g. mystore.myshopify.com → enter mystore',
        ]} />
        <FormField label="Store Name" id="sh-store" placeholder="mystore"
          value={storeName} onChange={setStoreName} />
      </StepBlock>

      <StepBlock n={2} title="Create Custom App">
        <InstructionList items={[
          'In Shopify Admin go to Settings → Apps and sales channels → Develop apps',
          'Click Create an app and give it a name',
          'Under Configuration, set Admin API scopes: write_content, read_content',
          'Click Save, then Install app',
          'Copy the Admin API access token — you can only view it once',
        ]} />
      </StepBlock>

      <StepBlock n={3} title="Connect" done>
        <FormField label="Admin API Access Token" id="sh-token"
          placeholder="shpat_..." type="password"
          value={accessToken} onChange={setAccessToken} />
        {error && <p className="mt-2 text-xs text-destructive">{error}</p>}
        <Button
          className="mt-4 w-full"
          onClick={() => onConnect({ credentials: { storeName, accessToken } })}
          disabled={isPending || !storeName || !accessToken}
        >
          {isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
          Connect
        </Button>
      </StepBlock>
    </>
  );
}

function WixForm({ onConnect, isPending, error }: FormProps) {
  const [apiKey, setApiKey] = useState('');
  const [siteId, setSiteId] = useState('');

  return (
    <>
      <StepBlock n={1} title="Open API Key Manager">
        <InstructionList items={[
          "Go to the author's API Key Manager",
          'Click Generate API Key',
        ]} />
      </StepBlock>

      <StepBlock n={2} title="Configure API Key Permissions">
        <InstructionList items={[
          'Give the API key a name',
          'Under All site permissions, select Wix Blog',
          'Click Generate Key',
        ]} />
      </StepBlock>

      <StepBlock n={3} title="Get Site ID">
        <InstructionList items={[
          'Go to your Wix dashboard',
          'Click on your site name — the URL contains your site ID',
          'It looks like: manage.wix.com/dashboard/{siteId}/...',
        ]} />
        <FormField label="Wix Site ID" id="wix-site" placeholder="Wix Site ID"
          value={siteId} onChange={setSiteId} />
      </StepBlock>

      <StepBlock n={4} title="Connect API Key" done>
        <FormField label="Wix API Key" id="wix-key" placeholder="Wix API Key"
          type="password" value={apiKey} onChange={setApiKey} />
        {error && <p className="mt-2 text-xs text-destructive">{error}</p>}
        <Button
          className="mt-4 w-full"
          onClick={() => onConnect({ credentials: { apiKey, siteId } })}
          disabled={isPending || !apiKey || !siteId}
        >
          {isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
          Connect
        </Button>
      </StepBlock>
    </>
  );
}

function FramerForm({ projectId, onConnect, isPending, error }: FormProps & { projectId: string }) {
  const [postPath, setPostPath] = useState('post');

  return (
    <>
      <StepBlock n={1} title="Install Plugin">
        <InstructionList items={[
          'Go to the Framer dashboard and select your project',
          'Select the CMS option from the top',
          'In the left sidebar, click Add in the Synced section and click Browse Plugins',
          'Search for this app and install the plugin',
        ]} />
      </StepBlock>

      <StepBlock n={2} title="Connect Plugin">
        <InstructionList items={[
          'Select the plugin that appears in the Synced section',
          'Add your project ID below and click Submit',
          'When you are done, go back to your project',
        ]} />
        <div className="mt-2 space-y-1">
          <p className="text-xs text-muted-foreground">Project ID</p>
          <div className="flex items-center gap-2">
            <code className="flex-1 rounded-md border border-border bg-muted px-3 py-1.5 text-sm font-mono">
              {projectId}
            </code>
            <Button
              size="sm"
              variant="outline"
              onClick={() => void navigator.clipboard.writeText(projectId)}
            >
              Copy
            </Button>
          </div>
        </div>
      </StepBlock>

      <StepBlock n={3} title="Set Post Path" done>
        <p className="text-xs text-muted-foreground mb-2">
          Customize the URL path for your blog posts. Enter blog for x.com/blog/my-post-slug. Default is post.
        </p>
        <Input
          placeholder="post"
          value={postPath}
          onChange={(e) => setPostPath(e.target.value)}
          className="font-mono text-sm"
        />
        {error && <p className="mt-2 text-xs text-destructive">{error}</p>}
        <Button
          className="mt-4 w-full"
          // Framer only requires projectId in credentials
          onClick={() => onConnect({ credentials: { projectId }, blogPostPath: postPath })}
          disabled={isPending}
        >
          {isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
          Connect
        </Button>
      </StepBlock>
    </>
  );
}

function SanityForm({ domain, onConnect, isPending, error }: FormProps & { domain: string }) {
  const [projectId,  setProjectId]  = useState('');
  const [datasetName, setDatasetName] = useState(''); // key must be datasetName to match backend
  const [apiToken,   setApiToken]   = useState('');
  const [blogPath,   setBlogPath]   = useState('blog');

  return (
    <>
      <StepBlock n={1} title="Get Project ID">
        <InstructionList items={[
          'Go to the Sanity Dashboard and open Organization Settings using Manage (top-left)',
          'Select the target project or create a new one',
          'Copy the project ID from the top',
        ]} />
        <FormField label="Sanity Project ID" id="sanity-pid" placeholder="Sanity Project ID"
          value={projectId} onChange={setProjectId} />
      </StepBlock>

      <StepBlock n={2} title="Get Dataset Name">
        <InstructionList items={[
          'Go to the Datasets tab',
          'Copy the target dataset name/title',
        ]} />
        <FormField label="Sanity Dataset Name" id="sanity-ds" placeholder="Sanity Dataset Name"
          value={datasetName} onChange={setDatasetName} />
      </StepBlock>

      <StepBlock n={3} title="Create API Token and Add CORS">
        <InstructionList items={[
          'Go to the API tab > Tokens > Add API token. Set Developer or Editor permissions and copy it',
          'In the API tab, go to CORS origins > Add CORS origin > add your app domain > Save',
        ]} />
        <div className="rounded-md border border-border bg-muted/40 px-3 py-2 text-xs text-muted-foreground mb-3">
          Blog content will be posted to the SearchPilotBlogPosts schema type.
        </div>
        <FormField label="Sanity API Access Token" id="sanity-token" placeholder="Sanity API Access Token"
          type="password" value={apiToken} onChange={setApiToken} />
      </StepBlock>

      <StepBlock n={4} title="Set Blog Post Path" done>
        <p className="text-sm text-muted-foreground mb-2">
          Specify the URL path where your blog posts will live on your website
        </p>
        <div className="space-y-1.5">
          <Label className="text-sm">Blog Post Path</Label>
          <Input
            placeholder="blog"
            value={blogPath}
            onChange={(e) => setBlogPath(e.target.value)}
            className="font-mono text-sm"
          />
          <PreviewUrl base={domain} path={blogPath} />
        </div>
        {error && <p className="mt-2 text-xs text-destructive">{error}</p>}
        <Button
          className="mt-4 w-full"
          // Key is datasetName — matches REQUIRED_CREDENTIAL_FIELDS in cms.service.ts
          onClick={() => onConnect({ credentials: { projectId, datasetName, apiToken }, blogPostPath: blogPath })}
          disabled={isPending || !projectId || !datasetName || !apiToken}
        >
          {isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
          Connect
        </Button>
      </StepBlock>
    </>
  );
}

function SquarespaceForm({ domain, onConnect, isPending, error }: FormProps & { domain: string }) {
  const [dashboardUrl, setDashboardUrl] = useState('');
  const [blogPath,     setBlogPath]     = useState('blog');

  return (
    <>
      <p className="text-sm text-muted-foreground mb-6">
        We provision a private WordPress bridge on our infrastructure, publish your posts there, and you
        import an XML export into Squarespace. Paste your Squarespace{' '}
        <span className="font-semibold text-foreground">site dashboard URL</span> (from
        account.squarespace.com — it usually looks like{' '}
        <code className="bg-muted px-1 rounded text-xs">https://yoursite.squarespace.com/config/</code>).
      </p>

      <StepBlock n={1} title="Squarespace dashboard URL">
        <p className="text-sm text-muted-foreground mb-2">
          The URL must be on *.squarespace.com.
        </p>
        <FormField label="" id="ss-url" placeholder="https://yoursite.squarespace.com/config/"
          value={dashboardUrl} onChange={setDashboardUrl} />
      </StepBlock>

      <StepBlock n={2} title="Blog post path">
        <p className="text-sm text-muted-foreground mb-2">
          URL segment where posts live (e.g.{' '}
          <code className="bg-muted px-1 rounded text-xs">blog</code> for yoursite.com/blog/post-slug).
        </p>
        <div className="space-y-1.5">
          <Label className="text-sm">Blog post path</Label>
          <Input placeholder="blog" value={blogPath}
            onChange={(e) => setBlogPath(e.target.value)} className="font-mono text-sm" />
          <PreviewUrl base={domain} path={blogPath} />
        </div>
      </StepBlock>

      <StepBlock n={3} title="Connect" done>
        <p className="text-sm text-muted-foreground mb-3">
          We create a WordPress subsite from your project domain and store the connection securely.
        </p>
        {error && <p className="mb-2 text-xs text-destructive">{error}</p>}
        <Button
          className="w-full"
          onClick={() => onConnect({ credentials: { dashboardUrl }, blogPostPath: blogPath })}
          disabled={isPending || !dashboardUrl}
        >
          {isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
          Connect
        </Button>
      </StepBlock>
    </>
  );
}

function GoHighLevelForm({ onConnect, isPending, error }: FormProps) {
  const [token,   setToken]   = useState('');
  const [blogUrl, setBlogUrl] = useState('');

  return (
    <>
      <StepBlock n={1} title="Create private integration">
        <p className="text-sm text-muted-foreground">
          In GoHighLevel, go to Settings → Private Integrations, create a new integration,
          and enable all blog-related permissions before copying the token.
        </p>
      </StepBlock>

      <StepBlock n={2} title="Paste token + blog URL" done>
        <div className="space-y-3">
          <FormField label="Private integration token" id="ghl-token"
            placeholder="Enter GoHighLevel token" type="password" value={token} onChange={setToken} />
          <FormField label="Blog dashboard URL" id="ghl-url"
            placeholder="app.gohighlevel.com/v2/location/.../blogs/site/..."
            value={blogUrl} onChange={setBlogUrl} />
        </div>
        {error && <p className="mt-2 text-xs text-destructive">{error}</p>}
        <Button
          className="mt-4 w-full"
          onClick={() => onConnect({ credentials: { privateIntegrationToken: token, blogDashboardUrl: blogUrl } })}
          disabled={isPending || !token || !blogUrl}
        >
          {isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
          Connect
        </Button>
      </StepBlock>
    </>
  );
}

// ── CMS connect view ──────────────────────────────────────────────────────────

function CmsConnectView({
  platformId, projectId, domain, onBack,
}: {
  platformId: CmsPlatformId; projectId: string; domain: string; onBack: () => void;
}) {
  const platform   = CMS_PLATFORMS.find(p => p.id === platformId)!;
  const connectMut = useConnectCms(projectId);

  const errorMsg = connectMut.error
    ? ((connectMut.error as { response?: { data?: { error?: { message?: string } } } })
        .response?.data?.error?.message ?? 'Connection failed')
    : null;

  const handleConnect = (payload: Omit<CmsConnectPayload, 'cmsType'>) => {
    connectMut.mutate(
      { cmsType: platformId, ...payload },
      { onSuccess: onBack },
    );
  };

  const formProps: FormProps = {
    onConnect: handleConnect,
    isPending: connectMut.isPending,
    error:     errorMsg,
  };

  return (
    <div>
      <button
        onClick={onBack}
        className="flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground mb-6 transition-colors"
      >
        <ArrowLeft className="h-4 w-4" />
        Back to integration selection
      </button>

      <div className="flex items-start justify-between mb-1">
        <div>
          <h2 className="text-xl font-semibold">
            Connect {platform.label} for Blog Publishing
          </h2>
          <p className="text-sm text-muted-foreground mt-0.5">
            Authenticate with your {platform.label} account to enable scheduled blog post publishing
          </p>
        </div>
        <button className="flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground shrink-0 transition-colors">
          <BookOpen className="h-3.5 w-3.5" />
          View setup guide
        </button>
      </div>

      <hr className="border-border my-5" />

      {platformId === 'wordpress'   && <WordPressForm   domain={domain}     {...formProps} />}
      {platformId === 'webflow'     && <WebflowForm                         {...formProps} />}
      {platformId === 'shopify'     && <ShopifyForm                         {...formProps} />}
      {platformId === 'wix'         && <WixForm                             {...formProps} />}
      {/*
      {platformId === 'framer'      && <FramerForm      projectId={projectId} {...formProps} />}
      */}
      {platformId === 'sanity'      && <SanityForm      domain={domain}     {...formProps} />}
      {platformId === 'squarespace' && <SquarespaceForm domain={domain}     {...formProps} />}
      {platformId === 'gohighlevel' && <GoHighLevelForm                     {...formProps} />}
    </div>
  );
}

// ── CMS grid ──────────────────────────────────────────────────────────────────

function CmsGrid({
  projectId, onSelect,
}: {
  projectId: string; onSelect: (id: CmsPlatformId) => void;
}) {
  const { data: cmsConfig, isLoading } = useCmsConfig(projectId);
  const disconnectMut = useDisconnectCms(projectId);

  const disconnectError = disconnectMut.error
    ? ((disconnectMut.error as { response?: { data?: { error?: { message?: string } } } })
        .response?.data?.error?.message ?? 'Disconnect failed')
    : null;

  if (isLoading) return <Skeleton className="h-48 w-full" />;

  // cmsType present = a CMS has been connected
  if (cmsConfig?.cmsType) {
    const platform = CMS_PLATFORMS.find(p => p.id === cmsConfig.cmsType);
    return (
      <div className="space-y-4">
        <Card>
          <CardHeader>
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <CheckCircle2 className="h-4 w-4 text-green-500" />
                <div>
                  <CardTitle className="text-sm">
                    {platform?.label ?? cmsConfig.cmsType} connected
                  </CardTitle>
                  {cmsConfig.blogPostPath && (
                    <CardDescription className="text-xs mt-0.5">
                      Blog path:{' '}
                      <code className="bg-muted px-1 rounded">{cmsConfig.blogPostPath}</code>
                    </CardDescription>
                  )}
                </div>
              </div>
              <Button
                variant="outline"
                size="sm"
                onClick={() => disconnectMut.mutate()}
                disabled={disconnectMut.isPending}
              >
                {disconnectMut.isPending
                  ? <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  : <><Unplug className="h-3.5 w-3.5 mr-1.5" />Disconnect</>
                }
              </Button>
            </div>
          </CardHeader>
        </Card>
        {disconnectError && <p className="text-xs text-destructive">{disconnectError}</p>}
        <p className="text-xs text-muted-foreground">
          To switch platforms, disconnect your current CMS first.
        </p>
      </div>
    );
  }

  // No CMS connected — show platform grid
  return (
    <div>
      <div className="mb-4 flex items-center gap-2">
        <Circle className="h-4 w-4 text-muted-foreground" />
        <span className="text-sm text-muted-foreground">No CMS connected</span>
      </div>

      <div className="grid grid-cols-2 gap-3">
        {CMS_PLATFORMS.map(platform => (
          <Card
            key={platform.id}
            className="cursor-pointer hover:border-foreground/40 transition-colors"
            onClick={() => onSelect(platform.id)}
          >
            <CardHeader className="pb-2">
              <div className="flex items-center justify-between">
                <CardTitle className="text-sm">{platform.label}</CardTitle>
                <Badge variant="outline" className="text-xs">Connect</Badge>
              </div>
              <CardDescription className="text-xs">{platform.desc}</CardDescription>
            </CardHeader>
          </Card>
        ))}
      </div>
    </div>
  );
}

// ── Main page ─────────────────────────────────────────────────────────────────

export default function IntegrationsPage({ params }: { params: Promise<{ projectId: string }> }) {
  const { projectId } = use(params);
  const { data: project, isLoading } = useProject(projectId);
  const [selectedCms, setSelectedCms] = useState<CmsPlatformId | null>(null);

  if (isLoading) return <div className="p-8"><Skeleton className="h-64 w-full" /></div>;
  if (!project)  return <div className="p-8"><p className="text-sm text-muted-foreground">Project not found.</p></div>;

  const domain = project?.domain?.replace(/^https?:\/\//, '') ?? '';

  return (
    <div className="p-8 max-w-3xl">
      <Link
        href={`/projects/${projectId}/settings`}
        className="flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground mb-6 transition-colors w-fit"
      >
        <ArrowLeft className="h-4 w-4" />
        Back to Settings
      </Link>

      <div className="mb-8">
        <h1 className="text-2xl font-semibold">Integrations</h1>
        <p className="text-sm text-muted-foreground mt-1">
          Connect your CMS and Google Search Console to enable publishing and monitoring
        </p>
      </div>

      <Tabs defaultValue="cms">
        <TabsList className="mb-6">
          <TabsTrigger value="cms">CMS</TabsTrigger>
          <TabsTrigger value="gsc">Google Search Console</TabsTrigger>
          <TabsTrigger value="knowledge">Knowledge Files</TabsTrigger>
        </TabsList>

        {/* ── CMS Tab ── */}
        <TabsContent value="cms">
          {selectedCms ? (
            <CmsConnectView
              platformId={selectedCms}
              projectId={projectId}
              domain={domain}
              onBack={() => setSelectedCms(null)}
            />
          ) : (
            <CmsGrid
              projectId={projectId}
              onSelect={setSelectedCms}
            />
          )}
        </TabsContent>

        {/* ── GSC Tab ── */}
        <TabsContent value="gsc">
          <Card>
            <CardHeader>
              <div className="flex items-center justify-between">
                <div>
                  <CardTitle className="text-base">Google Search Console</CardTitle>
                  <CardDescription className="mt-1">
                    Connect GSC to enable weekly performance monitoring, ranking tracking, and content optimization insights.
                  </CardDescription>
                </div>
                {project.isGscConnected ? (
                  <Badge variant="default" className="shrink-0">Connected</Badge>
                ) : (
                  <Badge variant="outline" className="shrink-0">Not connected</Badge>
                )}
              </div>
            </CardHeader>
            <CardContent>
              {project.isGscConnected ? (
                <div className="space-y-2">
                  <p className="text-sm text-green-500 flex items-center gap-1.5">
                    <CheckCircle2 className="h-4 w-4" />
                    GSC is connected and syncing weekly
                  </p>
                  <p className="text-xs text-muted-foreground">
                    The GSC monitor job runs every Monday at 10AM UTC. Blog learning insights are
                    generated automatically for underperforming posts.
                  </p>
                </div>
              ) : (
                <div className="space-y-3">
                  <p className="text-sm text-muted-foreground">
                    Connect your Google account to let the system read your Search Console data.
                    It only requests read access to your GSC property — nothing else.
                  </p>
                  <Button variant="outline" size="sm" asChild>
                    <a href={gscApi.getConnectUrl(projectId)}>
                      <ExternalLink className="h-3.5 w-3.5 mr-1.5" />
                      Connect Google Search Console
                    </a>
                  </Button>
                </div>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        {/* ── Knowledge Files Tab ── */}
        <TabsContent value="knowledge">
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Knowledge files</CardTitle>
              <CardDescription>
                Upload brand guidelines, pricing docs, case studies, or product sheets.
                These are injected into blog generation to match your brand voice and include accurate facts.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="border-2 border-dashed border-border rounded-lg p-8 text-center">
                <p className="text-sm font-medium">Upload documents</p>
                <p className="text-xs text-muted-foreground mt-1 mb-3">
                  PDF, Markdown, plain text, CSV, JSON · Max 10MB · Up to 25 files
                </p>
                <Button variant="outline" size="sm">
                  Choose file
                </Button>
              </div>
              <p className="text-xs text-muted-foreground">
                File upload connects to{' '}
                <code className="bg-muted px-1 rounded">POST /api/v1/projects/:id/knowledge</code>.
                Wire the upload handler to this button when your knowledge route is ready.
              </p>
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>
    </div>
  );
}
