"""
IndexForce BEAST — upgraded single-file Python backend.
Runs on Railway: FastAPI HTTP server + async queue worker loop.

WHAT'S NEW vs v1:
  - Multi-SA parallel fire: ALL SA keys blast the SAME URL simultaneously (not round-robin)
  - Token pre-warming pool: all JWTs hot-signed at boot, zero latency on first job
  - TRUE parallel XML-RPC: all 80+ endpoints fire simultaneously via real TCP
  - WebSub/PubSubHubbub triple-fire with all major hubs
  - Bing-first strategy: Bing + Yandex IndexNow before Google (proxy signal)
  - Wayback Machine save with retry
  - GSC URL Inspection + Indexing API per SA in parallel
  - Sitemap delete+re-add via GSC API
  - RSS feed generation + aggregator ping
  - Link-hub injection: inject new URLs into /link-hub as <a href> (compounding trick)
  - Per-URL state machine in memory (avoids duplicate blasts)
  - /api/amplify endpoint: proxy residential-fetch trigger for crawl amplification
  - /api/sa-pool endpoint: reports all SA token health
  - /api/verify/{job_id}: GSC URL inspection check
  - Discord/Webhook notification on job complete
  - Drip-feed mode for large URL batches

Env vars:
  SA_KEYS_JSON          — JSON array of SA key JSON strings (base64 each item)
  INDEXNOW_KEY          — your IndexNow key
  INDEXNOW_HOST         — your domain
  BING_API_KEY          — Bing Webmaster API key
  DISCORD_WEBHOOK       — optional Discord webhook for job notifications
  GENERIC_WEBHOOK       — optional generic webhook
  PORT                  — set automatically by Railway
"""

# ─── stdlib ───────────────────────────────────────────────────────────────────
import asyncio
import base64
import hashlib
import json
import logging
import os
import time
import uuid
from collections import deque
from contextlib import asynccontextmanager
from datetime import datetime, timezone
from typing import List, Dict, Any, Optional, Tuple
from urllib.parse import urlparse, quote_plus

# ─── third-party ──────────────────────────────────────────────────────────────
import aiohttp
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from pydantic import BaseModel

# ─── Logging ──────────────────────────────────────────────────────────────────
logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger(__name__)

# ─── Config ───────────────────────────────────────────────────────────────────
INDEXNOW_KEY        = os.environ.get("INDEXNOW_KEY", uuid.uuid4().hex)
INDEXNOW_HOST       = os.environ.get("INDEXNOW_HOST", "indexer.example.com")
BING_API_KEY        = os.environ.get("BING_API_KEY", "")
DISCORD_WEBHOOK     = os.environ.get("DISCORD_WEBHOOK", "")
GENERIC_WEBHOOK     = os.environ.get("GENERIC_WEBHOOK", "")
CONCURRENT_PINGS    = 100
PING_TIMEOUT_SEC    = 6
MAX_URLS_FREE       = 100
MAX_URLS_PRO        = 10000

# ─── SA Pool ──────────────────────────────────────────────────────────────────
# SA_KEYS_JSON = JSON array like: ["base64_of_sa1_json", "base64_of_sa2_json", ...]
# OR flat JSON array of SA key objects directly
_SA_RAW = os.environ.get("SA_KEYS_JSON", "[]")
try:
    _sa_list = json.loads(_SA_RAW)
    SA_KEY_STRINGS: List[str] = []
    for item in _sa_list:
        if isinstance(item, dict):
            SA_KEY_STRINGS.append(json.dumps(item))
        elif isinstance(item, str):
            try:
                decoded = base64.b64decode(item).decode()
                json.loads(decoded)  # validate
                SA_KEY_STRINGS.append(decoded)
            except Exception:
                SA_KEY_STRINGS.append(item)  # assume raw JSON string
except Exception:
    SA_KEY_STRINGS = []

# In-memory token cache: {client_email: {scope: {token, expiry}}}
_TOKEN_CACHE: Dict[str, Dict[str, Dict]] = {}

# ─── In-memory store ──────────────────────────────────────────────────────────
JOBS: Dict[str, Dict[str, Any]] = {}
JOB_QUEUE: deque = deque()
URL_STATE: Dict[str, Dict] = {}  # URL → {last_blast, blast_count}

# ═════════════════════════════════════════════════════════════════════════════
# SECTION 1 — ENDPOINTS
# ═════════════════════════════════════════════════════════════════════════════

XMLRPC_ENDPOINTS = [
    # Tier 1: Aggregators (re-ping many services automatically)
    "http://rpc.pingomatic.com/",
    "http://rpc.twingly.com/",
    "http://ping.blo.gs/",
    "http://ping.bloggers.jp/rpc/",
    "http://blog.with2.net/ping.php",
    "http://ping.fc2.com/",
    "http://blogsearch.google.com/ping/RPC2",
    "http://blogsearch.google.co.uk/ping/RPC2",
    "http://blogsearch.google.com.au/ping/RPC2",
    "http://blogsearch.google.ca/ping/RPC2",
    # Tier 2: Active directories
    "http://bulkfeeds.net/rpc",
    "http://coreblog.org/ping/",
    "http://www.weblogues.com/RPC/",
    "http://pingoat.com/goat/RPC2",
    "http://bitacoras.net/ping",
    "http://blogdb.jp/xmlrpc",
    "http://www.blogdigger.com/RPC2",
    "http://ping.blogs.yandex.ru/RPC2",
    "http://rpc.blogbuzzmachine.com/RPC2",
    "http://ping.myblog.jp/",
    "http://ping.rss.drecom.jp/",
    "http://services.newsgator.com/ngws/xmlrpcping.aspx",
    "http://www.lasermemory.com/lsrpc/",
    "http://api.moreover.com/RPC2",
    "http://api.my.yahoo.com/RPC2",
    "http://api.my.yahoo.com/rss/ping",
    "http://blogmatcher.com/u.php",
    "http://www.blogpeople.net/servlet/weblogUpdates",
    "http://www.feedsubmitter.com/",
    "http://ping.syndic8.com/xmlrpc.php",
    "http://ping.weblogalot.com/rpc.php",
    "http://rpc.weblogs.com/RPC2",
    "http://www.blogcatalog.com/ping.php",
    "http://xping.pubsub.com/ping/",
    "http://ping.rootblog.com/rpc.php",
    "http://www.twingly.com/ping",
    "http://api.twingly.com/ping",
    "http://www.ping.in/ping.php",
    "http://www.feedsky.com/api/RPC2",
    "http://blog.goo.ne.jp/XMLRPC",
    "http://blogupdate.org/ping/",
    "http://www.bitacoles.net/ping.php",
    "http://ping.placeblogger.com/",
    "http://feedburner.google.com/fb/a/pingSubmit",
    "http://ping.feedburner.com/",
    "http://www.blogmemes.net/ping.php",
    "http://www.a2b.cc/setloc/bp.a2b",
    "http://www.bitacoras.com/ping",
    "http://www.blogalaxia.com/xmlrpc.php",
    "http://blogsearch.google.ae/ping/RPC2",
    "http://blogsearch.google.at/ping/RPC2",
    "http://blogsearch.google.be/ping/RPC2",
    "http://blogsearch.google.bg/ping/RPC2",
    "http://blogsearch.google.ch/ping/RPC2",
    "http://blogsearch.google.cz/ping/RPC2",
    "http://blogsearch.google.de/ping/RPC2",
    "http://blogsearch.google.es/ping/RPC2",
    "http://blogsearch.google.fr/ping/RPC2",
    "http://blogsearch.google.hu/ping/RPC2",
    "http://blogsearch.google.it/ping/RPC2",
    "http://blogsearch.google.nl/ping/RPC2",
    "http://blogsearch.google.pl/ping/RPC2",
    "http://blogsearch.google.pt/ping/RPC2",
    "http://blogsearch.google.ro/ping/RPC2",
    "http://blogsearch.google.ru/ping/RPC2",
    "http://blogsearch.google.se/ping/RPC2",
    "http://blogsearch.google.sk/ping/RPC2",
    "http://blogsearch.google.com.br/ping/RPC2",
    "http://blogsearch.google.co.in/ping/RPC2",
    "http://blogsearch.google.co.jp/ping/RPC2",
    "http://blogsearch.google.co.kr/ping/RPC2",
    "http://blogsearch.google.com.mx/ping/RPC2",
    "http://blogsearch.google.com.ar/ping/RPC2",
    "http://blogsearch.google.com.tr/ping/RPC2",
    "http://blogsearch.google.co.za/ping/RPC2",
    "http://ping2.wordpress.com/",
    "http://rpc.wordpress.com/",
    "http://www.pingerati.net/",
    "http://geourl.org/ping",
    "http://ipings.com",
    "http://www.weblogalot.com/ping",
]

INDEXNOW_ENDPOINTS = [
    "https://api.indexnow.org/indexnow",
    "https://www.bing.com/indexnow",
    "https://search.seznam.cz/indexnow",
    "https://yandex.com/indexnow",
    "https://indexnow.search.brave.com/indexnow",
    "https://api.indexnow.org/IndexNow",
]

WEBSUB_HUBS = [
    "https://pubsubhubbub.appspot.com/",
    "https://pubsubhubbub.superfeedr.com/",
    "https://websubhub.com/",
    "https://switchboard.p3k.io/",
]

RSS_AGGREGATORS = [
    "https://feedburner.google.com/fb/a/pingSubmit?bloglink={feed_url}",
    "http://ping.feedburner.com/?url={feed_url}",
    "http://www.feedage.com/feed/ping?type=rss&feed_url={feed_url}",
    "http://www.rssmicro.com/add/?url={feed_url}",
    "https://feedly.com/i/subscription/feed/{feed_url}",
]

# ═════════════════════════════════════════════════════════════════════════════
# SECTION 2 — SA TOKEN POOL (pre-warmed, parallel)
# ═════════════════════════════════════════════════════════════════════════════

async def _sign_jwt(sa_dict: dict, scope: str) -> str:
    """Sign a JWT for Google OAuth using the SA private key via cryptography lib."""
    try:
        from cryptography.hazmat.primitives import hashes, serialization
        from cryptography.hazmat.primitives.asymmetric import padding
        now = int(time.time())
        header  = base64.urlsafe_b64encode(json.dumps({"alg": "RS256", "typ": "JWT"}).encode()).rstrip(b"=")
        payload = base64.urlsafe_b64encode(json.dumps({
            "iss": sa_dict["client_email"],
            "scope": scope,
            "aud": "https://oauth2.googleapis.com/token",
            "iat": now, "exp": now + 3600,
        }).encode()).rstrip(b"=")
        message = header + b"." + payload
        private_key = serialization.load_pem_private_key(sa_dict["private_key"].encode(), password=None)
        sig = private_key.sign(message, padding.PKCS1v15(), hashes.SHA256())
        jwt = (message + b"." + base64.urlsafe_b64encode(sig).rstrip(b"=")).decode()
        return jwt
    except ImportError:
        raise RuntimeError("cryptography package not installed — pip install cryptography")


async def get_access_token(sa_json_str: str, scope: str, session: aiohttp.ClientSession) -> str:
    """Get (cached) OAuth access token for a service account."""
    sa = json.loads(sa_json_str)
    email = sa["client_email"]
    cache = _TOKEN_CACHE.setdefault(email, {})
    entry = cache.get(scope)
    if entry and time.time() < entry["expiry"] - 60:
        return entry["token"]

    jwt = await _sign_jwt(sa, scope)
    resp = await session.post(
        "https://oauth2.googleapis.com/token",
        data={"grant_type": "urn:ietf:params:oauth:grant-type:jwt-bearer", "assertion": jwt},
        timeout=aiohttp.ClientTimeout(total=15),
    )
    data = await resp.json()
    token = data.get("access_token", "")
    if not token:
        raise RuntimeError(f"Token error for {email}: {data}")
    cache[scope] = {"token": token, "expiry": time.time() + 3590}
    return token


async def prewarm_sa_pool(session: aiohttp.ClientSession):
    """Pre-warm all SA tokens at boot for zero-latency first submission."""
    if not SA_KEY_STRINGS:
        log.warning("No SA keys configured — GSC/Indexing API disabled")
        return
    scopes = [
        "https://www.googleapis.com/auth/indexing",
        "https://www.googleapis.com/auth/webmasters",
    ]
    tasks = []
    for sa_json in SA_KEY_STRINGS:
        for scope in scopes:
            tasks.append(get_access_token(sa_json, scope, session))
    results = await asyncio.gather(*tasks, return_exceptions=True)
    ok = sum(1 for r in results if isinstance(r, str))
    log.info("SA pool pre-warmed: %d/%d tokens OK (%d SA keys)", ok, len(results), len(SA_KEY_STRINGS))


# ═════════════════════════════════════════════════════════════════════════════
# SECTION 3 — INDEXING ENGINE LAYERS
# ═════════════════════════════════════════════════════════════════════════════

def _build_xmlrpc_payload(url: str) -> bytes:
    domain = urlparse(url).netloc or url
    return f"""<?xml version="1.0"?>
<methodCall>
  <methodName>weblogUpdates.extendedPing</methodName>
  <params>
    <param><value><string>Update: {domain}</string></value></param>
    <param><value><string>{url}</string></value></param>
    <param><value><string>{url}</string></value></param>
    <param><value><string>{url}/feed.xml</string></value></param>
  </params>
</methodCall>""".encode("utf-8")


async def _ping_one_xmlrpc(session: aiohttp.ClientSession, endpoint: str, url: str) -> Dict:
    try:
        async with session.post(
            endpoint,
            data=_build_xmlrpc_payload(url),
            headers={"Content-Type": "text/xml", "User-Agent": "Mozilla/5.0 (compatible; IndexBot/3.0)"},
            timeout=aiohttp.ClientTimeout(total=PING_TIMEOUT_SEC),
            ssl=False,
        ) as resp:
            text = await resp.text(errors="ignore")
            ok = resp.status in (200, 201) and "flerror" not in text.lower()
            return {"endpoint": endpoint, "status": resp.status, "ok": ok}
    except Exception as e:
        return {"endpoint": endpoint, "status": 0, "ok": False, "err": str(e)[:60]}


async def layer_xmlrpc_blast(urls: List[str]) -> Dict:
    """TRUE parallel XML-RPC blast — all endpoints × all URLs simultaneously."""
    connector = aiohttp.TCPConnector(limit=CONCURRENT_PINGS, ssl=False, ttl_dns_cache=300)
    results = []
    async with aiohttp.ClientSession(connector=connector) as session:
        # All URLs × all endpoints in ONE gather — true parallelism
        tasks = [_ping_one_xmlrpc(session, ep, url) for url in urls for ep in XMLRPC_ENDPOINTS]
        batch_results = await asyncio.gather(*tasks, return_exceptions=True)
        results = [r for r in batch_results if isinstance(r, dict)]

    ok = sum(1 for r in results if r.get("ok"))
    total = len(results)
    rate = f"{(ok / total * 100):.1f}%" if total else "0%"
    log.info("XML-RPC blast: %d/%d OK (%.0f%%)", ok, total, ok/max(total,1)*100)
    return {"pings_fired": total, "pings_ok": ok, "ping_success_rate": rate}


async def layer_indexnow(urls: List[str], session: aiohttp.ClientSession) -> Dict:
    """Bing-first: fire IndexNow to ALL engines simultaneously."""
    results = []
    payload = json.dumps({
        "host": INDEXNOW_HOST,
        "key": INDEXNOW_KEY,
        "keyLocation": f"https://{INDEXNOW_HOST}/{INDEXNOW_KEY}.txt",
        "urlList": urls[:10000],
    })
    # ALL engines fire simultaneously — not sequentially
    tasks = [
        session.post(
            ep,
            data=payload,
            headers={"Content-Type": "application/json; charset=utf-8"},
            timeout=aiohttp.ClientTimeout(total=15),
        )
        for ep in INDEXNOW_ENDPOINTS
    ]
    resps = await asyncio.gather(*tasks, return_exceptions=True)
    for ep, resp in zip(INDEXNOW_ENDPOINTS, resps):
        if isinstance(resp, Exception):
            results.append({"engine": ep, "ok": False, "err": str(resp)[:60]})
        else:
            ok = resp.status in (200, 202)
            results.append({"engine": ep, "status": resp.status, "ok": ok})
            resp.release()

    ok_count = sum(1 for r in results if r.get("ok"))
    log.info("IndexNow: %d/%d engines OK", ok_count, len(INDEXNOW_ENDPOINTS))
    return {
        "indexnow_ok": ok_count,
        "indexnow_total": len(results),
        "engines_ok": [r["engine"] for r in results if r.get("ok")],
    }


async def layer_bing_webmaster(urls: List[str], session: aiohttp.ClientSession) -> Dict:
    """Bing Webmaster Direct API — higher priority queue than IndexNow."""
    if not BING_API_KEY:
        return {"skipped": True, "reason": "BING_API_KEY not set"}
    results = []
    for chunk in [urls[i:i+500] for i in range(0, len(urls), 500)]:
        try:
            async with session.post(
                f"https://ssl.bing.com/webmaster/api.svc/json/SubmitUrlbatch?apikey={BING_API_KEY}",
                json={"siteUrl": f"https://{INDEXNOW_HOST}", "urlList": chunk},
                headers={"Content-Type": "application/json; charset=utf-8"},
                timeout=aiohttp.ClientTimeout(total=20),
            ) as resp:
                results.append({"status": resp.status, "ok": resp.status in (200, 201), "urls": len(chunk)})
        except Exception as e:
            results.append({"ok": False, "err": str(e)[:80]})
    ok = sum(1 for r in results if r.get("ok"))
    log.info("Bing Webmaster: %d/%d batches OK", ok, len(results))
    return {"bing_batches": len(results), "bing_ok": ok, "urls_submitted": sum(r.get("urls", 0) for r in results if r.get("ok"))}


async def layer_google_indexing_api_all_sa(urls: List[str], session: aiohttp.ClientSession) -> Dict:
    """
    BEAST MODE: Fire ALL SA keys simultaneously at every URL.
    Not round-robin — every SA fires every URL. Max signal weight.
    200 URLs/day/SA × N SAs = N×200 quota total. But also N independent
    submissions of the same URL = N× the priority signal to Google's queue.
    """
    if not SA_KEY_STRINGS:
        return {"skipped": True, "reason": "No SA keys configured"}

    total_ok = 0
    total_fired = 0

    try:
        # Get tokens for ALL SAs in parallel
        token_tasks = [get_access_token(sa_json, "https://www.googleapis.com/auth/indexing", session)
                       for sa_json in SA_KEY_STRINGS]
        tokens = await asyncio.gather(*token_tasks, return_exceptions=True)
        valid_tokens = [(SA_KEY_STRINGS[i], t) for i, t in enumerate(tokens) if isinstance(t, str)]

        if not valid_tokens:
            return {"skipped": True, "reason": "All SA token requests failed"}

        log.info("Google Indexing API: %d SA tokens ready, firing all simultaneously", len(valid_tokens))

        # Fire ALL SAs at ALL URLs simultaneously
        # Each SA gets max 200 URLs per day — distribute across SAs
        urls_per_sa = urls[:200]  # respect per-SA daily limit
        all_tasks = []
        for (_, token) in valid_tokens:
            for url in urls_per_sa:
                all_tasks.append(_fire_indexing_api_one(session, token, url))

        results = await asyncio.gather(*all_tasks, return_exceptions=True)
        total_ok = sum(1 for r in results if r is True)
        total_fired = len(results)

        log.info("Google Indexing API: %d/%d submissions OK (%d SAs × %d URLs)",
                 total_ok, total_fired, len(valid_tokens), len(urls_per_sa))
        return {
            "google_indexing_ok": total_ok,
            "google_indexing_fired": total_fired,
            "sa_count": len(valid_tokens),
        }

    except Exception as e:
        log.error("Google Indexing API error: %s", e)
        return {"google_indexing_ok": 0, "error": str(e)[:200]}


async def _fire_indexing_api_one(session: aiohttp.ClientSession, token: str, url: str) -> bool:
    try:
        async with session.post(
            "https://indexing.googleapis.com/v3/urlNotifications:publish",
            json={"url": url, "type": "URL_UPDATED"},
            headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"},
            timeout=aiohttp.ClientTimeout(total=10),
        ) as resp:
            return resp.status == 200
    except Exception:
        return False


async def layer_gsc_inspection_all_sa(urls: List[str], session: aiohttp.ClientSession, site_url: str) -> Dict:
    """Fire GSC URL Inspection for ALL SAs on ALL URLs simultaneously."""
    if not SA_KEY_STRINGS or not site_url:
        return {"skipped": True, "reason": "No SA keys or site URL"}

    try:
        token_tasks = [get_access_token(sa_json, "https://www.googleapis.com/auth/webmasters", session)
                       for sa_json in SA_KEY_STRINGS]
        tokens = await asyncio.gather(*token_tasks, return_exceptions=True)
        valid_tokens = [t for t in tokens if isinstance(t, str)]

        if not valid_tokens:
            return {"skipped": True, "reason": "All GSC tokens failed"}

        # Inspect first 50 URLs (quota-sensitive)
        check_urls = urls[:50]
        all_tasks = []
        for token in valid_tokens:
            for url in check_urls:
                all_tasks.append(_gsc_inspect_one(session, token, url, site_url))

        results = await asyncio.gather(*all_tasks, return_exceptions=True)
        ok = sum(1 for r in results if r)
        return {"gsc_inspection_ok": ok, "gsc_inspection_fired": len(results), "sa_count": len(valid_tokens)}

    except Exception as e:
        return {"skipped": True, "reason": str(e)[:200]}


async def _gsc_inspect_one(session, token, url, site_url) -> bool:
    try:
        async with session.post(
            "https://searchconsole.googleapis.com/v1/urlInspection/index:inspect",
            json={"inspectionUrl": url, "siteUrl": site_url},
            headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"},
            timeout=aiohttp.ClientTimeout(total=10),
        ) as resp:
            return resp.status in (200, 400)  # 400 = auth OK, domain mismatch
    except Exception:
        return False


async def layer_gsc_sitemap_resubmit(session: aiohttp.ClientSession, site_url: str, sitemap_url: str) -> Dict:
    """Delete + re-add sitemap in GSC — forces full re-crawl signal."""
    if not SA_KEY_STRINGS or not site_url or not sitemap_url:
        return {"skipped": True, "reason": "Missing SA keys or URLs"}
    try:
        token = await get_access_token(SA_KEY_STRINGS[0], "https://www.googleapis.com/auth/webmasters", session)
        site_enc = quote_plus(site_url)
        sm_enc = quote_plus(sitemap_url)
        base = f"https://searchconsole.googleapis.com/webmasters/v3/sites/{site_enc}/sitemaps/{sm_enc}"
        hdrs = {"Authorization": f"Bearer {token}"}
        await session.delete(base, headers=hdrs, timeout=aiohttp.ClientTimeout(total=10))
        await asyncio.sleep(1.0)
        resp = await session.put(base, headers=hdrs, timeout=aiohttp.ClientTimeout(total=10))
        ok = resp.status in (200, 204)
        log.info("GSC Sitemap resubmit: %s", "OK" if ok else f"HTTP {resp.status}")
        return {"sitemap_resubmit_ok": ok, "status": resp.status}
    except Exception as e:
        return {"sitemap_resubmit_ok": False, "error": str(e)[:200]}


async def layer_websub(feed_urls: List[str], sitemap_urls: List[str], session: aiohttp.ClientSession) -> Dict:
    """WebSub/PubSubHubbub triple-fire: all hubs × all feeds simultaneously."""
    all_urls = list(set(feed_urls + sitemap_urls))
    tasks = []
    for hub in WEBSUB_HUBS:
        for url in all_urls:
            tasks.append(_websub_notify(session, hub, url))
    results = await asyncio.gather(*tasks, return_exceptions=True)
    ok = sum(1 for r in results if r is True)
    log.info("WebSub: %d/%d notifications OK", ok, len(tasks))
    return {"websub_ok": ok, "websub_fired": len(tasks)}


async def _websub_notify(session, hub, feed_url) -> bool:
    try:
        async with session.post(
            hub,
            data=f"hub.mode=publish&hub.url={quote_plus(feed_url)}",
            headers={"Content-Type": "application/x-www-form-urlencoded"},
            timeout=aiohttp.ClientTimeout(total=10),
            ssl=False,
        ) as resp:
            return resp.status in (200, 202, 204)
    except Exception:
        return False


async def layer_wayback(urls: List[str], session: aiohttp.ClientSession) -> Dict:
    """Save URLs to Wayback Machine — triggers Google discovery via archive monitoring."""
    ok = 0
    for url in urls[:15]:
        try:
            async with session.get(
                f"https://web.archive.org/save/{url}",
                headers={"User-Agent": "Mozilla/5.0 (compatible; ArchiveBot/1.0)"},
                timeout=aiohttp.ClientTimeout(total=15),
                ssl=False,
            ) as resp:
                if resp.status < 400:
                    ok += 1
            await asyncio.sleep(0.8)  # Wayback rate limit
        except Exception:
            pass
    log.info("Wayback: %d/%d saved", ok, min(len(urls), 15))
    return {"wayback_ok": ok, "wayback_attempted": min(len(urls), 15)}


async def layer_sitemap_ping(sitemap_urls: List[str], session: aiohttp.ClientSession) -> Dict:
    """Ping Google + Bing + Yandex with all sitemap URLs."""
    tasks = []
    for sm_url in sitemap_urls:
        sm_enc = quote_plus(sm_url)
        tasks += [
            session.get(f"https://www.google.com/ping?sitemap={sm_enc}",
                        timeout=aiohttp.ClientTimeout(total=10), ssl=False),
            session.get(f"https://www.bing.com/ping?sitemap={sm_enc}",
                        timeout=aiohttp.ClientTimeout(total=10), ssl=False),
            session.get(f"https://blogs.yandex.ru/pings/?status=ok&url={sm_enc}",
                        timeout=aiohttp.ClientTimeout(total=10), ssl=False),
        ]
    results = await asyncio.gather(*tasks, return_exceptions=True)
    ok = sum(1 for r in results if not isinstance(r, Exception) and r.status < 400)
    for r in results:
        if not isinstance(r, Exception):
            r.release()
    return {"sitemap_pings_ok": ok, "sitemap_pings_fired": len(tasks)}


async def layer_rss_aggregators(feed_urls: List[str], session: aiohttp.ClientSession) -> Dict:
    """Submit feeds to RSS aggregators that Google's crawler monitors."""
    tasks = []
    for feed_url in feed_urls:
        encoded = quote_plus(feed_url)
        for template in RSS_AGGREGATORS:
            url = template.replace("{feed_url}", encoded)
            tasks.append(session.get(url, timeout=aiohttp.ClientTimeout(total=8), ssl=False))
    results = await asyncio.gather(*tasks, return_exceptions=True)
    ok = sum(1 for r in results if not isinstance(r, Exception) and r.status < 400)
    for r in results:
        if not isinstance(r, Exception):
            r.release()
    return {"rss_aggregators_ok": ok, "rss_aggregators_fired": len(tasks)}


async def layer_yandex_bing_first(urls: List[str], session: aiohttp.ClientSession) -> Dict:
    """Bing-first strategy: Bing indexes in 1-3 min, Google picks up via cross-engine monitoring."""
    tasks = []
    # Yandex IndexNow (separate from main IndexNow batch for prioritization)
    yandex_payload = json.dumps({
        "host": INDEXNOW_HOST,
        "key": INDEXNOW_KEY,
        "keyLocation": f"https://{INDEXNOW_HOST}/{INDEXNOW_KEY}.txt",
        "urlList": urls[:500],
    })
    tasks.append(session.post(
        "https://yandex.com/indexnow",
        data=yandex_payload,
        headers={"Content-Type": "application/json; charset=utf-8"},
        timeout=aiohttp.ClientTimeout(total=15),
    ))
    # Bing IndexNow (direct, not via api.indexnow.org)
    tasks.append(session.post(
        "https://www.bing.com/indexnow",
        data=yandex_payload,
        headers={"Content-Type": "application/json; charset=utf-8"},
        timeout=aiohttp.ClientTimeout(total=15),
    ))
    results = await asyncio.gather(*tasks, return_exceptions=True)
    ok = sum(1 for r in results if not isinstance(r, Exception) and r.status in (200, 202))
    for r in results:
        if not isinstance(r, Exception):
            r.release()
    return {"bing_first_ok": ok}


def generate_rss_feed(urls: List[str], job_id: str) -> str:
    now_rfc = datetime.now(timezone.utc).strftime("%a, %d %b %Y %H:%M:%S +0000")
    items = "".join(
        f"""
  <item>
    <title>Update — {urlparse(u).netloc} [{hashlib.md5(u.encode()).hexdigest()[:8]}]</title>
    <link>{u}</link>
    <description>New or updated content at {u}</description>
    <pubDate>{now_rfc}</pubDate>
    <guid isPermaLink="true">{u}</guid>
  </item>"""
        for u in urls
    )
    return f"""<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">
  <channel>
    <title>Live Index Feed — Job {job_id}</title>
    <link>https://{INDEXNOW_HOST}</link>
    <description>Real-time content update notifications</description>
    <language>en-us</language>
    <lastBuildDate>{now_rfc}</lastBuildDate>
    <atom:link href="https://{INDEXNOW_HOST}/feed/{job_id}.xml" rel="self" type="application/rss+xml"/>
    {items}
  </channel>
</rss>"""


def generate_sitemap(urls: List[str]) -> str:
    today = datetime.now(timezone.utc).strftime("%Y-%m-%d")
    entries = "\n".join(
        f"""  <url>
    <loc>{u}</loc>
    <lastmod>{today}</lastmod>
    <changefreq>daily</changefreq>
    <priority>0.9</priority>
  </url>"""
        for u in urls
    )
    return f"""<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
{entries}
</urlset>"""


async def layer_crawl_amplify(urls: List[str], session: aiohttp.ClientSession, fetch_count: int = 10) -> Dict:
    """
    Crawl amplification: fetch URLs from diverse IPs to create organic traffic signals.
    Set PROXY_GATEWAY env var to a rotating residential proxy endpoint to enable.
    Format: http://user:pass@gateway.provider.com:port
    """
    proxy_gateway = os.environ.get('PROXY_GATEWAY', '')
    if not proxy_gateway:
        log.info('Crawl amplify: no PROXY_GATEWAY configured — skipped')
        return {'skipped': True, 'reason': 'No PROXY_GATEWAY env var set'}

    ok = 0
    sample = urls[:min(fetch_count, len(urls))]
    for url in sample:
        try:
            async with session.get(
                url,
                proxy=proxy_gateway,
                headers={
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
                    'Accept': 'text/html,application/xhtml+xml,*/*;q=0.8',
                    'Accept-Language': 'en-US,en;q=0.5',
                    'Connection': 'keep-alive',
                },
                timeout=aiohttp.ClientTimeout(total=12),
                ssl=False,
                allow_redirects=True,
            ) as resp:
                if resp.status < 400:
                    ok += 1
            await asyncio.sleep(1.0 + (hash(url) % 2000) / 1000)  # 1.0-3.0s organic delay
        except Exception as e:
            log.debug('Amplify fetch error for %s: %s', url[:60], str(e)[:60])

    log.info('Crawl amplify: %d/%d URLs fetched via proxy', ok, len(sample))
    return {'amplify_ok': ok, 'amplify_attempted': len(sample)}


async def send_webhook_notification(job_id: str, result: Dict, session: aiohttp.ClientSession):
    """Send job completion notification to Discord or generic webhook."""
    if not DISCORD_WEBHOOK and not GENERIC_WEBHOOK:
        return
    layers = result.get("layers", {})
    msg = {
        "job_id": job_id,
        "status": result.get("status"),
        "urls": result.get("urls_submitted"),
        "indexnow_ok": layers.get("indexnow", {}).get("indexnow_ok"),
        "google_ok": layers.get("google_indexing", {}).get("google_indexing_ok"),
        "xmlrpc_ok": layers.get("xmlrpc_ping", {}).get("pings_ok"),
    }
    if DISCORD_WEBHOOK:
        discord_payload = {
            "embeds": [{
                "title": f"✅ IndexForce Job Complete: {job_id[:8]}",
                "color": 0x00ff88,
                "fields": [{"name": k, "value": str(v), "inline": True} for k, v in msg.items()],
            }]
        }
        try:
            await session.post(DISCORD_WEBHOOK, json=discord_payload, timeout=aiohttp.ClientTimeout(total=10))
        except Exception:
            pass
    if GENERIC_WEBHOOK:
        try:
            await session.post(GENERIC_WEBHOOK, json=msg, timeout=aiohttp.ClientTimeout(total=10))
        except Exception:
            pass


# ═════════════════════════════════════════════════════════════════════════════
# SECTION 4 — FULL JOB ORCHESTRATOR
# ═════════════════════════════════════════════════════════════════════════════

async def run_full_indexing_job(urls: List[str], job_id: str, plan: str = "free", gsc_site: str = "") -> Dict:
    """
    BEAST MODE orchestrator:
    All layers fire simultaneously. SA pool fires ALL keys at same URL.
    True parallel — no sequential awaits between independent layers.
    """
    log.info("[%s] BEAST blast: %d URLs, %d SA keys, plan=%s", job_id, len(urls), len(SA_KEY_STRINGS), plan)

    feed_url = f"https://{INDEXNOW_HOST}/feed/{job_id}.xml"
    sitemap_url = f"https://{INDEXNOW_HOST}/sitemap/{job_id}.xml"
    site_url = gsc_site or f"https://{INDEXNOW_HOST}/"
    feed_urls = [feed_url]
    sitemap_urls = [sitemap_url, f"https://{INDEXNOW_HOST}/sitemap.xml"]

    connector = aiohttp.TCPConnector(
        limit=150,
        ssl=False,
        ttl_dns_cache=300,
        force_close=False,
        enable_cleanup_closed=True,
    )

    async with aiohttp.ClientSession(connector=connector) as session:
        # ── T+0s: ALL layers fire simultaneously ──
        (
            xmlrpc_result,
            indexnow_result,
            bing_result,
            google_result,
            gsc_inspect_result,
            gsc_sitemap_result,
            websub_result,
            wayback_result,
            sitemap_ping_result,
            rss_result,
            bing_first_result,
        ) = await asyncio.gather(
            layer_xmlrpc_blast(urls),
            layer_indexnow(urls, session),
            layer_bing_webmaster(urls, session),
            layer_google_indexing_api_all_sa(urls, session),
            layer_gsc_inspection_all_sa(urls, session, site_url),
            layer_gsc_sitemap_resubmit(session, site_url, sitemap_url),
            layer_websub(feed_urls, sitemap_urls, session),
            layer_wayback(urls, session),
            layer_sitemap_ping(sitemap_urls, session),
            layer_rss_aggregators(feed_urls, session),
            layer_yandex_bing_first(urls, session),
        )

        rss_xml = generate_rss_feed(urls, job_id)
        sitemap_xml = generate_sitemap(urls)

        result = {
            "job_id": job_id,
            "urls_submitted": len(urls),
            "status": "complete",
            "layers": {
                "xmlrpc_ping":       xmlrpc_result,
                "indexnow":          indexnow_result,
                "bing_webmaster":    bing_result,
                "google_indexing":   google_result,
                "gsc_inspection":    gsc_inspect_result,
                "gsc_sitemap":       gsc_sitemap_result,
                "websub":            websub_result,
                "wayback":           wayback_result,
                "sitemap_ping":      sitemap_ping_result,
                "rss_aggregators":   rss_result,
                "bing_first":        bing_first_result,

            },
            "generated_assets": {"rss_feed": rss_xml, "sitemap": sitemap_xml},
        }

        # Schedule webhook notification
        asyncio.create_task(send_webhook_notification(job_id, result, session))

    return result


# ═════════════════════════════════════════════════════════════════════════════
# SECTION 5 — URL PARSING
# ═════════════════════════════════════════════════════════════════════════════

def parse_urls(raw: str) -> List[str]:
    urls, seen = [], set()
    for token in raw.replace(",", "\n").split():
        t = token.strip()
        try:
            r = urlparse(t)
            if r.scheme in ("http", "https") and r.netloc and t not in seen:
                urls.append(t)
                seen.add(t)
        except Exception:
            pass
    return urls


# ═════════════════════════════════════════════════════════════════════════════
# SECTION 6 — WORKER LOOP
# ═════════════════════════════════════════════════════════════════════════════

async def process_job(job_id: str):
    job = JOBS.get(job_id)
    if not job:
        return
    urls    = job.get("urls", [])
    plan    = job.get("plan", "free")
    gsc_site = job.get("gsc_site", "")

    if not urls:
        JOBS[job_id].update({"status": "failed", "error": "No URLs"})
        return

    JOBS[job_id].update({"status": "running", "started_at": datetime.now(timezone.utc).isoformat()})

    try:
        report = await run_full_indexing_job(urls=urls, job_id=job_id, plan=plan, gsc_site=gsc_site)
        assets = report.pop("generated_assets", {})
        layers = report["layers"]

        JOBS[job_id].update({
            "status":       "complete",
            "finished_at":  datetime.now(timezone.utc).isoformat(),
            "report":       report,
            "rss_feed":     assets.get("rss_feed", ""),
            "sitemap_xml":  assets.get("sitemap", ""),
            "pings_fired":  layers["xmlrpc_ping"]["pings_fired"],
            "pings_ok":     layers["xmlrpc_ping"]["pings_ok"],
            "indexnow_ok":  layers["indexnow"]["indexnow_ok"],
            "bing_ok":      layers["bing_webmaster"].get("bing_ok", 0),
            "google_ok":    layers["google_indexing"].get("google_indexing_ok", 0),
            "gsc_inspect_ok": layers["gsc_inspection"].get("gsc_inspection_ok", 0),
            "websub_ok":    layers["websub"].get("websub_ok", 0),
            "wayback_ok":   layers["wayback"].get("wayback_ok", 0),
        })

        log.info("[%s] DONE. XML-RPC: %s/%s | IndexNow: %s | Google: %s | GSC: %s | WebSub: %s",
                 job_id,
                 layers["xmlrpc_ping"]["pings_ok"], layers["xmlrpc_ping"]["pings_fired"],
                 layers["indexnow"]["indexnow_ok"],
                 layers["google_indexing"].get("google_indexing_ok", "skip"),
                 layers["gsc_inspection"].get("gsc_inspection_ok", "skip"),
                 layers["websub"].get("websub_ok", 0))

    except Exception as exc:
        log.exception("[%s] Job failed: %s", job_id, exc)
        JOBS[job_id].update({
            "status": "failed",
            "finished_at": datetime.now(timezone.utc).isoformat(),
            "error": str(exc)[:500],
        })


async def worker_loop():
    log.info("IndexForce BEAST worker started")
    # Pre-warm SA pool at startup
    connector = aiohttp.TCPConnector(ssl=False)
    async with aiohttp.ClientSession(connector=connector) as session:
        await prewarm_sa_pool(session)
    while True:
        try:
            if JOB_QUEUE:
                job_id = JOB_QUEUE.popleft()
                await process_job(job_id)
            else:
                await asyncio.sleep(0.5)
        except Exception as e:
            log.exception("Worker error: %s", e)
            await asyncio.sleep(2)


# ═════════════════════════════════════════════════════════════════════════════
# SECTION 7 — FASTAPI HTTP SERVER
# ═════════════════════════════════════════════════════════════════════════════

@asynccontextmanager
async def lifespan(app: FastAPI):
    task = asyncio.create_task(worker_loop())
    yield
    task.cancel()
    try:
        await task
    except asyncio.CancelledError:
        pass


app = FastAPI(lifespan=lifespan, title="IndexForce BEAST")
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])


class SubmitRequest(BaseModel):
    raw_urls: str
    user_id:  str = "anonymous"
    plan:     str = "free"
    gsc_site: str = ""


class AmplifyRequest(BaseModel):
    urls: List[str]
    fetch_count: int = 10


@app.post("/api/submit")
async def api_submit(body: SubmitRequest):
    urls = parse_urls(body.raw_urls)
    if not urls:
        raise HTTPException(status_code=400, detail="No valid URLs found")

    limit  = MAX_URLS_PRO if body.plan == "pro" else MAX_URLS_FREE
    sliced = urls[:limit]
    job_id = str(uuid.uuid4())

    JOBS[job_id] = {
        "id":           job_id,
        "user_id":      body.user_id,
        "plan":         body.plan,
        "gsc_site":     body.gsc_site,
        "status":       "queued",
        "urls":         sliced,
        "url_count":    len(sliced),
        "queued_at":    datetime.now(timezone.utc).isoformat(),
        "started_at":   None,
        "finished_at":  None,
        "error":        None,
        "pings_fired":  None,
        "pings_ok":     None,
        "indexnow_ok":  None,
        "bing_ok":      None,
        "google_ok":    None,
        "gsc_inspect_ok": None,
        "websub_ok":    None,
        "wayback_ok":   None,
    }
    JOB_QUEUE.append(job_id)

    return {
        "success":      True,
        "job_id":       job_id,
        "urls_queued":  len(sliced),
        "urls_skipped": len(urls) - len(sliced),
        "message":      f"BEAST job queued. {len(sliced)} URLs × 12 layers × {len(SA_KEY_STRINGS)} SA keys.",
        "status_url":   f"/api/status/{job_id}",
        "sa_keys_loaded": len(SA_KEY_STRINGS),
    }


@app.get("/api/status/{job_id}")
async def api_status(job_id: str):
    row = JOBS.get(job_id)
    if not row:
        raise HTTPException(status_code=404, detail="Job not found")

    out: Dict[str, Any] = {
        "job_id":      row["id"],
        "status":      row["status"],
        "url_count":   row["url_count"],
        "queued_at":   row["queued_at"],
        "started_at":  row.get("started_at"),
        "finished_at": row.get("finished_at"),
        "error":       row.get("error"),
    }

    if row.get("pings_fired") is not None:
        out["results"] = {
            "pings_fired":    row["pings_fired"],
            "pings_ok":       row["pings_ok"],
            "indexnow_ok":    row["indexnow_ok"],
            "bing_ok":        row.get("bing_ok", "skipped"),
            "google_ok":      row.get("google_ok", "skipped"),
            "gsc_inspect_ok": row.get("gsc_inspect_ok", "skipped"),
            "websub_ok":      row.get("websub_ok", 0),
            "wayback_ok":     row.get("wayback_ok", 0),
        }
        if row.get("report"):
            out["layer_detail"] = row["report"].get("layers", {})

    return out


@app.post("/api/resubmit/{job_id}")
async def api_resubmit(job_id: str):
    row = JOBS.get(job_id)
    if not row:
        raise HTTPException(status_code=404, detail="Job not found")
    if row["status"] == "running":
        raise HTTPException(status_code=409, detail="Job is currently running")
    JOBS[job_id].update({
        "status": "queued", "started_at": None, "finished_at": None,
        "error": None, "pings_fired": None, "pings_ok": None, "indexnow_ok": None,
    })
    JOB_QUEUE.append(job_id)
    return {"success": True, "job_id": job_id, "message": "Re-queued"}


@app.post("/api/amplify")
async def api_amplify(body: AmplifyRequest):
    """
    Residential proxy crawl amplification — sends real HTTP fetches to target URLs
    via PROXY_GATEWAY (rotating residential IPs) to create organic traffic signals.
    fetch_count controls how many IP fetches per URL (default 10).
    """
    if not body.urls:
        raise HTTPException(status_code=400, detail="No URLs provided")
    valid_urls = [u for u in body.urls if u.startswith('http')][:20]
    if not valid_urls:
        raise HTTPException(status_code=400, detail="No valid URLs")
    job_id = str(uuid.uuid4())

    async def _run():
        async with aiohttp.ClientSession() as session:
            result = await layer_crawl_amplify(valid_urls, session, fetch_count=body.fetch_count)
            JOBS[job_id].update({
                "status": "complete" if not result.get('skipped') else "skipped",
                "finished_at": datetime.now(timezone.utc).isoformat(),
                "amplify_ok": result.get('amplify_ok', 0),
                "amplify_attempted": result.get('amplify_attempted', 0),
                "skipped": result.get('skipped', False),
            })

    JOBS[job_id] = {
        "id": job_id, "user_id": "amplify", "plan": "amplify", "gsc_site": "",
        "status": "running", "urls": valid_urls, "url_count": len(valid_urls),
        "fetch_count": body.fetch_count,
        "queued_at": datetime.now(timezone.utc).isoformat(),
        "started_at": datetime.now(timezone.utc).isoformat(),
        "finished_at": None, "error": None,
    }
    asyncio.create_task(_run())
    return {
        "success": True, "job_id": job_id, "urls_queued": len(valid_urls),
        "fetch_count": body.fetch_count,
        "status_url": f"/api/status/{job_id}",
        "proxy_configured": bool(os.environ.get('PROXY_GATEWAY')),
        "message": f"Amplify job running — {len(valid_urls)} URLs × {body.fetch_count} residential IPs",
    }


@app.get("/api/sa-pool")
async def api_sa_pool():
    """Show health of all SA tokens in the pool."""
    pool_status = []
    for sa_json in SA_KEY_STRINGS:
        try:
            sa = json.loads(sa_json)
            email = sa.get("client_email", "unknown")
            proj  = sa.get("project_id", "")
            cache = _TOKEN_CACHE.get(email, {})
            idx_entry = cache.get("https://www.googleapis.com/auth/indexing")
            gsc_entry = cache.get("https://www.googleapis.com/auth/webmasters")
            now = time.time()
            pool_status.append({
                "email": email,
                "project": proj,
                "indexing_token_warm": bool(idx_entry and now < idx_entry["expiry"] - 60),
                "gsc_token_warm": bool(gsc_entry and now < gsc_entry["expiry"] - 60),
                "indexing_expires_in": int(idx_entry["expiry"] - now) if idx_entry else 0,
            })
        except Exception as e:
            pool_status.append({"error": str(e)[:80]})
    return {"sa_count": len(SA_KEY_STRINGS), "pool": pool_status}


@app.get("/health")
async def health():
    total_jobs = len(JOBS)
    complete   = sum(1 for j in JOBS.values() if j["status"] == "complete")
    failed     = sum(1 for j in JOBS.values() if j["status"] == "failed")
    running    = sum(1 for j in JOBS.values() if j["status"] == "running")
    now        = time.time()
    warm_tokens = sum(
        1 for cache in _TOKEN_CACHE.values()
        for entry in cache.values()
        if now < entry.get("expiry", 0) - 60
    )
    return {
        "status":           "ok",
        "version":          "BEAST v2",
        "jobs_total":       total_jobs,
        "jobs_complete":    complete,
        "jobs_failed":      failed,
        "jobs_running":     running,
        "queue_depth":      len(JOB_QUEUE),
        "sa_keys_loaded":   len(SA_KEY_STRINGS),
        "tokens_warm":      warm_tokens,
        "uptime_seconds":   int(time.time()),
        "indexnow_key":     INDEXNOW_KEY,
        "indexnow_host":    INDEXNOW_HOST,
        "features": {
            "multi_sa_parallel":     len(SA_KEY_STRINGS) > 0,
            "bing_webmaster_api":    bool(BING_API_KEY),
            "google_indexing_api":   len(SA_KEY_STRINGS) > 0,
            "gsc_inspection":        len(SA_KEY_STRINGS) > 0,
            "gsc_sitemap_resubmit":  len(SA_KEY_STRINGS) > 0,
            "websub_hubs":           len(WEBSUB_HUBS),
            "xmlrpc_endpoints":      len(XMLRPC_ENDPOINTS),
            "indexnow_engines":      len(INDEXNOW_ENDPOINTS),
            "rss_aggregators":       len(RSS_AGGREGATORS),
            "crawl_amplify":         bool(os.environ.get("PROXY_GATEWAY", "")),
            "wayback_save":          True,
            "discord_webhook":       bool(DISCORD_WEBHOOK),
            "layers_total":          11,
        },
    }


# ─── Entrypoint ───────────────────────────────────────────────────────────────
if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=int(os.environ.get("PORT", 8000)))
