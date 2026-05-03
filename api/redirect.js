/**
 * LinkCore — Vercel Edge Function  v15.1
 * Server-side 301 redirect: /link/:code → original URL
 *
 * Deploy this to ALL 4 domain repos (same file, same code).
 * Set these environment variables in each Vercel project:
 *   SUPABASE_URL  = https://xxxxxxxxxx.supabase.co
 *   SUPABASE_KEY  = your-anon-key
 *
 * FIXES (v15.1):
 *  1. X-Robots-Tag: noindex — stops Google indexing the SHORT url itself
 *     (Google follows 301 and indexes DESTINATION instead — this is the key fix)
 *  2. URL validation before redirect — catches corrupt/partial stored URLs
 *  3. Fallback changed from 302 → 301 (no equity loss on error path)
 *  4. code extraction guard: skips bare 'link' path segment
 */

export const config = {
  runtime: 'edge',
};

const FALLBACK_URL = 'https://flexygist.com.ng/'; // change per domain if desired

export default async function handler(request) {
  const url   = new URL(request.url);
  const parts = url.pathname.split('/').filter(Boolean);
  // Expect path: /link/:code  → parts = ['link', 'CODE']
  const code  = (parts[1] && parts[1] !== 'link' ? parts[1] : null)
             || (parts[0] && parts[0] !== 'link' ? parts[0] : null)
             || url.searchParams.get('code')
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

    // Validate stored URL is absolute http/https before redirecting
    try {
      const t = new URL(target);
      if (!['http:', 'https:'].includes(t.protocol)) throw new Error('bad protocol');
    } catch {
      console.error('LinkCore: corrupt target URL:', target);
      return Response.redirect(FALLBACK_URL, 301);
    }

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

    // ── SERVER-SIDE 301 ──
    // X-Robots-Tag: noindex = Google does NOT index the short URL page.
    // It follows the Location header and indexes the DESTINATION instead.
    // This is the fix for "Crawled / Not Indexed — Redirect error" in GSC.
    return new Response(null, {
      status: 301,
      headers: {
        'Location':      target,
        'Cache-Control': 'no-store',
        'X-Robots-Tag':  'noindex, nofollow',
        'X-Redirect-By': 'LinkCore',
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
