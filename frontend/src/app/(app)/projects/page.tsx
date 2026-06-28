'use client';

import { useState } from 'react';
import { useCreateProject } from '@/lib/hooks';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from '@/components/ui/card';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Globe } from 'lucide-react';

export default function NewProjectPage() {
  const [domain, setDomain] = useState('');
  const createProject = useCreateProject();

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    // Strip protocol if user pastes full URL
    const cleaned = domain
      .replace(/^https?:\/\//, '')
      .replace(/^www\./, '')
      .replace(/\/$/, '')
      .trim();
    createProject.mutate(cleaned);
  };

  return (
    <div className="p-8 max-w-lg mx-auto">
      <div className="mb-8">
        <h1 className="text-2xl font-semibold">New project</h1>
        <p className="text-sm text-muted-foreground mt-1">
          Enter your website domain to start the 9-phase optimization pipeline
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Website domain</CardTitle>
          <CardDescription>
            The pipeline will crawl your site, research keywords, write blog posts, and track AI citations.
            This takes 10–30 minutes depending on site size.
          </CardDescription>
        </CardHeader>

        <form onSubmit={handleSubmit}>
          <CardContent className="space-y-4">
            {createProject.error && (
              <Alert variant="destructive">
                <AlertDescription>
                  {(createProject.error as { response?: { data?: { error?: { message?: string } } } })
                    ?.response?.data?.error?.message ?? 'Failed to create project'}
                </AlertDescription>
              </Alert>
            )}

            <div className="space-y-1.5">
              <Label htmlFor="domain">Domain</Label>
              <div className="relative">
                <Globe className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                <Input
                  id="domain"
                  type="text"
                  placeholder="example.com"
                  value={domain}
                  onChange={e => setDomain(e.target.value)}
                  className="pl-9"
                  required
                  autoFocus
                />
              </div>
              <p className="text-xs text-muted-foreground">
                Enter just the domain — no https:// or trailing slash needed
              </p>
            </div>
          </CardContent>

          <CardFooter>
            <Button type="submit" className="w-full" disabled={createProject.isPending}>
              {createProject.isPending ? 'Starting pipeline…' : 'Start optimization'}
            </Button>
          </CardFooter>
        </form>
      </Card>
    </div>
  );
}
