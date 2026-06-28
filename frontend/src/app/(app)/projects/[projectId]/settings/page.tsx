'use client';

import { use } from 'react';
import { useProject } from '@/lib/hooks';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { CheckCircle2, Circle, ExternalLink } from 'lucide-react';

const CMS_PLATFORMS = [
  { id: 'wordpress',   label: 'WordPress',   desc: 'Connect via Application Password' },
  { id: 'webflow',     label: 'Webflow',     desc: 'Connect via API token' },
  { id: 'shopify',     label: 'Shopify',     desc: 'Connect via app credentials' },
  { id: 'framer',      label: 'Framer',      desc: 'Connect via plugin' },
  { id: 'wix',         label: 'Wix',         desc: 'Connect via API key' },
  { id: 'sanity',      label: 'Sanity',      desc: 'Connect via project ID + token' },
  { id: 'squarespace', label: 'Squarespace', desc: 'Connect via dashboard URL' },
  { id: 'gohighlevel', label: 'GoHighLevel', desc: 'Connect via private integration token' },
];

export default function SettingsPage({ params }: { params: Promise<{ projectId: string }> }) {
  const { projectId } = use(params);
  const { data: project, isLoading } = useProject(projectId);

  if (isLoading) return <div className="p-8"><Skeleton className="h-64 w-full" /></div>;
  if (!project)  return <div className="p-8"><p className="text-sm text-muted-foreground">Project not found.</p></div>;

  return (
    <div className="p-8 max-w-3xl">
      <div className="mb-8">
        <h1 className="text-2xl font-semibold">Settings</h1>
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

        {/* CMS Tab */}
        <TabsContent value="cms">
          <div className="mb-4 flex items-center gap-2">
            {project.isCmsConnected ? (
              <>
                <CheckCircle2 className="h-4 w-4 text-green-500" />
                <span className="text-sm text-green-500">CMS connected</span>
              </>
            ) : (
              <>
                <Circle className="h-4 w-4 text-muted-foreground" />
                <span className="text-sm text-muted-foreground">No CMS connected</span>
              </>
            )}
          </div>

          <div className="grid grid-cols-2 gap-3">
            {CMS_PLATFORMS.map(platform => (
              <Card key={platform.id} className="cursor-pointer hover:border-foreground/30 transition-colors">
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

          <p className="text-xs text-muted-foreground mt-4">
            CMS connection routes are handled by your backend. Connect from the project settings once your backend CMS routes are wired to a UI.
          </p>
        </TabsContent>

        {/* GSC Tab */}
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
                    The GSC monitor job runs every Monday at 10AM UTC. BlogLearning insights are generated automatically for underperforming posts.
                  </p>
                </div>
              ) : (
                <div className="space-y-3">
                  <p className="text-sm text-muted-foreground">
                    Connect your Google account to let the system read your Search Console data.
                    It only requests read access to your GSC property — nothing else.
                  </p>
                  <Button variant="outline" size="sm" asChild>
                    <a href={`/api/v1/gsc/connect?projectId=${projectId}`}>
                      <ExternalLink className="h-3.5 w-3.5 mr-1.5" />
                      Connect Google Search Console
                    </a>
                  </Button>
                </div>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        {/* Knowledge Files Tab */}
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
                File upload connects to <code className="bg-muted px-1 rounded">POST /api/v1/projects/:id/knowledge</code>.
                Wire the upload handler to this button when your knowledge route is ready.
              </p>
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>
    </div>
  );
}
