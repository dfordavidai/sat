/**
 * LinkCore — feed.xml Edge Function
 * Serves the per-domain Atom feed stored in Supabase lc_config.
 *
 * Deploy to ALL 4 domain repos (same file).
 * Route: /feed.xml → /api/feed
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
  // lc_config key format: feed_xml_flexygist_com_ng
  const cfgKey = `feed_xml_${host.replace(/\./g, '_')}`;

  try {
    const res = await fetch(
      `${SB_URL}/rest/v1/lc_config?key=eq.${encodeURIComponent(cfgKey)}&select=value,updated_at&limit=1`,
      { headers: { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}` } }
    );

    if (!res.ok) throw new Error(`Supabase ${res.status}`);

    const rows = await res.json();

    if (!rows || !rows.length || !rows[0].value) {
      // No feed built yet — return a minimal valid Atom feed
      const fallback = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <title>LinkCore — ${host}</title>
  <id>https://${host}/feed.xml</id>
  <link href="https://${host}/feed.xml" rel="self"/>
  <updated>${new Date().toISOString()}</updated>
</feed>`;
      return new Response(fallback, {
        status: 200,
        headers: {
          'Content-Type': 'application/atom+xml; charset=utf-8',
          'Cache-Control': 'public, max-age=3600',
          'X-Feed-Status': 'empty',
        },
      });
    }

    const { value: xml, updated_at } = rows[0];

    return new Response(xml, {
      status: 200,
      headers: {
        'Content-Type':  'application/atom+xml; charset=utf-8',
        'Cache-Control': 'public, max-age=3600',
        'Last-Modified': new Date(updated_at).toUTCString(),
      },
    });

  } catch (err) {
    console.error('feed.js error:', err);
    return new Response('Error fetching feed', { status: 500 });
  }
}
