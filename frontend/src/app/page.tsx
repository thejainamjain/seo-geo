import Link from 'next/link';

const FEATURES = [
  {
    label: 'Site Crawl',
    desc:  'Maps every page, detects broken links, redirect chains, and structured data gaps.',
  },
  {
    label: 'Technical Audit',
    desc:  'Generates ready-to-deploy fixes for titles, meta, alt text, schema, and internal links.',
  },
  {
    label: 'Keyword Research',
    desc:  'Finds high-intent keywords your customers are already searching for.',
  },
  {
    label: 'Blog Generation',
    desc:  'Writes SEO-optimised blog posts grounded in your business context.',
  },
  {
    label: 'CMS Publish',
    desc:  'Publishes directly to WordPress, Webflow, Shopify, Sanity, and more.',
  },
  {
    label: 'GEO Analytics',
    desc:  'Tracks how often ChatGPT, Perplexity, and Gemini cite your site.',
  },
];

const STEPS = [
  { n: '1', title: 'Add your domain',      desc: 'Paste your website URL. No code or plugin needed.' },
  { n: '2', title: 'Fill business context', desc: 'A 5-step wizard so the AI understands your product, customers, and competitors.' },
  { n: '3', title: 'Pipeline runs',         desc: 'Nine phases from crawl to publish run automatically in the background.' },
  { n: '4', title: 'Review & approve',      desc: 'Every blog post and code change is yours to approve before it goes live.' },
];

export default function HomePage() {
  return (
    <div className="min-h-screen bg-background text-foreground">

      {/* Nav */}
      <header className="border-b border-border">
        <div className="max-w-5xl mx-auto px-6 h-14 flex items-center justify-between">
          <span className="font-semibold tracking-tight">SEO-GEO</span>
          <div className="flex items-center gap-4">
            <Link
              href="/login"
              className="text-sm text-muted-foreground hover:text-foreground transition-colors"
            >
              Log in
            </Link>
            <Link
              href="/register"
              className="text-sm bg-foreground text-background px-3.5 py-1.5 rounded-md hover:opacity-90 transition-opacity font-medium"
            >
              Get started
            </Link>
          </div>
        </div>
      </header>

      {/* Hero */}
      <section className="max-w-5xl mx-auto px-6 pt-24 pb-20 text-center">
        <p className="text-xs font-medium tracking-widest uppercase text-muted-foreground mb-6">
          AI-powered SEO &amp; GEO optimization
        </p>
        <h1 className="text-4xl sm:text-5xl font-semibold leading-tight tracking-tight mb-6">
          Get search visitors<br />
          <span className="text-muted-foreground">autonomously</span>
        </h1>
        <p className="text-base text-muted-foreground max-w-xl mx-auto mb-10">
          A 9-phase AI pipeline that crawls your site, researches keywords, writes blog posts,
          fixes technical SEO, publishes to your CMS, and tracks your AI citation score — all without you lifting a finger.
        </p>
        <div className="flex items-center justify-center gap-3">
          <Link
            href="/register"
            className="bg-foreground text-background px-5 py-2.5 rounded-md text-sm font-medium hover:opacity-90 transition-opacity"
          >
            Start for free
          </Link>
          <Link
            href="/login"
            className="border border-border px-5 py-2.5 rounded-md text-sm text-muted-foreground hover:text-foreground hover:border-foreground transition-colors"
          >
            Log in
          </Link>
        </div>
      </section>

      {/* How it works */}
      <section className="border-t border-border">
        <div className="max-w-5xl mx-auto px-6 py-20">
          <p className="text-xs font-medium tracking-widest uppercase text-muted-foreground mb-12 text-center">
            How it works
          </p>
          <div className="grid sm:grid-cols-2 lg:grid-cols-4 gap-8">
            {STEPS.map(step => (
              <div key={step.n}>
                <div className="w-7 h-7 rounded-full border border-border flex items-center justify-center text-xs font-medium text-muted-foreground mb-4">
                  {step.n}
                </div>
                <p className="text-sm font-medium mb-1.5">{step.title}</p>
                <p className="text-sm text-muted-foreground leading-relaxed">{step.desc}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Features */}
      <section className="border-t border-border bg-accent/30">
        <div className="max-w-5xl mx-auto px-6 py-20">
          <p className="text-xs font-medium tracking-widest uppercase text-muted-foreground mb-12 text-center">
            What runs automatically
          </p>
          <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-6">
            {FEATURES.map(f => (
              <div key={f.label} className="border border-border rounded-lg p-5 bg-background">
                <p className="text-sm font-medium mb-1.5">{f.label}</p>
                <p className="text-sm text-muted-foreground leading-relaxed">{f.desc}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* CTA */}
      <section className="border-t border-border">
        <div className="max-w-5xl mx-auto px-6 py-20 text-center">
          <h2 className="text-2xl font-semibold mb-4">Ready to grow organic traffic?</h2>
          <p className="text-sm text-muted-foreground mb-8">
            Add your domain and the pipeline starts in minutes.
          </p>
          <Link
            href="/register"
            className="bg-foreground text-background px-6 py-2.5 rounded-md text-sm font-medium hover:opacity-90 transition-opacity"
          >
            Get started free
          </Link>
        </div>
      </section>

      {/* Footer */}
      <footer className="border-t border-border">
        <div className="max-w-5xl mx-auto px-6 h-14 flex items-center justify-between">
          <span className="text-xs text-muted-foreground">SEO-GEO</span>
          <div className="flex items-center gap-4">
            <Link href="/login"    className="text-xs text-muted-foreground hover:text-foreground transition-colors">Log in</Link>
            <Link href="/register" className="text-xs text-muted-foreground hover:text-foreground transition-colors">Register</Link>
          </div>
        </div>
      </footer>

    </div>
  );
}
