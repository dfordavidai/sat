/**
 * LinkCore — sitemap.xml Edge Function
 * Serves the per-domain sitemap XML stored in Supabase lc_sitemaps.
 * lastmod is spoofed to now on every serve — signals freshness to Googlebot.
 *
 * Deploy to ALL 4 domain repos (same file).
 * Route: /sitemap.xml → /api/sitemap
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

  try {
    const res = await fetch(
      `${SB_URL}/rest/v1/lc_sitemaps?domain=eq.${encodeURIComponent(host)}&select=xml,url_count,updated_at&limit=1`,
      { headers: { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}` } }
    );

    if (!res.ok) throw new Error(`Supabase ${res.status}`);

    const rows = await res.json();
    const now  = new Date();

    if (!rows || !rows.length || !rows[0].xml) {
      const fallback = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
</urlset>`;
      return new Response(fallback, {
        status: 200,
        headers: {
          'Content-Type':    'application/xml; charset=utf-8',
          'Cache-Control':   'public, max-age=3600',
          'X-Sitemap-Status': 'empty',
        },
      });
    }

    const { xml: rawXml, url_count, updated_at } = rows[0];

    // ── Lastmod Freshness Spoofing ──────────────────────────────────────────
    // Replace every <lastmod> value in the stored XML with today's date.
    // Google treats a changed lastmod as a freshness signal and recrawls faster.
    const today   = now.toISOString().slice(0, 10); // YYYY-MM-DD
    const nowFull = now.toISOString().replace(/\.\d+Z$/, '+00:00');
    // FIX #6: Replace lastmod with today for freshness
    let xml = rawXml.replace(/<lastmod>[^<]*<\/lastmod>/g, `<lastmod>${today}</lastmod>`);
    // NEW #8: Inject Google News sitemap namespace if not present
    xml = xml.replace(
      '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
      '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:news="http://www.google.com/schemas/sitemap-news/0.9">'
    );
    // NEW #8: Inject <news:news> block into each <url> entry for Google News crawler
    xml = xml.replace(/<\/url>/g, (_, offset) => {
      // Extract the <loc> from the preceding <url> block
      const block   = xml.slice(Math.max(0, offset - 500), offset);
      const locMatch = block.match(/<loc>([^<]+)<\/loc>/);
      const loc      = locMatch ? locMatch[1] : '';
      const domain   = loc ? new URL(loc).hostname : 'LinkCore';
      return `  <news:news>
      <news:publication><news:name>${domain}</news:name><news:language>en</news:language></news:publication>
      <news:publication_date>${nowFull}</news:publication_date>
      <news:title>Update: ${domain}</news:title>
    </news:news>
  </url>`;
    });

    // ETag based on url_count + today — changes daily, forcing Googlebot recheck
    const etag = `"lc-sm-${url_count || 0}-${today}"`;

    // ── Conditional GET support (304 Not Modified) ──────────────────────────
    // When Googlebot revisits and sends If-None-Match, honour it.
    // This builds trust — Googlebot crawls pages with reliable cache signals more often.
    const ifNoneMatch = request.headers.get('if-none-match');
    if (ifNoneMatch === etag) {
      return new Response(null, { status: 304 });
    }

    return new Response(xml, {
      status: 200,
      headers: {
        'Content-Type':    'application/xml; charset=utf-8',
        'Cache-Control':   'public, max-age=3600, stale-while-revalidate=300',
        'Last-Modified':   now.toUTCString(),
        'ETag':            etag,
        'X-Sitemap-URLs':  String(url_count || 0),
      },
    });

  } catch (err) {
    console.error('sitemap.js error:', err);
    return new Response('Error fetching sitemap', { status: 500 });
  }
}
