/**
 * LinkCore — Vercel Edge Function
 * Server-side 301 redirect: /link/:code → original URL
 *
 * Deploy this to ALL 4 domain repos (same file, same code).
 * Set these environment variables in each Vercel project:
 *   SUPABASE_URL  = https://xxxxxxxxxx.supabase.co
 *   SUPABASE_KEY  = your-anon-key
 *
 * How it works:
 *   1. Extracts :code from the URL path
 *   2. Queries Supabase ic_short_links for the target URL
 *   3. Returns HTTP 301 → Google follows it, indexes destination
 *   4. Falls back to a branded 404 if code not found
 */

export const config = {
  runtime: 'edge',
};

const FALLBACK_URL = 'https://flexygist.com.ng/'; // change per domain if desired

export default async function handler(request) {
  const url   = new URL(request.url);
  const parts = url.pathname.split('/').filter(Boolean);
  // Expect path: /link/:code  → parts = ['link', 'CODE']
  const code  = parts[1] || parts[0] || '';

  if (!code) {
    return Response.redirect(FALLBACK_URL, 302);
  }

  const SB_URL = process.env.SUPABASE_URL;
  const SB_KEY = process.env.SUPABASE_KEY;

  if (!SB_URL || !SB_KEY) {
    // Env vars not set — return a plain error so it's obvious in Vercel logs
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
      // Code not found → branded 404
      return new Response(notFoundHtml(code), {
        status: 404,
        headers: { 'Content-Type': 'text/html; charset=utf-8' },
      });
    }

    const target = rows[0].target;

    // Increment hit counter asynchronously — don't wait, don't block the redirect
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
    ).catch(() => {}); // fire and forget

    // ── THE KEY LINE: server-side 301 — Google follows this and indexes `target` ──
    return new Response(null, {
      status: 301,
      headers: {
        Location:        target,
        'Cache-Control': 'no-store',  // prevent stale redirects if target changes
        'X-Redirect-By': 'LinkCore',
      },
    });

  } catch (err) {
    console.error('LinkCore redirect error:', err);
    return Response.redirect(FALLBACK_URL, 302);
  }
}

function notFoundHtml(code) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>Link Not Found</title>
  <style>
    body{font-family:monospace;background:#09090b;color:#6b7280;display:flex;align-items:center;
         justify-content:center;min-height:100vh;margin:0;flex-direction:column;gap:12px}
    .code{color:#00ff88;font-size:1.1rem}
    a{color:#3b82f6}
  </style>
</head>
<body>
  <div style="font-size:2rem">🔗</div>
  <div>Short link <span class="code">/${code}</span> not found.</div>
  <div><a href="/">Go home</a></div>
</body>
</html>`;
}
