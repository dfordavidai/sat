/**
 * LinkCore — sitemap-index.xml Edge Function
 * Serves the per-domain sitemap index listing all sub-sitemaps.
 *
 * Deploy to ALL 4 domain repos (same file).
 * Routes (both variants handled):
 *   /sitemap-index.xml  → /api/sitemap-index
 *   /sitemap_index.xml  → /api/sitemap-index
 *
 * IMPORTANT — Google cross-domain rule:
 *   Each domain's sitemap index lists ONLY sitemaps on THAT domain.
 *   Never list another domain's sitemap.xml here — GSC will reject it
 *   with a cross-domain error. Authority consolidation happens via 301
 *   redirects and rel=canonical on /link-hub, NOT via shared sitemaps.
 *
 * Required env vars:
 *   DOMAIN_NAME  — canonical domain for this deployment (e.g. flexygist.com.ng)
 */

export const config = { runtime: 'edge' };

export default async function handler(request) {
  const url        = new URL(request.url);
  const thisDomain = process.env.DOMAIN_NAME || url.hostname;
  const now        = new Date().toISOString().split('.')[0] + '+00:00';

  // All sub-sitemaps on THIS domain only — add more as the site grows
  const subSitemaps = [
    `https://${thisDomain}/sitemap.xml`,
    `https://${thisDomain}/sitemap-links.xml`,
    `https://${thisDomain}/feed.xml`,
  ];

  const entries = subSitemaps.map(loc => `  <sitemap>
    <loc>${loc}</loc>
    <lastmod>${now}</lastmod>
  </sitemap>`).join('\n');

  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${entries}
</sitemapindex>`;

  return new Response(xml, {
    status: 200,
    headers: {
      'Content-Type':  'application/xml; charset=utf-8',
      'Cache-Control': 'public, max-age=3600',
      // The index file itself should not be indexed as a page
      'X-Robots-Tag':  'noindex',
    },
  });
}
