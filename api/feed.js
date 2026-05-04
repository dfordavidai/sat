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
 *
 * CHANGES:
 *   Added Link: rel="hub" + rel="self" headers to both responses.
 *   This tells Googlebot to subscribe to PubSubHubbub push notifications
 *   instead of polling — so when crawl-ping fires M4, Google is already
 *   listening and processes the ping in seconds, not minutes.
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

  // Link header — tells Googlebot about the PubSub hub and self URL.
  // Googlebot reads this and subscribes for push notifications.
  const linkHeader = '<https://pubsubhubbub.appspot.com/>; rel="hub", ' +
                     `<https://${host}/feed.xml>; rel="self"`;

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
          'Content-Type':  'application/atom+xml; charset=utf-8',
          'Cache-Control': 'public, max-age=3600',
          'X-Feed-Status': 'empty',
          'Link':          linkHeader,
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
        'Link':          linkHeader,
      },
    });

  } catch (err) {
    console.error('feed.js error:', err);
    return new Response('Error fetching feed', { status: 500 });
  }
}
