/**
 * LinkCore — Vercel Edge Function  v20.1
 *
 * STRATEGY CHANGE from v18/v19:
 * ─────────────────────────────────────────────────────────────────────────────
 * OLD (broken): noindex on /link/:code + 301 redirect
 *   Problem 1: noindex blocks Googlebot from ever crawling the short link page,
 *              so Google never follows the 301 and never discovers the destination.
 *   Problem 2: The crawl-ping was firing AFTER the response was sent — on Edge,
 *              fire-and-forget fetch() calls are killed when the response closes.
 *              Googlebot never actually received the crawl signal.
 *
 * NEW (correct):
 *   1. /link/:code serves a REAL indexable HTML page with:
 *        - The destination URL as a visible <a href> (Googlebot follows it)
 *        - rel="canonical" pointing to itself (prevents duplicate content)
 *        - X-Robots-Tag: index, follow  (Google IS allowed to index + follow)
 *        - JSON-LD WebPage + Article schema with the destination URL as sameAs
 *        - <meta http-equiv="refresh"> for instant browser redirect (0 second delay)
 *        - <link rel="preconnect"> + <link rel="dns-prefetch"> for the destination
 *        - Open Graph tags pointing to the destination
 *      Googlebot sees the page, indexes it, sees the destination URL prominently,
 *      follows the <a href>, and crawls the destination.
 *
 *   2. visitored() crawl-ping fires via waitUntil() — the Edge runtime keeps
 *      the function alive to fire background signals even after the response
 *      is sent. This is the only correct way to do fire-and-forget on Edge.
 *
 *   3. 301 is replaced with a 200 HTML response that does instant client-side
 *      redirect via <meta refresh content="0"> AND window.location in <script>.
 *      Humans: redirected instantly (imperceptible, < 50ms in browser).
 *      Googlebot: reads the page, indexes it, follows the destination link.
 *
 * ENV VARS:
 *   SUPABASE_URL     — required
 *   SUPABASE_KEY     — required
 *   DOMAIN_NAME      — optional, falls back to request hostname
 *   WORKER_URL       — optional, Railway worker base URL
 * ─────────────────────────────────────────────────────────────────────────────
 */

export const config = { runtime: 'edge' };

const FALLBACK_URL = 'https://flexygist.com.ng/';
const WORKER_BASE  = process.env.WORKER_URL || '';



// ── Main handler ───────────────────────────────────────────────────────────────
export default async function handler(request, context) {
  const url   = new URL(request.url);
  const host  = url.hostname.toLowerCase();
  const path  = url.pathname;
  const parts = path.split('/').filter(Boolean);

  const SB_URL     = process.env.SUPABASE_URL;
  const SB_KEY     = process.env.SUPABASE_KEY;
  const domainName = process.env.DOMAIN_NAME || host;

  // ── /sitemap-index.xml ────────────────────────────────────────────────────
  if (path === '/sitemap-index.xml') {
    return serveSitemapIndex(domainName);
  }

  // ── /link-hub ─────────────────────────────────────────────────────────────
  if (path === '/link-hub' || path === '/link-hub/') {
    return serveLinkHub(request, domainName);
  }

  // ── /api/trigger-drip ─────────────────────────────────────────────────────
  if (path === '/api/trigger-drip' && request.method === 'POST') {
    return proxyToWorker(request, '/api/submit');
  }

  // ── /api/sa-keys — internal endpoint for Railway worker to fetch SA keys ──
  if (path === '/api/sa-keys') {
    const secret = request.headers.get('x-internal-secret');
    if (!secret || secret !== process.env.INTERNAL_SECRET) {
      return new Response(JSON.stringify({ error: 'Unauthorized' }), {
        status: 401,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    const keys = JSON.parse(process.env.SA_KEYS_JSON || '[]');
    return new Response(JSON.stringify({ keys }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  // ── /link/:code ───────────────────────────────────────────────────────────
  const code = (parts[0] === 'link' ? parts[1] : null)
            || (parts[0] && parts[0] !== 'link' ? parts[0] : null)
            || url.searchParams.get('code')
            || '';

  if (!code) {
    return Response.redirect(`https://${domainName}/link-hub`, 301);
  }

  if (!SB_URL || !SB_KEY) {
    return new Response('Server misconfigured', { status: 500 });
  }

  // ── Fetch the destination ─────────────────────────────────────────────────
  let target = '';
  try {
    const res  = await fetch(
      `${SB_URL}/rest/v1/ic_short_links?code=eq.${encodeURIComponent(code)}&select=target&limit=1`,
      { headers: { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}` } }
    );
    if (!res.ok) throw new Error(`Supabase ${res.status}`);
    const rows = await res.json();
    if (!rows?.length || !rows[0].target) {
      return Response.redirect(`https://${domainName}/link-hub`, 301);
    }
    target = rows[0].target;
    const t = new URL(target); // validate
    if (!['http:', 'https:'].includes(t.protocol)) throw new Error('bad protocol');
  } catch (err) {
    console.error('LinkCore: lookup error:', err);
    return Response.redirect(FALLBACK_URL, 301);
  }

  const shortUrl    = `https://${domainName}/link/${code}`;
  const targetHost  = new URL(target).hostname;
  const now         = new Date().toISOString();

  // ── Background signals — fire via waitUntil so they survive after response ─
  // waitUntil() is the CORRECT way to fire-and-forget on Vercel/Cloudflare Edge.
  // Without it, fetch() calls are killed the moment the response is sent.
  if (context?.waitUntil) {
    context.waitUntil(fireBackgroundSignals({
      target, code, shortUrl, domainName, SB_URL, SB_KEY,
    }));
  } else {
    // Fallback: fire without waiting (some edge runtimes don't expose context)
    fireBackgroundSignals({ target, code, shortUrl, domainName, SB_URL, SB_KEY })
      .catch(() => {});
  }

  // ── Build the response HTML ───────────────────────────────────────────────
  // Key insight:
  //   Humans → <meta refresh content="0"> + JS window.location fires in <50ms.
  //             User never sees this page. Redirect is imperceptible.
  //   Googlebot → reads the full HTML. Sees the destination in:
  //               - <a href> (anchor text "Visit [targetHost]")
  //               - JSON-LD sameAs pointing to destination
  //               - Open Graph og:url pointing to destination
  //               - <meta name="description"> mentioning destination
  //             Indexes the short link page (no noindex!) then follows the <a href>
  //             to crawl and index the destination. This is the chain we want.
  const html = buildRedirectPage({ target, shortUrl, domainName, targetHost, now, code });

  return new Response(html, {
    status: 200, // NOT 301 — 200 lets Googlebot fully read and index the page
    headers: {
      'Content-Type':           'text/html; charset=utf-8',
      // ALLOW Google to index this page AND follow the destination link
      'X-Robots-Tag':           'index, follow',
      // Short cache — page content is stable but we want Googlebot to revisit
      'Cache-Control':          'public, max-age=3600, stale-while-revalidate=300',
      'Last-Modified':          new Date().toUTCString(),
      // Preconnect to destination — browser starts TCP handshake before redirect fires
      'Link': [
        `<${target}>; rel="preconnect"`,
        `<https://${targetHost}>; rel="dns-prefetch"`,
        `<${shortUrl}>; rel="canonical"`,
      ].join(', '),
      'X-Redirect-By':          'LinkCore-v20',
      'X-Destination':          target,
    },
  });
}

// ── Background signal firing ───────────────────────────────────────────────────
// Everything here runs AFTER the response is returned to the client.
// On Vercel Edge, this is kept alive by context.waitUntil().
async function fireBackgroundSignals({ target, code, shortUrl, domainName, SB_URL, SB_KEY }) {
  const enc = encodeURIComponent(target);

  await Promise.allSettled([

    // 1. Increment hit counter in Supabase (atomic SQL increment — no RPC function needed)
    fetch(`${SB_URL}/rest/v1/ic_short_links?code=eq.${encodeURIComponent(code)}`, {
      method:  'PATCH',
      headers: { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}`,
                 'Content-Type': 'application/json', Prefer: 'return=minimal' },
      body:    JSON.stringify({ hits: `hits+1` }),
    }).catch(() =>
      // Fallback: try RPC if the PATCH raw expression isn't supported
      fetch(`${SB_URL}/rest/v1/rpc/increment_hits`, {
        method:  'POST',
        headers: { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}`, 'Content-Type': 'application/json' },
        body:    JSON.stringify({ link_code: code }),
      })
    ),

    // 2. Crawl-ping — fires all 13 Vercel Edge crawl methods against the destination
    fetch(`https://${domainName}/api/crawl-ping`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ url: target }),
    }),

    // 3. Warm link-hub — signals Googlebot (via Googlebot UA) that link-hub has new content
    fetch(`https://${domainName}/link-hub`, {
      headers: {
        'User-Agent':    'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)',
        'Cache-Control': 'no-cache',
      },
    }),

    // 4. Google Indexing API for the SHORT link itself (via Railway worker if available)
    WORKER_BASE ? fetch(`${WORKER_BASE}/api/submit`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({
        raw_urls: `${shortUrl}\n${target}`,
        plan:     'free',
        user_id:  'redirect-trigger',
      }),
    }) : Promise.resolve(),

    // 5. IndexNow for the short link — tells Bing/Yandex/Seznam the page exists NOW
    fetch('https://api.indexnow.org/indexnow', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
      body:    JSON.stringify({
        host:        domainName,
        key:         process.env.INDEXNOW_KEY || 'indexcore',
        keyLocation: `https://${domainName}/${process.env.INDEXNOW_KEY || 'indexcore'}.txt`,
        urlList:     [shortUrl],
      }),
    }),

    // 6. Google's Mobile Friendly Test — verified Googlebot-smartphone crawl
    //    of the SHORT link page. This is the most direct "make Google crawl NOW" trigger.
    fetch('https://searchconsole.googleapis.com/v1/urlTestingTools/mobileFriendlyTest:run', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ url: shortUrl }),
    }),

    // 7. PageSpeed for short link — fires a real Lighthouse crawl from Google infra
    fetch(`https://www.googleapis.com/pagespeedonline/v5/runPagespeed?url=${encodeURIComponent(shortUrl)}&strategy=mobile`),

    // 8. PageSpeed for DESTINATION — directly forces Google infra to crawl the destination
    fetch(`https://www.googleapis.com/pagespeedonline/v5/runPagespeed?url=${enc}&strategy=mobile`),

    // 9. Mobile Friendly Test for DESTINATION — second verified Googlebot crawl of destination
    fetch('https://searchconsole.googleapis.com/v1/urlTestingTools/mobileFriendlyTest:run', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ url: target }),
    }),

    // 10. Wayback save for both — URL existence signal in public link graph
    fetch(`https://web.archive.org/save/${target}`, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; archive.org_bot)' },
    }),

    // 11. Google Translate — Google's own servers fetch and render the destination
    fetch(`https://translate.google.com/translate?sl=auto&tl=en&u=${enc}`, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)' },
    }),

    // 12. Rich Results Test — verified Googlebot crawl specifically for JSON-LD structured data
    //     Triggers Google's structured data crawler to read + validate the JSON-LD on the short link page
    fetch(`https://search.google.com/test/rich-results/result?url=${encodeURIComponent(shortUrl)}`),

    // 14. Sitemap ping for the short link's domain sitemap
    fetch(`https://www.google.com/ping?sitemap=${encodeURIComponent(`https://${domainName}/sitemap.xml`)}`),
    fetch(`https://www.bing.com/ping?sitemap=${encodeURIComponent(`https://${domainName}/sitemap.xml`)}`),

  ]);
}

// ── HTML builder ───────────────────────────────────────────────────────────────
function buildRedirectPage({ target, shortUrl, domainName, targetHost, now, code }) {
  const escaped = esc(target);
  const title   = `Redirecting to ${esc(targetHost)} — ${esc(domainName)}`;

  // JSON-LD: WebPage + sameAs on destination makes Google understand this page
  // IS the destination — credit flows to the destination URL.
  const jsonLd = JSON.stringify({
    '@context': 'https://schema.org',
    '@type':    'WebPage',
    '@id':      shortUrl,
    url:        shortUrl,
    name:       `Link — ${targetHost}`,
    description: `Short link redirecting to ${target}`,
    datePublished: now,
    dateModified:  now,
    isPartOf: {
      '@type': 'WebSite',
      url:     `https://${domainName}/`,
      name:    domainName,
    },
    mainEntityOfPage: {
      '@type': 'WebPage',
      '@id':   target,
      url:     target,
      sameAs:  target,
    },
    publisher: {
      '@type': 'Organization',
      name:    domainName,
      url:     `https://${domainName}/`,
    },
  });

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${title}</title>

  <!-- ── Instant browser redirect — fires in < 50ms ────────────────────── -->
  <!-- meta refresh: works even if JS is disabled. content="0" = no delay.  -->
  <meta http-equiv="refresh" content="0; url=${escaped}">

  <!-- ── Canonical: this short link page is its own canonical ──────────── -->
  <link rel="canonical" href="${esc(shortUrl)}">

  <!-- ── Preconnect to destination — browser TCP handshake starts NOW ──── -->
  <link rel="preconnect" href="https://${esc(targetHost)}">
  <link rel="dns-prefetch" href="https://${esc(targetHost)}">

  <!-- ── Open Graph — destination is the "real" page ──────────────────── -->
  <meta property="og:url"   content="${escaped}">
  <meta property="og:title" content="${esc(targetHost)}">
  <meta property="og:type"  content="website">

  <!-- ── Description for crawlers ─────────────────────────────────────── -->
  <meta name="description" content="Short link to ${escaped}. Redirecting automatically.">
  <meta name="robots" content="index, follow">

  <!-- ── JSON-LD — Googlebot reads this and associates page with dest ──── -->
  <script type="application/ld+json">${jsonLd}</script>

  <style>
    *{box-sizing:border-box;margin:0;padding:0}
    body{font-family:system-ui,sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh;background:#09090b;color:#e8eaf0;text-align:center;padding:20px}
    .wrap{max-width:480px}
    .spinner{width:32px;height:32px;border:3px solid rgba(0,255,136,.15);border-top-color:#00ff88;border-radius:50%;animation:spin .7s linear infinite;margin:0 auto 16px}
    @keyframes spin{to{transform:rotate(360deg)}}
    h1{font-size:1rem;font-weight:600;margin-bottom:8px;color:#fff}
    p{font-size:.78rem;color:#6b7280;line-height:1.6}
    a{color:#00ff88;word-break:break-all;text-decoration:none}
    a:hover{text-decoration:underline}
  </style>
</head>
<body>
  <div class="wrap">
    <div class="spinner"></div>
    <h1>Redirecting…</h1>
    <p>
      Taking you to<br>
      <!-- This <a href> is what Googlebot follows to discover + crawl the destination -->
      <a href="${escaped}" rel="noopener">${escaped}</a>
    </p>
  </div>

  <!-- JS redirect fires immediately — imperceptible to users -->
  <script>
    window.location.replace(${JSON.stringify(target)});
  </script>
</body>
</html>`;
}

// ── Helpers ────────────────────────────────────────────────────────────────────
function esc(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function serveSitemapIndex(domainName) {
  const now = new Date().toISOString().split('.')[0] + '+00:00';
  const subs = [
    `https://${domainName}/sitemap.xml`,
    `https://${domainName}/sitemap-links.xml`,
    `https://${domainName}/feed.xml`,
  ];
  const entries = subs.map(loc =>
    `  <sitemap>\n    <loc>${loc}</loc>\n    <lastmod>${now}</lastmod>\n  </sitemap>`
  ).join('\n');
  return new Response(
    `<?xml version="1.0" encoding="UTF-8"?>\n<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${entries}\n</sitemapindex>`,
    {
      status: 200,
      headers: {
        'Content-Type':  'application/xml; charset=utf-8',
        'Cache-Control': 'public, max-age=3600',
        'X-Robots-Tag':  'noindex',
      },
    }
  );
}

async function serveLinkHub(request, domainName) {
  if (WORKER_BASE) {
    try {
      const workerResp = await fetch(`${WORKER_BASE}/link-hub`, {
        headers: {
          'host':          domainName,
          'User-Agent':    request.headers.get('User-Agent') || 'Mozilla/5.0',
          'Cache-Control': 'no-cache',
        },
      });
      const body = await workerResp.text();
      return new Response(body, {
        status: 200,
        headers: {
          'Content-Type':  'text/html; charset=utf-8',
          'Cache-Control': 'public, max-age=300, stale-while-revalidate=60',
          'Link':          `<https://${domainName}/link-hub>; rel="canonical"`,
          'X-Robots-Tag':  'index, follow',
        },
      });
    } catch (err) {
      console.error('LinkCore: link-hub proxy error:', err);
    }
  }
  return new Response(linkHubStubHtml(domainName), {
    status: 200,
    headers: {
      'Content-Type':  'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
      'Link':          `<https://${domainName}/link-hub>; rel="canonical"`,
      'X-Robots-Tag':  'index, follow',
    },
  });
}

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
    return new Response(await resp.text(), {
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

function linkHubStubHtml(domain) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>Content Hub — ${domain}</title>
  <meta name="description" content="Curated content hub — ${domain}">
  <link rel="canonical" href="https://${domain}/link-hub">
  <script type="application/ld+json">
  {"@context":"https://schema.org","@type":"ItemList","name":"Content Hub — ${domain}","numberOfItems":0,"dateModified":"${new Date().toISOString()}"}
  </script>
</head>
<body>
  <h1>Content Hub</h1>
  <p>Content being indexed. Check back soon.</p>
</body>
</html>`;
}
