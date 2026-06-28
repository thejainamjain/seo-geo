'use client';

import Link from 'next/link';
import { Plus, Globe, ArrowRight } from 'lucide-react';
import { useProjects } from '@/lib/hooks';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { timeAgo } from '@/lib/utils/format';

function StatusBadge({ status }: { status: string }) {
  const map: Record<string, 'default' | 'secondary' | 'destructive' | 'outline'> = {
    COMPLETED: 'default',
    RUNNING:   'secondary',
    ERRORED:   'destructive',
    PENDING:   'outline',
  };
  return <Badge variant={map[status] ?? 'outline'}>{status}</Badge>;
}

export default function ProjectsPage() {
  const { data: projects, isLoading, error } = useProjects();

  return (
    <div className="p-8 max-w-4xl mx-auto">
      <div className="flex items-center justify-between mb-8">
        <div>
          <h1 className="text-2xl font-semibold">Projects</h1>
          <p className="text-sm text-muted-foreground mt-1">
            Each project is one website domain being optimized
          </p>
        </div>
        <Button asChild>
          <Link href="/projects/new">
            <Plus className="h-4 w-4 mr-1.5" />
            New project
          </Link>
        </Button>
      </div>

      {isLoading && (
        <div className="space-y-3">
          {[1, 2, 3].map(i => <Skeleton key={i} className="h-20 w-full" />)}
        </div>
      )}

      {error && (
        <p className="text-sm text-destructive">Failed to load projects. Check your connection.</p>
      )}

      {projects && projects.length === 0 && (
        <div className="text-center py-16 border border-dashed border-border rounded-lg">
          <Globe className="h-8 w-8 mx-auto text-muted-foreground mb-3" />
          <p className="text-sm font-medium">No projects yet</p>
          <p className="text-sm text-muted-foreground mt-1 mb-4">
            Add a website domain to start the optimization pipeline
          </p>
          <Button asChild>
            <Link href="/projects/new">
              <Plus className="h-4 w-4 mr-1.5" />
              Add your first project
            </Link>
          </Button>
        </div>
      )}

      {projects && projects.length > 0 && (
        <div className="space-y-2">
          {projects.map(project => (
            <Link
              key={project._id}
              href={`/projects/${project._id}/overview`}
              className="flex items-center justify-between p-4 border border-border rounded-lg hover:bg-accent transition-colors group"
            >
              <div className="flex items-center gap-3 min-w-0">
                <Globe className="h-4 w-4 text-muted-foreground shrink-0" />
                <div className="min-w-0">
                  <p className="text-sm font-medium truncate">{project.domain}</p>
                  <p className="text-xs text-muted-foreground mt-0.5">
                    Added {timeAgo(project.createdAt)}
                  </p>
                </div>
              </div>
              <div className="flex items-center gap-3 shrink-0">
                <StatusBadge status={project.pipeline.status} />
                <ArrowRight className="h-4 w-4 text-muted-foreground opacity-0 group-hover:opacity-100 transition-opacity" />
              </div>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}

