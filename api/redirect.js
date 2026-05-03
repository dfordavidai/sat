/**
 * LinkCore — Vercel Edge Function  v15.2
 * Server-side 301 redirect: /link/:code → original URL
 *
 * Deploy this to ALL 4 domain repos (same file, same code).
 * Set these environment variables in each Vercel project:
 *   SUPABASE_URL  = https://xxxxxxxxxx.supabase.co
 *   SUPABASE_KEY  = your-anon-key
 *
 * CHANGES (v15.2):
 *  + Last-Modified header on 301 — Googlebot recrawl trust signal
 *  + ETag header on 301 — enables 304 Not Modified on revisit
 *  + If-None-Match handling — returns 304 when Googlebot revisits unchanged link
 */

export const config = {
  runtime: 'edge',
};

const FALLBACK_URL = 'https://flexygist.com.ng/';

export default async function handler(request) {
  const url   = new URL(request.url);
  const parts = url.pathname.split('/').filter(Boolean);
  // Query param comes first — vercel.json routes always inject ?code=$code
  const code  = url.searchParams.get('code')
             || (parts[1] && parts[1] !== 'link' ? parts[1] : null)
             || (parts[0] && parts[0] !== 'link' ? parts[0] : null)
             || '';

  if (!code) {
    return Response.redirect(FALLBACK_URL, 301);
  }

  const SB_URL = process.env.SUPABASE_URL;
  const SB_KEY = process.env.SUPABASE_KEY;

  if (!SB_URL || !SB_KEY) {
    return new Response('Server misconfigured: SUPABASE_URL / SUPABASE_KEY not set', { status: 500 });
  }

  try {
    const res = await fetch(
      `${SB_URL}/rest/v1/ic_short_links?code=eq.${encodeURIComponent(code)}&select=target,updated_at&limit=1`,
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
      return new Response(notFoundHtml(code), {
        status: 404,
        headers: { 'Content-Type': 'text/html; charset=utf-8' },
      });
    }

    const { target, updated_at } = rows[0];

    // Validate stored URL
    try {
      const t = new URL(target);
      if (!['http:', 'https:'].includes(t.protocol)) throw new Error('bad protocol');
    } catch {
      console.error('LinkCore: corrupt target URL:', target);
      return Response.redirect(FALLBACK_URL, 301);
    }

    // ── HTTP Cache Signals ───────────────────────────────────────────────────
    // ETag derived from the target URL — stable unless the link destination changes.
    // Last-Modified from when the link record was last updated in Supabase.
    // Together these let Googlebot issue a conditional GET on revisit (304),
    // which signals the link is trustworthy and increases recrawl frequency.
    const etag         = `"lc-${code}-${Buffer.from(target).toString('base64').slice(0, 16)}"`;
    const lastModified = updated_at ? new Date(updated_at).toUTCString() : new Date().toUTCString();

    // ── Conditional GET (304) ────────────────────────────────────────────────
    const ifNoneMatch = request.headers.get('if-none-match');
    if (ifNoneMatch === etag) {
      return new Response(null, { status: 304 });
    }

    // Increment hit counter async — fire and forget
    fetch(
      `${SB_URL}/rest/v1/rpc/increment_hits`,
      {
        method:  'POST',
        headers: {
          apikey:         SB_KEY,
          Authorization:  `Bearer ${SB_KEY}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ link_code: code }),
      }
    ).catch(() => {});

    return new Response(null, {
      status: 301,
      headers: {
        'Location':      target,
        'Cache-Control': 'no-store',
        'X-Robots-Tag':  'noindex, nofollow',
        'X-Redirect-By': 'LinkCore',
        'Last-Modified': lastModified,
        'ETag':          etag,
      },
    });

  } catch (err) {
    console.error('LinkCore redirect error:', err);
    return Response.redirect(FALLBACK_URL, 301);
  }
}

function notFoundHtml(code) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>Link Not Found</title>
  <meta name="robots" content="noindex,nofollow">
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
