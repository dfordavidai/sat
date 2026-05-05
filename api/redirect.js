/**
 * LinkCore — Vercel Edge Function  v18.0
 * Server-side 301 redirect: /link/:code → original URL
 */

export const config = {
  runtime: 'edge',
};

const FALLBACK_URL = 'https://flexygist.com.ng/';
const WORKER_BASE  = process.env.WORKER_URL || '';

// ─── DOMAIN-LEVEL 301 REDIRECTS ──────────────────────────────────────────────
const DOMAIN_REDIRECTS = {
  'guruswapaz.com.ng':              'https://flexygist.com.ng/category/gist/',
  'www.guruswapaz.com.ng':          'https://flexygist.com.ng/category/gist/',
  'waecgceexpo.guruswapaz.com.ng':  'https://flexygist.com.ng/download-mp4/',
  'jamb.guruswapaz.com.ng':         'https://flexygist.com.ng/download-mp4/
  'jambexporuns.guruswapaz.com.ng': 'https://flexygist.com.ng/download-mp4/',
  'mp3fresh.com.ng':                'https://flexygist.com.ng/category/download-mp3/',
  'www.mp3fresh.com.ng':            'https://flexygist.com.ng/category/download-mp3/',
  'naijasturf.com.ng':              'https://flexygist.com.ng/category/viral/',
  'www.naijasturf.com.ng':          'https://flexygist.com.ng/category/viral/',
};

export default async function handler(request) {
  const url  = new URL(request.url);
  const host = url.hostname.toLowerCase();
  const path = url.pathname;

  // ── DOMAIN REDIRECT — fires before anything else ──────────────────────────
  if (DOMAIN_REDIRECTS[host]) {
    const base   = DOMAIN_REDIRECTS[host];
    const suffix = path.replace(/^\//, '');
    const dest   = suffix ? base + suffix : base;
    return new Response(null, {
      status: 301,
      headers: {
        'Location':      dest,
        'Cache-Control': 'no-store',
        'X-Redirect-By': 'LinkCore-DomainRedirect',
      },
    });
  }

  // ── rest of your existing code unchanged below ────────────────────────────
  const parts = path.split('/').filter(Boolean);
  const SB_URL = process.env.SUPABASE_URL;
  const SB_KEY = process.env.SUPABASE_KEY;
  // ... (keep everything else exactly as it was)
