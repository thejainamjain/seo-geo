'use client';

// app/(app)/projects/[projectId]/settings/page.tsx
//
// The Settings dashboard shell. Previously this route held the CMS-connect
// wizard directly (now moved to settings/integrations, since it also
// covers GSC + Knowledge Files, not just CMS — see that file's header).
// This page is the landing page: an overview of what's configured, with
// toggles for the things that don't need a dedicated flow, and links out
// to sub-pages for the things that do.

import { use } from 'react';
import Link from 'next/link';
import {
  useProject, useBusinessContext, useCmsConfig, useUpdateCms,
  useUpdateProjectSettings, usePoolImages,
} from '@/lib/hooks';
import { ImageConfigDialog } from '@/components/settings/image-config-dialog';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Switch } from '@/components/ui/switch';
import { Skeleton } from '@/components/ui/skeleton';
import { CheckCircle2, ExternalLink, Globe, ImageIcon, Layers, Loader2 } from 'lucide-react';

const HEX6_RE = /^#[0-9A-Fa-f]{6}$/;

export default function SettingsPage({ params }: { params: Promise<{ projectId: string }> }) {
  const { projectId } = use(params);

  const { data: project, isLoading: projectLoading } = useProject(projectId);
  const { data: businessContext } = useBusinessContext(projectId);
  const { data: cmsConfig, isLoading: cmsLoading } = useCmsConfig(projectId);
  const { data: poolImages } = usePoolImages(projectId);

  const updateCms      = useUpdateCms(projectId);
  const updateSettings = useUpdateProjectSettings(projectId);

  if (projectLoading) {
    return (
      <div className="p-8 max-w-3xl space-y-4">
        <Skeleton className="h-8 w-48" />
        <Skeleton className="h-40 w-full" />
        <Skeleton className="h-40 w-full" />
      </div>
    );
  }

  if (!project) {
    return <div className="p-8"><p className="text-sm text-muted-foreground">Project not found.</p></div>;
  }

  const domain = project.domain?.replace(/^https?:\/\//, '') ?? '';
  const isCmsConnected = !!cmsConfig?.cmsType;
  const availableImages = poolImages?.filter(img => img.status === 'available').length ?? 0;
  const brandColor = project.brandColor && HEX6_RE.test(project.brandColor) ? project.brandColor : null;

  return (
    <div className="p-8 max-w-3xl space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">Settings</h1>
        <p className="text-sm text-muted-foreground mt-1">
          Manage your project configuration
        </p>
      </div>

      {/* ── Project Information ── */}
      <Card>
        <CardHeader>
          <div className="flex items-center gap-2">
            <Globe className="h-4 w-4 text-muted-foreground" />
            <CardTitle className="text-base">Project Information</CardTitle>
          </div>
          <CardDescription>Your site and how we describe your business in generated content</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="flex items-center justify-between text-sm">
            <span className="text-muted-foreground">Domain</span>
            <span className="font-medium">{domain || '—'}</span>
          </div>
          <div className="flex items-start justify-between text-sm gap-4">
            <span className="text-muted-foreground shrink-0">Business description</span>
            <span className="font-medium text-right line-clamp-2">
              {businessContext?.company?.description || 'Not set yet'}
            </span>
          </div>
          <Link
            href={`/projects/${projectId}/onboarding`}
            className="inline-flex items-center gap-1 text-xs text-primary hover:underline"
          >
            Edit business information
            <ExternalLink className="h-3 w-3" />
          </Link>
        </CardContent>
      </Card>

      {/* ── Site Integration ── */}
      <Card>
        <CardHeader>
          <div className="flex items-center gap-2">
            <Layers className="h-4 w-4 text-muted-foreground" />
            <CardTitle className="text-base">Site Integration</CardTitle>
          </div>
          <CardDescription>How blogs reach your site once they&apos;re ready</CardDescription>
        </CardHeader>
        <CardContent className="space-y-5">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              {cmsLoading ? (
                <Skeleton className="h-4 w-24" />
              ) : isCmsConnected ? (
                <>
                  <CheckCircle2 className="h-4 w-4 text-green-600" />
                  <span className="text-sm font-medium">Connected to {cmsConfig!.cmsType}</span>
                </>
              ) : (
                <>
                  <Badge variant="outline" className="text-xs">Not connected</Badge>
                </>
              )}
            </div>
            <Link
              href={`/projects/${projectId}/settings/integrations`}
              className="inline-flex items-center gap-1 text-xs text-primary hover:underline"
            >
              {isCmsConnected ? 'Manage' : 'Connect a CMS'}
              <ExternalLink className="h-3 w-3" />
            </Link>
          </div>

          <div className="h-px bg-border" />

          <div className="flex items-center justify-between gap-4">
            <div>
              <p className="text-sm font-medium">Auto Publish Blogs</p>
              <p className="text-xs text-muted-foreground mt-0.5">
                Eligible posts auto-publish on the next run (up to one per weekday) unless you unpublish them manually.
              </p>
            </div>
            <Switch
              checked={cmsConfig?.autoPublish ?? false}
              disabled={!isCmsConnected || updateCms.isPending}
              onCheckedChange={(checked) => updateCms.mutate({ autoPublish: checked })}
            />
          </div>

          <div className="flex items-center justify-between gap-4">
            <div>
              <p className="text-sm font-medium">Use default blog theme</p>
              <p className="text-xs text-muted-foreground mt-0.5">
                Applies a consistent font family, sizes, weights, and colors to h1–h3, p, and span in published posts. Works alongside your CMS&apos;s own theme.
              </p>
            </div>
            <Switch
              checked={project.useDefaultBlogTheme ?? false}
              disabled={updateSettings.isPending}
              onCheckedChange={(checked) => updateSettings.mutate({ useDefaultBlogTheme: checked })}
            />
          </div>
        </CardContent>
      </Card>

      {/* ── Images ── */}
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <ImageIcon className="h-4 w-4 text-muted-foreground" />
              <CardTitle className="text-base">Images</CardTitle>
            </div>
            <ImageConfigDialog projectId={projectId} />
          </div>
          <CardDescription>What gets used as a blog&apos;s hero image, and in what order</CardDescription>
        </CardHeader>
        <CardContent className="space-y-2 text-sm">
          <div className="flex items-center justify-between">
            <span className="text-muted-foreground">Your uploaded images</span>
            <span className="font-medium">{availableImages} available</span>
          </div>
          <div className="flex items-center justify-between">
            <span className="text-muted-foreground">Fallback when uploads run out</span>
            <span className="font-medium">
              {project.heroImageFallbackMode === 'text_card' ? 'Text-based images' : 'Stock images (Unsplash)'}
            </span>
          </div>
          <div className="flex items-center justify-between">
            <span className="text-muted-foreground">Brand color</span>
            {brandColor ? (
              <span className="flex items-center gap-1.5 font-medium">
                <span className="h-3.5 w-3.5 rounded-full border border-border" style={{ backgroundColor: brandColor }} />
                {brandColor}
              </span>
            ) : (
              <span className="text-muted-foreground">Not set</span>
            )}
          </div>
        </CardContent>
      </Card>

      {/*
        PLAN / PROJECT MEMBERS — deferred.
        No billing/Stripe integration, no OrganizationInvite UI, no
        entitlement checks anywhere in the app yet (see Project model and
        sidebar.tsx for the matching deferral notes). This section is
        commented out rather than shown half-built. When billing exists,
        this is where a Plan card (current tier, upgrade CTA) and a
        Project Members card (list + invite-by-email, backed by the
        existing OrganizationInvite model) belong.

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Plan</CardTitle>
        </CardHeader>
        <CardContent>...</CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Project Members</CardTitle>
        </CardHeader>
        <CardContent>...</CardContent>
      </Card>
      */}

      {updateSettings.isError && (
        <p className="text-xs text-destructive">Couldn&apos;t save that change — try again.</p>
      )}
      {updateCms.isPending && (
        <p className="text-xs text-muted-foreground flex items-center gap-1.5">
          <Loader2 className="h-3 w-3 animate-spin" /> Saving…
        </p>
      )}
    </div>
  );
}
