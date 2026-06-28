'use client';

import Link from 'next/link';
import { usePathname, useParams } from 'next/navigation';
import {
  LayoutDashboard,
  BarChart2,
  ShieldCheck,
  Globe,
  FileText,
  BookOpen,
  Settings,
  LogOut,
  ChevronDown,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { useAuthStore } from '@/lib/stores/auth.store';
import { useProjects } from '@/lib/hooks';
import { useLogout } from '@/lib/hooks';
import { Skeleton } from '@/components/ui/skeleton';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';

const NAV_ITEMS = [
  { label: 'Overview',      href: 'overview',  icon: LayoutDashboard },
  { label: 'Analytics',     href: 'geo',       icon: BarChart2 },
  { label: 'Technical SEO', href: 'audit',     icon: ShieldCheck },
  { label: 'Keywords',      href: 'keywords',  icon: FileText },
  { label: 'Blogs',         href: 'blogs',     icon: BookOpen },
  { label: 'Settings',      href: 'settings',  icon: Settings },
];

export function Sidebar() {
  const pathname  = usePathname();
  const params    = useParams();
  const projectId = params?.projectId as string | undefined;
  const logout    = useLogout();
  const user      = useAuthStore(s => s.user);

  const { data: projects, isLoading } = useProjects();
  const currentProject = projects?.find(p => p._id === projectId);

  return (
    <aside className="w-56 shrink-0 border-r border-border flex flex-col h-full bg-background">

      {/* Logo */}
      <div className="h-14 flex items-center px-4 border-b border-border">
        <span className="font-semibold text-base tracking-tight">SEO-GEO</span>
      </div>

      {/* Project selector */}
      <div className="px-3 pt-3 pb-2">
        {isLoading ? (
          <Skeleton className="h-8 w-full" />
        ) : projects && projects.length > 0 ? (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button className="w-full flex items-center justify-between px-2 py-1.5 rounded-md text-sm hover:bg-accent transition-colors">
                <span className="truncate text-muted-foreground">
                  {currentProject?.domain ?? 'Select project'}
                </span>
                <ChevronDown className="h-3.5 w-3.5 shrink-0 ml-1 text-muted-foreground" />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent className="w-48" align="start">
              {projects.map(p => (
                <DropdownMenuItem key={p._id} asChild>
                  <Link href={`/projects/${p._id}/overview`} className="truncate">
                    {p.domain}
                  </Link>
                </DropdownMenuItem>
              ))}
              <DropdownMenuItem asChild>
                <Link href="/projects/new" className="text-muted-foreground">
                  + New project
                </Link>
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        ) : (
          <Link
            href="/projects/new"
            className="flex items-center px-2 py-1.5 rounded-md text-sm text-muted-foreground hover:bg-accent transition-colors"
          >
            + Add project
          </Link>
        )}
      </div>

      {/* Nav */}
      <nav className="flex-1 px-3 py-2 space-y-0.5">
        {projectId ? (
          NAV_ITEMS.map(({ label, href, icon: Icon }) => {
            const full   = `/projects/${projectId}/${href}`;
            // blogs/[blogId] should keep "Blogs" active
            const active = pathname === full || pathname.startsWith(`${full}/`);
            return (
              <Link
                key={href}
                href={full}
                className={cn(
                  'flex items-center gap-2.5 px-2 py-1.5 rounded-md text-sm transition-colors',
                  active
                    ? 'bg-accent text-foreground font-medium'
                    : 'text-muted-foreground hover:bg-accent hover:text-foreground',
                )}
              >
                <Icon className="h-4 w-4 shrink-0" />
                {label}
              </Link>
            );
          })
        ) : (
          <Link
            href="/projects"
            className={cn(
              'flex items-center gap-2.5 px-2 py-1.5 rounded-md text-sm transition-colors',
              pathname === '/projects'
                ? 'bg-accent text-foreground font-medium'
                : 'text-muted-foreground hover:bg-accent hover:text-foreground',
            )}
          >
            <LayoutDashboard className="h-4 w-4 shrink-0" />
            Projects
          </Link>
        )}
      </nav>

      {/* Bottom */}
      <div className="px-3 pb-4 space-y-0.5 border-t border-border pt-3">
        <div className="px-2 py-1.5 text-xs text-muted-foreground truncate">
          {user?.email}
        </div>
        <button
          onClick={logout}
          className="w-full flex items-center gap-2.5 px-2 py-1.5 rounded-md text-sm text-muted-foreground hover:bg-accent hover:text-foreground transition-colors"
        >
          <LogOut className="h-4 w-4 shrink-0" />
          Logout
        </button>
      </div>
    </aside>
  );
}
