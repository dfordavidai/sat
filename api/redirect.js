/**
 * LinkCore — Vercel Edge Function  v18.0
 */

export const config = {
  runtime: 'edge',
};

const FALLBACK_URL = 'https://flexygist.com.ng/';
const WORKER_BASE  = process.env.WORKER_URL || '';

const DOMAIN_REDIRECTS = {
  'guruswapaz.com.ng':              'https://flexygist.com.ng/gist/',
  'www.guruswapaz.com.ng':          'https://flexygist.com.ng/gist/',
  'waecgceexpo.guruswapaz.com.ng':  'https://flexygist.com.ng/naija-news/',
  'jamb.guruswapaz.com.ng':         'https://flexygist.com.ng/naija-news/',
  'jambexporuns.guruswapaz.com.ng': 'https://flexygist.com.ng/naija-news/',
  'mp3fresh.com.ng':                'https://flexygist.com.ng/download-mp3/',
  'www.mp3fresh.com.ng':            'https://flexygist.com.ng/download-mp3/',
  'naijasturf.com.ng':              'https://flexygist.com.ng/viral/',
  'www.naijasturf.com.ng':          'https://flexygist.com.ng/viral/',
};

export default async function handler(request) {
  const url  = new URL(request.url);
  const host = url.hostname.toLowerCase();
  const path = url.pathname;
  const parts = path.split('/').filter(Boolean);

  const SB_URL = process.env.SUPABASE_URL;
  const SB_KEY = process.env.SUPABASE_KEY;

  // ── DOMAIN REDIRECT — fires before anything else ──────────────────────────
  if (DOMAIN_REDIRECTS[host]) {
    const base   = DOMAIN_REDIRECTS[host];
    const suffix = path.replace(/^\//, '');
    const dest   = suffix ? base + suffix : base;
    return new Response(null, {
      status: 301,
      headers: {
        'Location':      dest,
        'Cache-Control': 'no-store',
        'X-Redirect-By': 'LinkCore-DomainRedirect',
      },
    });
  }

  // ── Route: /sitemap-index.xml ─────────────────────────────────────────────
  if (path === '/sitemap-index.xml') {
    return serveSitemapIndex(url);
  }

  // ── Route: /link-hub ──────────────────────────────────────────────────────
  if (path === '/link-hub' || path === '/link-hub/') {
    return serveLinkHub(request, url);
  }

  // ── Route: /api/trigger-drip ──────────────────────────────────────────────
  if (path === '/api/trigger-drip' && request.method === 'POST') {
    return proxyToWorker(request, '/api/submit');
  }

  // ── Route: /link/:code ────────────────────────────────────────────────────
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

    try {
      const t = new URL(target);
      if (!['http:', 'https:'].includes(t.protocol)) throw new Error('bad protocol');
    } catch {
      console.error('LinkCore: corrupt target URL:', target);
      return Response.redirect(FALLBACK_URL, 301);
    }

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

    const domainName = process.env.DOMAIN_NAME || url.hostname;

    fetch(`https://${domainName}/link-hub`, {
      headers: {
        'User-Agent':    'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)',
        'Cache-Control': 'no-cache',
      },
    }).catch(() => {});

    fetch(`https://${domainName}/api/crawl-ping`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ url: target }),
    }).catch(() => {});

    const targetHost = new URL(target).hostname;

    return new Response(null, {
      status: 301,
      headers: {
        'Location':               target,
        'Cache-Control':          'no-store',
        'X-Robots-Tag':           'noindex',
        'X-Redirect-By':          'LinkCore-v19',
        'X-DNS-Prefetch-Control': 'on',
        'Link': [
          `<https://${url.hostname}/link-hub>; rel="preload"; as="document"`,
          `<https://${targetHost}>; rel="preconnect"`,
          `<https://${targetHost}>; rel="dns-prefetch"`,
        ].join(', '),
      },
    });

  } catch (err) {
    console.error('LinkCore redirect error:', err);
    const domainName = process.env.DOMAIN_NAME || url.hostname;
    return Response.redirect(`https://${domainName}/link-hub`, 301);
  }
}

function serveSitemapIndex(url) {
  const thisDomain = process.env.DOMAIN_NAME || url.hostname;
  const now = new Date().toISOString().split('.')[0] + '+00:00';

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
      'X-Robots-Tag':  'noindex',
    },
  });
}

async function serveLinkHub(request, url) {
  const domainName = process.env.DOMAIN_NAME || url.hostname;

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
          'Link':          `<https://${domainName}/link-hub>; rel="canonical"`,
          'X-Robots-Tag':  'index, follow',
          'X-Served-By':   'LinkCore-v16-link-hub',
        },
      });
    } catch (err) {
      console.error('LinkCore: link-hub proxy error:', err);
    }
  }

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
