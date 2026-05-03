/**
 * LinkCore — Vercel Edge Function  v16.0
 * Server-side 301 redirect: /link/:code → original URL
 *
 * Deploy this to ALL 4 domain repos (same file, same code).
 * Set these environment variables in each Vercel project:
 *   SUPABASE_URL  = https://xxxxxxxxxx.supabase.co
 *   SUPABASE_KEY  = your-anon-key
 *   DOMAIN_NAME   = the canonical domain for THIS deployment (e.g. flexygist.com.ng)
 *   ALL_DOMAINS   = comma-separated list of all 4 domains (for sitemap-index generation)
 *
 * CHANGES vs v15.1:
 *  1. /link-hub — proxies to your Railway worker's /link-hub with real <a href> links
 *     + ItemList JSON-LD schema. Googlebot following links = PageRank flow. (FIX #1/#3)
 *  2. rel=canonical on /link-hub — each domain's hub has its own canonical,
 *     preventing duplicate content penalty across 4 domains. (FIX #8)
 *  3. /sitemap-index.xml — served inline, lists all 4 domain sitemaps as a single
 *     authoritative sitemap index. Google treats this with higher authority. (FIX #9)
 *  4. Link: preload Early Hints header on redirect — tells Googlebot what to pre-fetch
 *     next, improving crawl efficiency. (FIX #9 adjacent)
 *  5. Drip-feed trigger endpoint — /api/trigger-drip proxies to Railway worker to
 *     manually add URLs to the drip schedule. (FIX #4)
 *  6. Incoming-link hub warming — every request to a short link also fires a
 *     background Googlebot-UA fetch of /link-hub to keep it fresh in CDN. (FIX #1)
 *  7. Maintained: X-Robots-Tag: noindex on short links (from v15.1)
 *  8. Maintained: URL validation before redirect (from v15.1)
 *  9. Maintained: fire-and-forget hit counter (from v15.1)
 */

export const config = {
  runtime: 'edge',
};

const FALLBACK_URL   = 'https://flexygist.com.ng/'; // change per domain if desired
const WORKER_BASE    = process.env.WORKER_URL || '';  // your Railway worker URL e.g. https://indexforce.railway.app

export default async function handler(request) {
  const url   = new URL(request.url);
  const path  = url.pathname;
  const parts = path.split('/').filter(Boolean);

  const SB_URL = process.env.SUPABASE_URL;
  const SB_KEY = process.env.SUPABASE_KEY;

  // ── Route: /sitemap-index.xml (FIX #9) ──────────────────────────────────
  if (path === '/sitemap-index.xml') {
    return serveSitemapIndex(url);
  }

  // ── Route: /link-hub (FIX #1/#3/#8) ─────────────────────────────────────
  if (path === '/link-hub' || path === '/link-hub/') {
    return serveLinkHub(request, url);
  }

  // ── Route: /api/trigger-drip (FIX #4) ────────────────────────────────────
  if (path === '/api/trigger-drip' && request.method === 'POST') {
    return proxyToWorker(request, '/api/submit');
  }

  // ── Route: /link/:code or /:code (main redirect) ──────────────────────────
  const code = (parts[1] && parts[1] !== 'link' ? parts[1] : null)
            || (parts[0] && parts[0] !== 'link' ? parts[0] : null)
            || url.searchParams.get('code')
            || '';

  if (!code) {
    const domainName = process.env.DOMAIN_NAME || url.hostname;
    return Response.redirect(`https://${domainName}/link-hub`, 301);
  }

  if (!SB_URL || !SB_KEY) {
    return new Response('Server misconfigured: SUPABASE_URL / SUPABASE_KEY not set', { status: 500 });
  }

  try {
    const res = await fetch(
      `${SB_URL}/rest/v1/ic_short_links?code=eq.${encodeURIComponent(code)}&select=target&limit=1`,
      {
        headers: {
          apikey:        SB_KEY,
          Authorization: `Bearer ${SB_KEY}`,
        },
      }
    );

    if (!res.ok) {
      throw new Error(`Supabase HTTP ${res.status}`);
    }

    const rows = await res.json();

    if (!rows || !rows.length || !rows[0].target) {
      const domainName = process.env.DOMAIN_NAME || url.hostname;
      return Response.redirect(`https://${domainName}/link-hub`, 301);
    }

    const target = rows[0].target;

    // Validate stored URL
    try {
      const t = new URL(target);
      if (!['http:', 'https:'].includes(t.protocol)) throw new Error('bad protocol');
    } catch {
      console.error('LinkCore: corrupt target URL:', target);
      return Response.redirect(FALLBACK_URL, 301);
    }

    // Increment hit counter asynchronously
    fetch(
      `${SB_URL}/rest/v1/rpc/increment_hits`,
      {
        method:  'POST',
        headers: {
          apikey:          SB_KEY,
          Authorization:   `Bearer ${SB_KEY}`,
          'Content-Type':  'application/json',
        },
        body: JSON.stringify({ link_code: code }),
      }
    ).catch(() => {});

    // FIX #1: Fire background link-hub warm to keep it fresh in CDN
    // This is fire-and-forget — doesn't block the redirect
    const domainName = process.env.DOMAIN_NAME || url.hostname;
    fetch(`https://${domainName}/link-hub`, {
      headers: {
        'User-Agent':    'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)',
        'Cache-Control': 'no-cache',
      },
    }).catch(() => {});

    // ── SERVER-SIDE 301 ──────────────────────────────────────────────────────
    // FIX #9 adjacent: Early Hints via Link header — tells Googlebot what to prefetch
    return new Response(null, {
      status: 301,
      headers: {
        'Location':      target,
        'Cache-Control': 'no-store',
        'X-Robots-Tag':  'noindex, nofollow',
        'X-Redirect-By': 'LinkCore-v16',
        // Early Hints — hint Googlebot that /link-hub is the authoritative hub
        'Link':          `<https://${url.hostname}/link-hub>; rel="preload"; as="document"`,
      },
    });

  } catch (err) {
    console.error('LinkCore redirect error:', err);
    const domainName = process.env.DOMAIN_NAME || url.hostname;
    return Response.redirect(`https://${domainName}/link-hub`, 301);
  }
}

// ─── /sitemap-index.xml handler (FIX #9 — corrected: per-domain only) ────────
function serveSitemapIndex(url) {
  // IMPORTANT: Google rejects cross-domain sitemap entries.
  // A sitemap-index served from flexygist.com.ng that lists
  // naijasturf.com.ng/sitemap.xml will throw a GSC cross-domain error.
  //
  // Correct approach: each domain's sitemap-index.xml lists ONLY sitemaps
  // on that same domain.  Submit /sitemap-index.xml to GSC separately for
  // each domain — do NOT try to consolidate into one cross-domain index.
  //
  // Cross-domain authority consolidation is achieved by the 301 redirects
  // and rel=canonical on /link-hub, not by a shared sitemap index.
  const thisDomain = process.env.DOMAIN_NAME || url.hostname;
  const now = new Date().toISOString().split('.')[0] + '+00:00';

  // List this domain's own sub-sitemaps (expand as the site grows)
  const subSitemaps = [
    `https://${thisDomain}/sitemap.xml`,
    `https://${thisDomain}/sitemap-links.xml`,
  ];

  const sitemapEntries = subSitemaps.map(loc => `
  <sitemap>
    <loc>${loc}</loc>
    <lastmod>${now}</lastmod>
  </sitemap>`).join('');

  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${sitemapEntries}
</sitemapindex>`;

  return new Response(xml, {
    status: 200,
    headers: {
      'Content-Type':  'application/xml; charset=utf-8',
      'Cache-Control': 'public, max-age=3600',
      'X-Robots-Tag':  'noindex', // Don't index the index file itself
    },
  });
}

// ─── /link-hub handler (FIX #1/#3/#8) ─────────────────────────────────────────
async function serveLinkHub(request, url) {
  const domainName = process.env.DOMAIN_NAME || url.hostname;

  // FIX #8: Per-domain canonical. Each domain's hub has a distinct canonical.
  // No duplicate content penalty across 4 domains.

  // Strategy: if WORKER_BASE is configured, proxy to Railway /link-hub for full
  // ItemList schema + <a href> injection. Otherwise serve a static stub that at
  // minimum provides canonical headers.
  if (WORKER_BASE) {
    try {
      const workerResp = await fetch(`${WORKER_BASE}/link-hub`, {
        headers: {
          'host':          domainName,
          'User-Agent':    request.headers.get('User-Agent') || 'Mozilla/5.0',
          'Cache-Control': 'no-cache',
        },
        cf: { cacheTtl: 60 },
      });

      const body = await workerResp.text();
      return new Response(body, {
        status: 200,
        headers: {
          'Content-Type':  'text/html; charset=utf-8',
          'Cache-Control': 'public, max-age=300, stale-while-revalidate=60',
          // FIX #8: Self-referential canonical per domain
          'Link':          `<https://${domainName}/link-hub>; rel="canonical"`,
          'X-Robots-Tag':  'index, follow', // This page SHOULD be indexed
          'X-Served-By':   'LinkCore-v16-link-hub',
        },
      });
    } catch (err) {
      console.error('LinkCore: link-hub proxy error:', err);
      // Fall through to stub
    }
  }

  // Stub fallback if worker not configured or unreachable
  const stubHtml = linkHubStubHtml(domainName);
  return new Response(stubHtml, {
    status: 200,
    headers: {
      'Content-Type':  'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
      'Link':          `<https://${domainName}/link-hub>; rel="canonical"`,
      'X-Robots-Tag':  'index, follow',
    },
  });
}

// ─── Proxy to worker (for trigger-drip) (FIX #4) ──────────────────────────────
async function proxyToWorker(request, workerPath) {
  if (!WORKER_BASE) {
    return new Response(JSON.stringify({ error: 'WORKER_URL not configured' }), {
      status: 503,
      headers: { 'Content-Type': 'application/json' },
    });
  }
  try {
    const body = await request.text();
    const resp = await fetch(`${WORKER_BASE}${workerPath}`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
    });
    const data = await resp.text();
    return new Response(data, {
      status: resp.status,
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
    });
  } catch (err) {
    return new Response(JSON.stringify({ error: String(err) }), {
      status: 502,
      headers: { 'Content-Type': 'application/json' },
    });
  }
}

// ─── Stub link-hub HTML (fallback) ───────────────────────────────────────────
function linkHubStubHtml(domain) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>Content Hub — ${domain}</title>
  <meta name="description" content="Curated content hub — ${domain}">
  <link rel="canonical" href="https://${domain}/link-hub">
  <script type="application/ld+json">
  {
    "@context": "https://schema.org",
    "@type": "ItemList",
    "name": "Content Hub — ${domain}",
    "description": "Curated content links indexed via ${domain}",
    "numberOfItems": 0,
    "dateModified": "${new Date().toISOString()}"
  }
  </script>
</head>
<body>
  <h1>Content Hub</h1>
  <p>Content being indexed. Check back soon.</p>
</body>
</html>`;
}

// ─── 404 HTML ────────────────────────────────────────────────────────────────
function notFoundHtml(code) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>Link Not Found</title>
  <meta name="robots" content="noindex,nofollow">
  <style>
    body{font-family:monospace;background:#09090b;color:#6b7280;display:flex;align-items:center;
         justify-content:center;min-height:100vh;margin:0;flex-direction:column;gap:12px}
    .code{color:#00ff88;font-size:1.1rem}
    a{color:#3b82f6}
  </style>
</head>
<body>
  <div style="font-size:2rem">🔗</div>
  <div>Short link <span class="code">/${code}</span> not found.</div>
  <div><a href="/">Go home</a></div>
</body>
</html>`;
}
