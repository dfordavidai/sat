/**
 * LinkCore — /link-hub Edge Function  (Enhancement #4 + #7)
 * Renders ALL short links as real <a href> tags on a Googlebot-trusted page.
 * When Google crawls this page and sees new <a href> links it hasn't seen,
 * it follows them within MINUTES — faster than any API submission.
 *
 * Also implements the /crawl-hub route (same content, different path) for
 * internal-link injection strategy.
 *
 * Deploy to ALL 4 domain repos (same file).
 * Routes: /link-hub → /api/link-hub
 *         /crawl-hub → /api/link-hub
 *
 * Required env vars:
 *   SUPABASE_URL
 *   SUPABASE_KEY
 */

export const config = { runtime: 'edge' };

export default async function handler(request) {
  const SB_URL = process.env.SUPABASE_URL;
  const SB_KEY = process.env.SUPABASE_KEY;

  if (!SB_URL || !SB_KEY) {
    return new Response('Server misconfigured', { status: 500 });
  }

  const host = new URL(request.url).hostname;
  const now  = new Date();

  try {
    // Fetch ALL short link codes from Supabase (no domain filter — every code
    // is shared across all 4 domains via the ic_short_links table)
    const res = await fetch(
      `${SB_URL}/rest/v1/ic_short_links?select=code,target&order=code.asc&limit=5000`,
      { headers: { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}` } }
    );

    if (!res.ok) throw new Error(`Supabase ${res.status}`);

    const rows = await res.json();

    // Build HTML with every short link as a real <a href> — Googlebot follows these
    const linkRows = (rows || []).map(r => {
      const shortUrl = `https://${host}/link/${r.code}`;
      // Include both the short URL AND destination as anchor pairs
      return `    <li>
      <a href="${esc(shortUrl)}" rel="nofollow">${esc(shortUrl)}</a>
      → <a href="${esc(r.target)}">${esc(r.target.slice(0, 80))}${r.target.length > 80 ? '…' : ''}</a>
    </li>`;
    }).join('\n');

    const totalLinks = rows?.length || 0;
    const lastmod    = now.toISOString();

    // JSON-LD schema: Article + ItemList for Google Discover / Rich Results
    // (Enhancement #2) — signals to Googlebot's Discover crawler
    const schema = JSON.stringify({
      '@context': 'https://schema.org',
      '@type': 'CollectionPage',
      name: `LinkCore Hub — ${host}`,
      description: `Active link directory for ${host} — ${totalLinks} verified URLs`,
      url: `https://${host}/link-hub`,
      dateModified: lastmod,
      mainEntity: {
        '@type': 'ItemList',
        numberOfItems: totalLinks,
        itemListElement: (rows || []).slice(0, 100).map((r, i) => ({
          '@type': 'ListItem',
          position: i + 1,
          url: `https://${host}/link/${r.code}`,
        })),
      },
    });

    const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Link Hub — ${host}</title>
  <meta name="description" content="Active link directory — ${totalLinks} URLs indexed on ${now.toDateString()}">
  <link rel="canonical" href="https://${host}/link-hub">
  <link rel="alternate" type="application/atom+xml" href="https://${host}/feed.xml">
  <!-- NEW #9: DNS prefetch for all destination domains -->
  ${destDomains.map(d => `<link rel="dns-prefetch" href="//${d}">`).join('\n  ')}
  <!-- ItemList schema -->
  <script type="application/ld+json">${itemListSchema}</script>
  <!-- NEW #4: NewsArticle schema — triggers Google News crawler (sub-5-min cycle) -->
  <script type="application/ld+json">${newsSchema}</script>
  <style>
    body { font-family: system-ui, sans-serif; max-width: 900px; margin: 40px auto; padding: 0 20px; color: #333; }
    h1 { font-size: 1.4rem; border-bottom: 2px solid #e5e5e5; padding-bottom: 12px; }
    .meta { font-size: 0.8rem; color: #888; margin-bottom: 24px; }
    ul { list-style: none; padding: 0; }
    li { padding: 6px 0; border-bottom: 1px solid #f3f3f3; font-size: 0.82rem; word-break: break-all; }
    a { color: #2563eb; text-decoration: none; }
    a:hover { text-decoration: underline; }
    .updated { font-size: 0.72rem; color: #aaa; margin-top: 32px; }
  </style>
</head>
<body>
  <h1>🔗 Link Hub — ${host}</h1>
  <p class="meta">
    <strong>${totalLinks}</strong> active links &nbsp;·&nbsp;
    Last updated: <time datetime="${lastmod}">${now.toUTCString()}</time> &nbsp;·&nbsp;
    <a href="/sitemap.xml">sitemap.xml</a> &nbsp;·&nbsp;
    <a href="/feed.xml">feed.xml</a>
  </p>
  <ul>
${linkRows}
  </ul>
  <p class="updated">Auto-updated on every new link add. Powered by LinkCore.</p>
</body>
</html>`;

    return new Response(html, {
      status: 200,
      headers: {
        'Content-Type':  'text/html; charset=utf-8',
        // Allow Googlebot to index this page and follow links
        'X-Robots-Tag':  'index, follow',
        // Freshness signals — Googlebot uses these to schedule recrawl
        'Last-Modified': now.toUTCString(),
        'ETag':          `"lc-hub-${totalLinks}-${Math.floor(now.getTime() / 60000)}"`,
        'Cache-Control': 'public, max-age=300, stale-while-revalidate=60',
        'Vary':          'Accept-Encoding',
      },
    });

  } catch (err) {
    console.error('link-hub error:', err);
    return new Response('Error generating link hub', { status: 500 });
  }
}

function esc(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
