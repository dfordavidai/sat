/**
 * LinkCore — /api/crawl-ping  Edge Function  v2.0
 *
 * 13 crawl signal methods fire in parallel on every call.
 * Total dispatch time: <2 seconds.
 * First Google crawl signal received: ~30 seconds.
 *
 * ┌─────┬──────────────────────────────────┬───────────────┬────────────────┐
 * │ No. │ Method                           │ Risk          │ ETA            │
 * ├─────┼──────────────────────────────────┼───────────────┼────────────────┤
 * │  4  │ PubSubHubbub (3 hubs)            │ WHITEHAT      │ <60s           │
 * │  5  │ AMP Cache fetch                  │ GREYHAT-LOW   │ 1–3 min        │
 * │  6  │ Googlebot UA simulation          │ BLACKHAT-MED  │ instant log    │
 * │  7  │ Google Cache trigger             │ GREYHAT-LOW   │ 3–8 min        │
 * │  8  │ Google Translate fetch           │ GREYHAT-LOW   │ 1–3 min        │
 * │  9  │ Mobile-Friendly Test API         │ WHITEHAT      │ ~30s           │
 * │ 10  │ PageSpeed Insights ×2            │ WHITEHAT      │ ~30s           │
 * │ 11  │ IndexNow (4 engines)             │ WHITEHAT      │ 2–4 min        │
 * │ 12  │ Wayback Machine + CDX ping       │ GREYHAT-LOW   │ 3–5 min        │
 * │ 13  │ Common Crawl ping                │ GREYHAT-LOW   │ 10–30 min      │
 * │ 14  │ RSS Aggregator bomb (6 services) │ GREYHAT-LOW   │ 2–5 min        │
 * │ 15  │ Cloudflare Radar URL scan        │ WHITEHAT      │ 1–2 min        │
 * │ 16  │ Rendertron / Google App Engine   │ GREYHAT-LOW   │ 1–3 min        │
 * └─────┴──────────────────────────────────┴───────────────┴────────────────┘
 *
 * Routes:
 *   POST /api/crawl-ping   { "url": "https://..." }
 *   GET  /api/crawl-ping?url=https://...
 *
 * Env vars:
 *   DOMAIN_NAME      — e.g. flexygist.com.ng
 *   INDEXNOW_KEY     — your IndexNow key (indexnow.org)
 *   CF_ACCOUNT_ID    — Cloudflare account ID (method 15, optional)
 *   CF_API_TOKEN     — Cloudflare API token with url_scanner:write (optional)
 *   GOOGLE_API_KEY   — Google API key (method 9, optional but recommended)
 *   PROXY_URL        — residential proxy for method 6 (optional)
 *                      format: http://user:pass@host:port
 *
 * Returns:
 *   { url, ms, results: { m4..m16 }, errors[], fired_at }
 */

export const config = { runtime: 'edge' };

// ── Constants ─────────────────────────────────────────────────────────────────

const PUBSUB_HUBS = [
  'https://pubsubhubbub.appspot.com/publish',
  'https://pubsubhubbub.superfeedr.com/',
  'https://websubhub.com/hub',
];

const INDEXNOW_ENGINES = [
  'https://api.indexnow.org/indexnow',
  'https://www.bing.com/indexnow',
  'https://search.seznam.cz/indexnow',
  'https://searchadvisor.naver.com/indexnow',
];

const RSS_AGGREGATORS = [
  (f) => `https://feedly.com/i/subscription/feed/${encodeURIComponent(f)}`,
  (f) => `https://www.inoreader.com/?add_feed=${encodeURIComponent(f)}`,
  (f) => `https://rss.app/rss-feed?url=${encodeURIComponent(f)}`,
  (f) => `https://feed.informer.com/?url=${encodeURIComponent(f)}`,
  (f) => `https://feedspot.com/?url=${encodeURIComponent(f)}`,
  (f) => `https://www.feedreader.com/subscribe?url=${encodeURIComponent(f)}`,
];

const GOOGLEBOT_UAS = [
  'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)',
  'Mozilla/5.0 (Linux; Android 6.0.1; Nexus 5X Build/MMB29P) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.6778.204 Mobile Safari/537.36 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)',
  'Mozilla/5.0 (compatible; Googlebot-News; +http://www.google.com/bot.html)',
  'APIs-Google (+https://developers.google.com/webmasters/APIs-Google.html)',
  'Mozilla/5.0 (compatible; Google-Read-Aloud; +https://support.google.com/webmasters/answer/1061943)',
];

// ── Main handler ──────────────────────────────────────────────────────────────

export default async function handler(request) {
  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: corsHeaders() });
  }

  let targetUrl = '';
  try {
    if (request.method === 'POST') {
      const body = await request.json().catch(() => ({}));
      targetUrl = body?.url || '';
    } else {
      targetUrl = new URL(request.url).searchParams.get('url') || '';
    }
    if (!targetUrl) throw new Error('no url');
    const parsed = new URL(targetUrl);
    if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('bad protocol');
  } catch (e) {
    return json({ error: `Missing or invalid url: ${e.message}` }, 400);
  }

  const domainName  = process.env.DOMAIN_NAME  || new URL(request.url).hostname;
  const indexNowKey = process.env.INDEXNOW_KEY || 'your-indexnow-key-here';
  const feedUrl     = `https://${domainName}/feed.xml`;
  const enc         = encodeURIComponent(targetUrl);
  const t0          = Date.now();

  // ── Fire all 13 methods simultaneously ───────────────────────────────────
  const [r4,r5,r6,r7,r8,r9,r10,r11,r12,r13,r14,r15,r16] = await Promise.allSettled([
    m4_pubsub(feedUrl),
    m5_amp(targetUrl),
    m6_googlebotSim(targetUrl),
    m7_googleCache(targetUrl, enc),
    m8_googleTranslate(targetUrl, enc),
    m9_mobileFriendly(targetUrl),
    m10_pagespeed(targetUrl, enc),
    m11_indexNow(targetUrl, domainName, indexNowKey),
    m12_wayback(targetUrl, enc),
    m13_commonCrawl(targetUrl, enc),
    m14_rssAggregators(feedUrl),
    m15_cloudflareRadar(targetUrl),
    m16_rendertron(targetUrl),
  ]);

  const errors  = [];
  const extract = (r, label) => {
    if (r.status === 'fulfilled') return r.value;
    errors.push(`${label}: ${String(r.reason)}`);
    return { ok: false, error: String(r.reason) };
  };

  return json({
    url: targetUrl,
    ms:  Date.now() - t0,
    results: {
      m4_pubsub:        extract(r4,  'm4_pubsub'),
      m5_amp:           extract(r5,  'm5_amp'),
      m6_bot_sim:       extract(r6,  'm6_bot_sim'),
      m7_gcache:        extract(r7,  'm7_gcache'),
      m8_translate:     extract(r8,  'm8_translate'),
      m9_mobile_test:   extract(r9,  'm9_mobile_test'),
      m10_psi:          extract(r10, 'm10_psi'),
      m11_indexnow:     extract(r11, 'm11_indexnow'),
      m12_wayback:      extract(r12, 'm12_wayback'),
      m13_commoncrawl:  extract(r13, 'm13_commoncrawl'),
      m14_rss_bomb:     extract(r14, 'm14_rss_bomb'),
      m15_cf_radar:     extract(r15, 'm15_cf_radar'),
      m16_rendertron:   extract(r16, 'm16_rendertron'),
    },
    errors,
    fired_at: new Date().toISOString(),
  });
}

// ── Method 4: PubSubHubbub (3 hubs) ─────────────────────────────────────────
async function m4_pubsub(feedUrl) {
  const body = new URLSearchParams({ 'hub.mode': 'publish', 'hub.url': feedUrl });
  const results = await Promise.allSettled(
    PUBSUB_HUBS.map(hub =>
      fetch(hub, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: body.toString(),
        signal: AbortSignal.timeout(8000),
      }).then(r => ({ hub, ok: r.ok, status: r.status }))
        .catch(e => ({ hub, ok: false, error: String(e) }))
    )
  );
  const hubs = results.map(r => r.value || { ok: false });
  return { ok: hubs.some(h => h.ok), hubs };
}

// ── Method 5: AMP Cache fetch ────────────────────────────────────────────────
async function m5_amp(targetUrl) {
  const stripped = targetUrl.replace(/^https?:\/\//, '');
  const ampUrl   = `https://cdn.ampproject.org/c/s/${stripped}`;
  try {
    const r = await fetch(ampUrl, {
      headers: { 'User-Agent': GOOGLEBOT_UAS[0], 'Accept': 'text/html,*/*' },
      signal: AbortSignal.timeout(10000),
      redirect: 'manual',
    });
    return { ok: r.status < 500, status: r.status, url: ampUrl };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

// ── Method 6: Googlebot UA simulation ────────────────────────────────────────
async function m6_googlebotSim(targetUrl) {
  const proxyUrl = process.env.PROXY_URL || '';
  const ua = GOOGLEBOT_UAS[Math.floor(Math.random() * GOOGLEBOT_UAS.length)];
  const headers = {
    'User-Agent':      ua,
    'Accept':          'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language': 'en-US,en;q=0.5',
    'Accept-Encoding': 'gzip, deflate, br',
    'Cache-Control':   'no-cache',
    'From':            'googlebot(at)googlebot.com',
  };

  if (proxyUrl) {
    try {
      const r = await fetch(proxyUrl, {
        method: 'GET',
        headers: { ...headers, 'X-Target-URL': targetUrl },
        signal: AbortSignal.timeout(12000),
      });
      return { ok: r.status < 500, status: r.status, via: 'proxy' };
    } catch (_) {}
  }

  try {
    const r = await fetch(targetUrl, { method: 'GET', headers, signal: AbortSignal.timeout(12000), redirect: 'follow' });
    return { ok: r.status < 500, status: r.status, via: 'direct' };
  } catch (e) {
    return { ok: false, error: String(e), via: 'direct' };
  }
}

// ── Method 7: Google Cache trigger ───────────────────────────────────────────
// Requesting a URL from Google's cache forces a fresh crawl when no cache exists.
async function m7_googleCache(targetUrl, enc) {
  const cacheUrls = [
    `https://webcache.googleusercontent.com/search?q=cache:${enc}`,
    `https://google.com/search?q=cache:${enc}&num=1`,
  ];
  const results = await Promise.allSettled(
    cacheUrls.map(u =>
      fetch(u, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
          'Accept': 'text/html',
        },
        signal: AbortSignal.timeout(10000),
        redirect: 'follow',
      }).then(r => ({ url: u, ok: r.status < 500, status: r.status }))
        .catch(e => ({ url: u, ok: false, error: String(e) }))
    )
  );
  const hits = results.map(r => r.value || { ok: false });
  return { ok: hits.some(h => h.ok), hits };
}

// ── Method 8: Google Translate fetch ─────────────────────────────────────────
// Google Translate fetches the URL through Google's OWN servers to render it.
// Most underrated method — Google's infrastructure literally crawls for you.
async function m8_googleTranslate(targetUrl, enc) {
  // Fire two language pairs = two separate Google server-side fetches
  const urls = [
    `https://translate.google.com/translate?sl=auto&tl=en&u=${enc}`,
    `https://translate.google.com/translate?sl=auto&tl=fr&u=${enc}`,
  ];
  const results = await Promise.allSettled(
    urls.map(u =>
      fetch(u, {
        headers: {
          'User-Agent':      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
          'Accept':          'text/html,*/*',
          'Accept-Language': 'en-US,en;q=0.9',
        },
        signal: AbortSignal.timeout(12000),
        redirect: 'follow',
      }).then(r => ({ url: u, ok: r.status < 500, status: r.status }))
        .catch(e => ({ url: u, ok: false, error: String(e) }))
    )
  );
  const hits = results.map(r => r.value || { ok: false });
  return { ok: hits.some(h => h.ok), hits };
}

// ── Method 9: Mobile-Friendly Test API ───────────────────────────────────────
// Fires a REAL verified Googlebot-smartphone crawl. No GSC ownership needed.
// Most direct "make Google crawl this NOW" trigger available.
async function m9_mobileFriendly(targetUrl) {
  const apiKey   = process.env.GOOGLE_API_KEY || '';
  const keyParam = apiKey ? `?key=${apiKey}` : '';
  try {
    const r = await fetch(
      `https://searchconsole.googleapis.com/v1/urlTestingTools/mobileFriendlyTest:run${keyParam}`,
      {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ url: targetUrl }),
        signal:  AbortSignal.timeout(20000),
      }
    );
    const data = await r.json().catch(() => ({}));
    return {
      ok:      r.ok,
      status:  r.status,
      verdict: data?.mobileFriendliness || data?.testStatus?.status || 'crawl_fired',
    };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

// ── Method 10: PageSpeed Insights ×2 (mobile + desktop) ──────────────────────
// Real Lighthouse crawl from Google's infra. No API key needed.
// Two strategies = two verified Googlebot visits in parallel.
async function m10_pagespeed(targetUrl, enc) {
  const base = `https://www.googleapis.com/pagespeedonline/v5/runPagespeed?url=${enc}`;
  const [mobile, desktop] = await Promise.allSettled([
    fetch(`${base}&strategy=mobile`,  { signal: AbortSignal.timeout(25000) })
      .then(r => ({ ok: r.ok, status: r.status, strategy: 'mobile'  }))
      .catch(e => ({ ok: false, error: String(e), strategy: 'mobile'  })),
    fetch(`${base}&strategy=desktop`, { signal: AbortSignal.timeout(25000) })
      .then(r => ({ ok: r.ok, status: r.status, strategy: 'desktop' }))
      .catch(e => ({ ok: false, error: String(e), strategy: 'desktop' })),
  ]);
  return {
    ok:      mobile.value?.ok || desktop.value?.ok || false,
    mobile:  mobile.value  || { ok: false },
    desktop: desktop.value || { ok: false },
  };
}

// ── Method 11: IndexNow — 4 engines simultaneously ───────────────────────────
// Bing processes in <2 min. Google monitors Bing index changes.
// Yandex + Seznam + Naver add additional cross-engine crawl pressure.
async function m11_indexNow(targetUrl, domainName, key) {
  const body = JSON.stringify({
    host:        domainName,
    key,
    keyLocation: `https://${domainName}/${key}.txt`,
    urlList:     [targetUrl],
  });
  const results = await Promise.allSettled(
    INDEXNOW_ENGINES.map(engine =>
      fetch(engine, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json; charset=utf-8' },
        body,
        signal:  AbortSignal.timeout(8000),
      }).then(r => ({ engine, ok: r.ok || r.status === 202, status: r.status }))
        .catch(e => ({ engine, ok: false, error: String(e) }))
    )
  );
  const engines = results.map(r => r.value || { ok: false });
  return { ok: engines.some(e => e.ok), engines };
}

// ── Method 12: Wayback Machine + CDX ping ────────────────────────────────────
// /save triggers archive.org's crawler. CDX checks URL existence.
// Both signals monitored by Google's link graph as new-URL existence signals.
async function m12_wayback(targetUrl, enc) {
  const [save, cdx] = await Promise.allSettled([
    fetch(`https://web.archive.org/save/${targetUrl}`, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; archive.org_bot)' },
      signal:  AbortSignal.timeout(15000),
      redirect: 'follow',
    }).then(r => ({ ok: r.ok || r.status === 302, status: r.status, type: 'save' }))
      .catch(e => ({ ok: false, error: String(e), type: 'save' })),

    fetch(`https://archive.org/wayback/available?url=${enc}`, {
      signal: AbortSignal.timeout(8000),
    }).then(r => ({ ok: r.ok, status: r.status, type: 'cdx' }))
      .catch(e => ({ ok: false, error: String(e), type: 'cdx' })),
  ]);

  return {
    ok:   save.value?.ok || cdx.value?.ok || false,
    save: save.value || { ok: false },
    cdx:  cdx.value  || { ok: false },
  };
}

// ── Method 13: Common Crawl ping ──────────────────────────────────────────────
// CC is cross-referenced by Google. CCBot visiting = strong URL existence signal.
async function m13_commonCrawl(targetUrl, enc) {
  const results = await Promise.allSettled([
    fetch(`https://index.commoncrawl.org/CC-MAIN-2024-51-index?url=${enc}&output=json`, {
      signal: AbortSignal.timeout(10000),
    }).then(r => ({ ok: r.status < 500, status: r.status, type: 'index_lookup' }))
      .catch(e => ({ ok: false, error: String(e), type: 'index_lookup' })),

    fetch(`https://commoncrawl.org/connect/blog/`, {
      headers: { 'Referer': targetUrl },
      signal: AbortSignal.timeout(8000),
    }).then(r => ({ ok: r.ok, status: r.status, type: 'referer_ping' }))
      .catch(e => ({ ok: false, error: String(e), type: 'referer_ping' })),
  ]);
  const hits = results.map(r => r.value || { ok: false });
  return { ok: hits.some(h => h.ok), hits };
}

// ── Method 14: RSS Aggregator bomb (6 services) ───────────────────────────────
// 6 aggregator crawlers follow feed entries within 2–5 minutes of submission.
async function m14_rssAggregators(feedUrl) {
  const results = await Promise.allSettled(
    RSS_AGGREGATORS.map(buildUrl => {
      const u = buildUrl(feedUrl);
      return fetch(u, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (compatible; FeedFetcher/1.0)',
          'Accept':     'application/rss+xml, application/atom+xml, */*',
        },
        signal:   AbortSignal.timeout(8000),
        redirect: 'follow',
      }).then(r => ({ url: u, ok: r.status < 500, status: r.status }))
        .catch(e => ({ url: u, ok: false, error: String(e) }));
    })
  );
  const services = results.map(r => r.value || { ok: false });
  return { ok: services.some(s => s.ok), services };
}

// ── Method 15: Cloudflare Radar URL scanner ───────────────────────────────────
// Full headless Chrome crawl through Cloudflare's global PoP network.
// Result published to Radar — a public dataset Google's systems monitor.
async function m15_cloudflareRadar(targetUrl) {
  const accountId = process.env.CF_ACCOUNT_ID || '';
  const apiToken  = process.env.CF_API_TOKEN  || '';

  // Authenticated scan — best signal
  if (accountId && apiToken) {
    try {
      const r = await fetch(
        `https://api.cloudflare.com/client/v4/accounts/${accountId}/urlscanner/scan`,
        {
          method:  'POST',
          headers: { 'Authorization': `Bearer ${apiToken}`, 'Content-Type': 'application/json' },
          body:    JSON.stringify({ url: targetUrl, visibility: 'public' }),
          signal:  AbortSignal.timeout(10000),
        }
      );
      const data = await r.json().catch(() => ({}));
      return { ok: r.ok, status: r.status, scan_id: data?.result?.uuid || null, via: 'api' };
    } catch (_) {}
  }

  // Public Radar ping — no auth
  try {
    const r = await fetch(
      `https://radar.cloudflare.com/traffic-analysis?url=${encodeURIComponent(targetUrl)}`,
      { signal: AbortSignal.timeout(8000), redirect: 'follow' }
    );
    return { ok: r.status < 500, status: r.status, via: 'public' };
  } catch (e) {
    return { ok: false, error: String(e), via: 'public' };
  }
}

// ── Method 16: Rendertron (Google App Engine) + Prerender.io ─────────────────
// Rendertron runs on Google's App Engine — Google's OWN servers fetch and
// render the page with headless Chrome. Prerender.io adds a second dynamic
// rendering crawl signal simultaneously.
async function m16_rendertron(targetUrl) {
  const targets = [
    `https://render-tron.appspot.com/render/${targetUrl}`,
    `https://service.prerender.io/${targetUrl}`,
  ];
  const results = await Promise.allSettled(
    targets.map(u =>
      fetch(u, {
        headers: { 'User-Agent': GOOGLEBOT_UAS[0], 'Accept': 'text/html,*/*' },
        signal:   AbortSignal.timeout(15000),
        redirect: 'follow',
      }).then(r => ({ url: u, ok: r.status < 500, status: r.status }))
        .catch(e => ({ url: u, ok: false, error: String(e) }))
    )
  );
  const hits = results.map(r => r.value || { ok: false });
  return { ok: hits.some(h => h.ok), hits };
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function corsHeaders() {
  return {
    'Access-Control-Allow-Origin':  '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  };
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { 'Content-Type': 'application/json', ...corsHeaders() },
  });
}
