/**
 * LinkCore — sitemap-links.xml Edge Function
 * Serves a per-domain sitemap of ALL destination URLs stored in ic_short_links.
 *
 * This is the missing companion to sitemap.xml. While sitemap.xml lists your
 * OWN pages (stored in lc_sitemaps), sitemap-links.xml lists every destination
 * URL that has been blasted through the indexer — giving Google a direct XML
 * signal for every target URL via YOUR trusted domain's sitemap.
 *
 * Deploy to ALL 4 domain repos (same file).
 * Route: /sitemap-links.xml → /api/sitemap-links   ← add this to vercel.json
 *
 * Data source: ic_short_links table (same as link-hub.js)
 *   columns used: target (the destination URL), created_at
 *
 * Required env vars:
 *   SUPABASE_URL
 *   SUPABASE_KEY
 *
 * Optional env vars:
 *   DOMAIN_NAME  — canonical domain (falls back to request hostname)
 */

export const config = { runtime: 'edge' };

// Sitemap protocol hard limit — never exceed this
const SITEMAP_URL_LIMIT = 50_000;

export default async function handler(request) {
  const SB_URL = process.env.SUPABASE_URL;
  const SB_KEY = process.env.SUPABASE_KEY;

  if (!SB_URL || !SB_KEY) {
    return new Response('Server misconfigured', { status: 500 });
  }

  const url  = new URL(request.url);
  const host = process.env.DOMAIN_NAME || url.hostname;
  const now  = new Date();

  try {
    // Pull all destination URLs from ic_short_links.
    // No domain filter — every short link target is a URL we want indexed,
    // regardless of which domain the /link/:code lives on.
    const res = await fetch(
      `${SB_URL}/rest/v1/ic_short_links?select=target,created_at&order=created_at.desc&limit=${SITEMAP_URL_LIMIT}`,
      { headers: { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}` } }
    );

    if (!res.ok) throw new Error(`Supabase ${res.status}`);

    const rows = await res.json();
    const today = now.toISOString().slice(0, 10); // YYYY-MM-DD

    if (!rows || !rows.length) {
      // No URLs yet — return a valid empty sitemap (not a 404)
      const empty = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
</urlset>`;
      return new Response(empty, {
        status: 200,
        headers: {
          'Content-Type':      'application/xml; charset=utf-8',
          'Cache-Control':     'public, max-age=1800',
          'X-Sitemap-Status':  'empty',
          'X-Sitemap-URLs':    '0',
        },
      });
    }

    // Deduplicate targets — same destination may have multiple short codes
    const seen    = new Set();
    const targets = [];
    for (const row of rows) {
      const t = row.target?.trim();
      if (t && !seen.has(t)) {
        seen.add(t);
        targets.push({ url: t, date: row.created_at });
      }
      if (targets.length >= SITEMAP_URL_LIMIT) break;
    }

    // Build URL entries — use created_at as lastmod for accuracy,
    // but also replace with today so Googlebot always sees a fresh signal.
    const urlEntries = targets.map(({ url: u, date }) => {
      // Escape XML special chars in the URL
      const loc     = u.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
      const lastmod = date ? date.slice(0, 10) : today;
      return `  <url>
    <loc>${loc}</loc>
    <lastmod>${today}</lastmod>
    <changefreq>weekly</changefreq>
    <priority>0.6</priority>
  </url>`;
    }).join('\n');

    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urlEntries}
</urlset>`;

    // ETag: changes when URL count changes or date changes — forces Googlebot recheck
    const etag = `"lc-sl-${targets.length}-${today}"`;

    // Honour conditional GET (304) — builds crawl trust with Googlebot
    const ifNoneMatch = request.headers.get('if-none-match');
    if (ifNoneMatch === etag) {
      return new Response(null, { status: 304 });
    }

    return new Response(xml, {
      status: 200,
      headers: {
        'Content-Type':    'application/xml; charset=utf-8',
        'Cache-Control':   'public, max-age=1800, stale-while-revalidate=300',
        'Last-Modified':   now.toUTCString(),
        'ETag':            etag,
        'X-Sitemap-URLs':  String(targets.length),
      },
    });

  } catch (err) {
    console.error('sitemap-links.js error:', err);
    return new Response('Error generating sitemap-links', { status: 500 });
  }
}
