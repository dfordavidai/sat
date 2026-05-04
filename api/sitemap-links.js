/**
 * LinkCore — sitemap-links.xml Edge Function
 * Serves a per-domain sitemap of YOUR OWN short link URLs (/link/:code).
 *
 * IMPORTANT — Google cross-domain rule:
 *   A sitemap on flexygist.com.ng can ONLY list URLs on flexygist.com.ng.
 *   Listing destination URLs (pastelink.net, etc.) here would be silently
 *   ignored or flagged as a cross-domain error in GSC.
 *
 *   CORRECT: https://flexygist.com.ng/link/owwdb6k7  ← your page, 301s to dest
 *   WRONG:   https://pastelink.net/owwdb6k7          ← someone else's domain
 *
 *   By listing /link/:code URLs, Google crawls YOUR short link pages,
 *   follows the 301 redirect, and credits the destination with a crawl signal
 *   originating from your trusted domain. That's the whole point.
 *
 * Deploy to ALL 4 domain repos (same file).
 * Route: /sitemap-links.xml → /api/sitemap-links   (in vercel.json)
 *
 * Data source: ic_short_links table — columns: code, created_at
 *
 * Required env vars:
 *   SUPABASE_URL
 *   SUPABASE_KEY
 *
 * Optional env vars:
 *   DOMAIN_NAME  — canonical domain (falls back to request hostname)
 */

export const config = { runtime: 'edge' };

const SITEMAP_URL_LIMIT = 50_000;

export default async function handler(request) {
  const SB_URL = process.env.SUPABASE_URL;
  const SB_KEY = process.env.SUPABASE_KEY;

  if (!SB_URL || !SB_KEY) {
    return new Response('Server misconfigured', { status: 500 });
  }

  const url   = new URL(request.url);
  const host  = process.env.DOMAIN_NAME || url.hostname;
  const now   = new Date();
  const today = now.toISOString().slice(0, 10);

  try {
    // Fetch short link codes — NOT targets.
    // We build https://{host}/link/{code} — URLs that live on THIS domain.
    const res = await fetch(
      `${SB_URL}/rest/v1/ic_short_links?select=code,created_at&order=created_at.desc&limit=${SITEMAP_URL_LIMIT}`,
      { headers: { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}` } }
    );

    if (!res.ok) throw new Error(`Supabase ${res.status}`);

    const rows = await res.json();

    if (!rows || !rows.length) {
      const empty = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
</urlset>`;
      return new Response(empty, {
        status: 200,
        headers: {
          'Content-Type':     'application/xml; charset=utf-8',
          'Cache-Control':    'public, max-age=1800',
          'X-Sitemap-Status': 'empty',
          'X-Sitemap-URLs':   '0',
        },
      });
    }

    // Build /link/:code URLs — all on THIS domain, Google will accept them
    const urlEntries = rows.map(row => {
      const shortUrl = `https://${host}/link/${row.code}`;
      const lastmod  = row.created_at ? row.created_at.slice(0, 10) : today;
      return `  <url>
    <loc>${shortUrl}</loc>
    <lastmod>${lastmod}</lastmod>
    <changefreq>monthly</changefreq>
    <priority>0.4</priority>
  </url>`;
    }).join('\n');

    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urlEntries}
</urlset>`;

    const etag = `"lc-sl-${rows.length}-${today}"`;

    const ifNoneMatch = request.headers.get('if-none-match');
    if (ifNoneMatch === etag) {
      return new Response(null, { status: 304 });
    }

    return new Response(xml, {
      status: 200,
      headers: {
        'Content-Type':   'application/xml; charset=utf-8',
        'Cache-Control':  'public, max-age=1800, stale-while-revalidate=300',
        'Last-Modified':  now.toUTCString(),
        'ETag':           etag,
        'X-Sitemap-URLs': String(rows.length),
      },
    });

  } catch (err) {
    console.error('sitemap-links.js error:', err);
    return new Response('Error generating sitemap-links', { status: 500 });
  }
}
