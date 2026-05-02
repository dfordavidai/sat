/**
 * LinkCore — sitemap.xml Edge Function
 * Serves the per-domain sitemap XML stored in Supabase lc_sitemaps.
 *
 * Deploy to ALL 4 domain repos (same file).
 * Route: /sitemap.xml → /api/sitemap
 *
 * Required env vars (same as redirect.js):
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

  // Derive this domain's hostname from the incoming request
  const host = new URL(request.url).hostname;

  try {
    const res = await fetch(
      `${SB_URL}/rest/v1/lc_sitemaps?domain=eq.${encodeURIComponent(host)}&select=xml,url_count,updated_at&limit=1`,
      { headers: { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}` } }
    );

    if (!res.ok) throw new Error(`Supabase ${res.status}`);

    const rows = await res.json();

    if (!rows || !rows.length || !rows[0].xml) {
      // No sitemap built yet — return a minimal valid one
      const fallback = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
</urlset>`;
      return new Response(fallback, {
        status: 200,
        headers: {
          'Content-Type': 'application/xml; charset=utf-8',
          'Cache-Control': 'public, max-age=3600',
          'X-Sitemap-Status': 'empty',
        },
      });
    }

    const { xml, url_count, updated_at } = rows[0];

    return new Response(xml, {
      status: 200,
      headers: {
        'Content-Type':   'application/xml; charset=utf-8',
        'Cache-Control':  'public, max-age=3600',
        'Last-Modified':  new Date(updated_at).toUTCString(),
        'X-Sitemap-URLs': String(url_count || 0),
      },
    });

  } catch (err) {
    console.error('sitemap.js error:', err);
    return new Response('Error fetching sitemap', { status: 500 });
  }
}
