'use client';

export default function AuthLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen flex items-center justify-center bg-background px-4">
      <div className="w-full max-w-sm">
        <div className="mb-8 text-center">
          <h1 className="text-2xl font-semibold tracking-tight">SEO-GEO</h1>
          <p className="text-sm text-muted-foreground mt-1">AI-powered SEO and GEO optimization</p>
        </div>
        {children}
      </div>
    </div>
  );
}
