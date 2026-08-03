'use client';

import Link from 'next/link';
import { usePathname, useParams } from 'next/navigation';
import {
  LayoutDashboard,
  BarChart2,
  Terminal,
  PenSquare,
  Settings,
  LogOut,
  ChevronDown,
  Building2,
  PlayCircle,
  HelpCircle,
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

// Matches the target product's nav IA (Home / Analytics / Technical SEO &
// GEO / Keywords & Content / Settings).
//
// "Analytics" now points at the new combined analytics page (see
// app/(app)/projects/[projectId]/analytics/page.tsx) — Pages/SEO Fixes/
// Schemas/Ranked cards, Performance Overview, Top Movers, AI Search
// Metrics (GEO), Rewrite Queue, Keyword Performance, all in one
// scrollable page, matching the reference screenshots. It previously
// pointed at /geo (GEO metrics only) — that page still exists at its own
// route but is no longer linked from the nav; its content was migrated
// into a section of the new page rather than duplicated.
//
// One item is still a judgment call, flagged here rather than silently
// guessed:
//  - "Website Audit" isn't included as its own item yet: the target app
//    shows it as a nav entry separate from "Technical SEO & GEO", and we
//    now know (per screenshots) they ARE meant to be two distinct pages —
//    but the existing /audit page is an older hybrid design (tabs:
//    Active/Applied/FAQs/TLDRs) that cleanly matches NEITHER target page.
//    Splitting it needs real frontend work, not just a nav change — see
//    the TODO in audit/page.tsx.
//  - "Business" is kept even though the target nav doesn't show it as a
//    top-level item — in the real product it likely lives inside Settings
//    instead, but that's a Settings-page redesign we haven't scoped yet.
//    Dropping it now would remove the only way to view/edit the AI-drafted
//    business profile with nothing to replace it, so it stays until
//    Settings gets rebuilt.
const NAV_ITEMS = [
  { label: 'Home',                 href: 'overview',   icon: LayoutDashboard },
  { label: 'Analytics',            href: 'analytics',  icon: BarChart2 },
  { label: 'Technical SEO & GEO',  href: 'audit',      icon: Terminal },
  { label: 'Keywords & Content',   href: 'keywords',   icon: PenSquare },
  { label: 'Business',             href: 'business',   icon: Building2 },
  { label: 'Settings',             href: 'settings',   icon: Settings },
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
      <div className="px-3 pb-4 space-y-2 border-t border-border pt-3">
        {/*
          PRO / BILLING — deferred.
          No billing/Stripe integration, no plan model, no entitlement
          checks anywhere in the app. Rather than ship a disabled button
          that implies a Pro tier exists, this is commented out entirely
          until billing is actually built. Re-enable + wire to a real
          checkout flow then.

        <Button variant="default" className="w-full justify-center gap-1.5" size="sm">
          <Sparkles className="h-3.5 w-3.5" />
          Upgrade to Pro
        </Button>
        */}

        {/*
          Tutorial — target product opens a walkthrough-video modal here.
          No video assets or copy source were provided, so this is a
          disabled placeholder rather than fabricated content/links.
        */}
        <button
          disabled
          className="w-full flex items-center gap-2.5 px-2 py-1.5 rounded-md text-sm text-muted-foreground/50 cursor-not-allowed"
          title="Not wired up yet — no walkthrough content provided"
        >
          <PlayCircle className="h-4 w-4 shrink-0" />
          Tutorial
        </button>

        {/*
          Help — target product opens a chat widget (Intercom/Crisp-style).
          No such integration exists in this codebase. Mailto is a
          reasonable placeholder; swap for a real widget when you pick one.
        */}
        <a
          href="mailto:support@seo-geo.app"
          className="w-full flex items-center gap-2.5 px-2 py-1.5 rounded-md text-sm text-muted-foreground hover:bg-accent hover:text-foreground transition-colors"
        >
          <HelpCircle className="h-4 w-4 shrink-0" />
          Help
        </a>

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
