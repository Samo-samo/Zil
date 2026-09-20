// YouTube RSS helpers. Service-worker safe: no DOM, no chrome APIs — only fetch + RegExp.
// Kept chrome-free on purpose so it can be unit-tested with plain node.
//
// Error taxonomy (err.message):
//   feed-http:404  -> channel does not exist (treat as invalid input)
//   feed-http:XXX  -> YouTube returned an error page
//   feed-network   -> request failed / timed out (offline, blocked, hanging)
//   not-a-feed     -> 200 OK but body is not XML (consent/bot page)
//   not-a-channel  -> a video URL was pasted, not a channel
//   unresolvable   -> handle/URL could not be mapped to a channel ID
//   empty          -> blank input

const CHANNEL_ID_RE = /^UC[A-Za-z0-9_-]{22}$/;
const ID_IN_TEXT_RE = /UC[A-Za-z0-9_-]{22}/;
const FETCH_TIMEOUT_MS = 20000;

export function isChannelId(value) {
  return CHANNEL_ID_RE.test((value || '').trim());
}

// Legacy corruption guard: an old buggy version stored the NUMBER returned by
// Array.push() under the 'channels' key. Anything non-array heals to [].
export function normalizeChannels(stored) {
  return Array.isArray(stored) ? stored : [];
}

export function feedUrl(channelId) {
  return `https://www.youtube.com/feeds/videos.xml?channel_id=${channelId}`;
}

// Shorts arrive as normal entries with a /shorts/ link — the href is kept
// as-is during parsing, so this is the single detection point.
export function isShorts(video) {
  return !!video && typeof video.link === 'string' && video.link.includes('/shorts/');
}

// Per-channel content scope. 'default' follows the global Shorts filter;
// legacy chShorts values are mapped so old settings keep working.
export const CH_SCOPE_ORDER = ['default', 'all', 'videos', 'shorts', 'live', 'videos-shorts', 'videos-live', 'shorts-live'];

export function scopeOf(ch) {
  if (ch && CH_SCOPE_ORDER.includes(ch.chScope)) return ch.chScope;
  if (ch && ch.chShorts === 'hide') return 'videos-live';
  if (ch && ch.chShorts === 'show') return 'all';
  return 'default';
}

// Entry filter for a resolved scope: 'live' channels contribute no entries
// (live is a separate event); 'shorts'/'shorts-live' contribute only Shorts.
export function scopePool(scope, videos, hideShortsGlobal) {
  if (scope === 'live') return [];
  if (scope === 'shorts' || scope === 'shorts-live') return videos.filter(isShorts);
  const hide = scope === 'videos' || scope === 'videos-live' || (scope === 'default' && hideShortsGlobal === true);
  return hide ? videos.filter((v) => !isShorts(v)) : videos;
}

export function scopeAllowsLive(scope) {
  return scope !== 'videos' && scope !== 'shorts';
}

// Quiet hours suppress OS notifications (badge still counts). Handles
// overnight windows (e.g. 23 -> 7) as well as same-day ones.
export function isQuietNow(settings, now = new Date()) {
  const q = settings && settings.quiet;
  if (!q || q.enabled !== true) return false;
  const h = now.getHours();
  if (q.start === q.end) return true;
  if (q.start < q.end) return h >= q.start && h < q.end;
  return h >= q.start || h < q.end;
}

// Live detection (returns { liveId, via, debug }):
//  1. /channel/ID/live — YouTube HTTP-redirects to a watch URL while live.
//     Logged-out/cookie-less fetches (like this one) usually get a 200
//     page instead of a redirect, so the body is accepted ONLY via its
//     canonical link pointing at a watch page. Loose "videoId" body matches
//     are ignored (offline pages embed trailer IDs; live pages embed many
//     unrelated IDs). Consent/bot pages surface as via 'consent'.
//  2. InnerTube channel Live tab (youtubei/v1/browse, params EgJsaXZl) —
//     JSON lists one tile per stream; currently-live tiles carry a
//     thumbnailOverlayTimeStatusRenderer with style "LIVE". Verified against
//     a real live channel (Lofi Girl): 32 LIVE-badged tiles; offline/invalid
//     channels return no tiles at all.
//  The old /embed/live_stream strategy was removed: a live embed page
//  contains no "videoId" at all (only the literal placeholder
//  "video_id":"live_stream") and an embedded_player_response with
//  previewPlayabilityStatus ERROR — "Error 153" without a Referer header,
//  "Error 152 / EMBEDDER_IDENTITY_DENIED" with one. Referer is a forbidden
//  header for service-worker fetch, so that endpoint can never resolve here.
// Best effort — network errors resolve to via 'network', callers treat null
// as "unknown". 'upcoming' means scheduled but not live; 'offline' means the
// tab resolved with no LIVE tile; 'browse-empty' means no tiles at all
// (invalid ID or empty tab).
const INNERTUBE_KEY = 'AIzaSyAO_FJ2SlqU8Q4STEHLGCilw_Y9_11qcW8';
const INNERTUBE_BROWSE_URL = `https://www.youtube.com/youtubei/v1/browse?key=${INNERTUBE_KEY}`;
const INNERTUBE_VISITOR_URL = `https://www.youtube.com/youtubei/v1/visitor_id?key=${INNERTUBE_KEY}`;
const LIVE_TAB_PARAMS = 'EgJsaXZl';
const VIDEO_ID_RE = /^[A-Za-z0-9_-]{11}$/;

export async function fetchLiveVideoId(channelId, fetchFn = fetch) {
  try {
    const res = await timedFetch(`https://www.youtube.com/channel/${channelId}/live`, {}, fetchFn);
    if (res.ok) {
      const url = res.url || '';
      if (/consent\.youtube\.com|accounts\.google\.com/.test(url)) {
        return { liveId: null, via: 'consent', debug: url.slice(0, 80) };
      }
      const m = url.match(/(?:[?&]v=|\/live\/|\/embed\/)([A-Za-z0-9_-]{11})/);
      if (m && m[1] !== 'live_stream') return { liveId: m[1], via: 'redirect', debug: url.slice(0, 120) };
      const html = await res.text();
      // ONLY trustworthy body signal: canonical link pointing at a watch page.
      // Loose "videoId" patterns were removed: an offline /live page returns
      // HTTP 200 with a trailer/featured videoId in the body while its
      // canonical is still the channel page (false-positive storm), and a
      // live /live page body contains many unrelated videoIds (wrong-id risk).
      const canon = typeof html === 'string'
        ? html.match(/<link rel="canonical" href="https:\/\/www\.youtube\.com\/watch\?v=([A-Za-z0-9_-]{11})/)
        : null;
      if (canon && canon[1] !== 'live_stream') return { liveId: canon[1], via: 'live-body', debug: '' };
    }
  } catch {
    // Fall through to the Live-tab strategy.
  }
  try {
    return await fetchLiveViaBrowse(channelId, fetchFn);
  } catch {
    return { liveId: null, via: 'network', debug: '' };
  }
}

async function fetchLiveViaBrowse(channelId, fetchFn = fetch) {
  let res = await postLiveTab(channelId, fetchFn, await getVisitorData(fetchFn));
  // Sporadic 403s are YouTube's bot mitigation for visitor-less requests:
  // refresh the token once and retry before giving up.
  if (res.status === 403) {
    res = await postLiveTab(channelId, fetchFn, await getVisitorData(fetchFn, true));
  }
  if (!res.ok) return { liveId: null, via: 'browse-http', debug: String(res.status) };
  let data;
  try {
    data = await res.json();
  } catch {
    return { liveId: null, via: 'browse-parse', debug: '' };
  }
  const found = findLiveTile(data);
  if (found.liveId) return { liveId: found.liveId, via: 'browse-live', debug: '' };
  if (!found.tilesSeen) return { liveId: null, via: 'browse-empty', debug: '' };
  if (found.upcoming) return { liveId: null, via: 'upcoming', debug: '' };
  return { liveId: null, via: 'offline', debug: '' };
}

// visitorData identifies the logged-out session to InnerTube. Without it,
// browse calls sporadically 403. Cached per service-worker lifetime; the
// browse call refreshes + retries once on 403.
let cachedVisitorData = '';

async function getVisitorData(fetchFn = fetch, force = false) {
  if (!force && cachedVisitorData) return cachedVisitorData;
  try {
    const res = await timedFetch(
      INNERTUBE_VISITOR_URL,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ context: { client: { clientName: 'TVHTML5', clientVersion: '7.20240702.00.00' } } }),
      },
      fetchFn
    );
    if (!res.ok) return cachedVisitorData;
    const data = await res.json();
    const vd = data && data.responseContext && data.responseContext.visitorData;
    if (typeof vd === 'string' && vd) cachedVisitorData = vd;
  } catch {
    // Keep the previous token (or empty) — browse still attempted.
  }
  return cachedVisitorData;
}

function browseClient(visitorData) {
  const client = { clientName: 'TVHTML5', clientVersion: '7.20240702.00.00', hl: 'en', gl: 'US' };
  if (visitorData) client.visitorData = visitorData;
  return client;
}

async function postLiveTab(channelId, fetchFn, visitorData) {
  const headers = { 'Content-Type': 'application/json', 'Accept-Language': 'en' };
  if (visitorData) headers['X-Goog-Visitor-Id'] = visitorData;
  return timedFetch(
    INNERTUBE_BROWSE_URL,
    {
      method: 'POST',
      headers,
      body: JSON.stringify({
        browseId: channelId,
        params: LIVE_TAB_PARAMS,
        context: { client: browseClient(visitorData) },
      }),
    },
    fetchFn
  );
}

// Strict walk over a Live-tab browse response. The old walker bubbled a LIVE
// marker found ANYWHERE up the whole tree and then attributed it to ANY
// videoId in the tree (trailer, featured video, …) — that false-positive
// storm is why every channel looked live. Now: only an object that IS a
// video tile (owns a videoId AND has tile fields) can be live, and only from
// a LIVE marker inside its OWN subtree (nested tiles excluded).
export function findLiveTile(root) {
  const out = { liveId: null, upcoming: false, tilesSeen: 0 };
  function ownedVideoId(o) {
    if (!o || typeof o !== 'object') return '';
    if (typeof o.videoId === 'string' && VIDEO_ID_RE.test(o.videoId) && o.videoId !== 'live_stream') return o.videoId;
    const ep = o.onSelectCommand && o.onSelectCommand.watchEndpoint;
    if (ep && typeof ep.videoId === 'string' && VIDEO_ID_RE.test(ep.videoId)) return ep.videoId;
    return '';
  }
  function isTileLike(o) {
    if (!o || typeof o !== 'object' || Array.isArray(o)) return false;
    if (!ownedVideoId(o)) return false;
    return !!(o.title || o.ownerText || o.thumbnail || o.viewCountText || o.lengthText || o.thumbnailOverlays);
  }
  function subtreeHasLive(o, depth) {
    if (!o || typeof o !== 'object' || depth > 8) return false;
    if (Array.isArray(o)) return o.some((x) => subtreeHasLive(x, depth + 1));
    if (o.thumbnailOverlayTimeStatusRenderer && o.thumbnailOverlayTimeStatusRenderer.style === 'LIVE') return true;
    if (o.metadataBadgeRenderer && o.metadataBadgeRenderer.style === 'BADGE_STYLE_TYPE_LIVE_NOW') return true;
    const values = Object.values(o);
    for (const v of values) {
      // Never cross into a nested tile: its badge belongs to it, not us.
      if (v && typeof v === 'object' && !Array.isArray(v) && isTileLike(v)) continue;
      if (subtreeHasLive(v, depth + 1)) return true;
    }
    return false;
  }
  function walk(o) {
    if (out.liveId || !o || typeof o !== 'object') return;
    if (Array.isArray(o)) {
      for (const x of o) {
        walk(x);
        if (out.liveId) return;
      }
      return;
    }
    if (typeof o.style === 'string' && /UPCOMING/.test(o.style)) out.upcoming = true;
    if (o.upcomingEventData) out.upcoming = true;
    if (isTileLike(o)) {
      out.tilesSeen += 1;
      if (subtreeHasLive(o, 0)) out.liveId = ownedVideoId(o);
      if (out.liveId) return;
    }
    for (const v of Object.values(o)) {
      walk(v);
      if (out.liveId) return;
    }
  }
  walk(root);
  return out;
}

// Upcoming-vs-live verification: a candidate liveId (from redirect,
// canonical or browse) can point at a scheduled premiere waiting room.
// The watch page player response settles it: upcoming pages carry
// upcomingEventData / "isUpcoming", live ones carry liveStreamability.
// Returns 'live' | 'upcoming' | 'unknown' (unknown = verify on next round,
// never block a possible live on a failed check).
export async function verifyLiveVideo(videoId, fetchFn = fetch) {
  try {
    const res = await timedFetch(`https://www.youtube.com/watch?v=${videoId}`, { headers: { 'Accept-Language': 'en' } }, fetchFn);
    if (!res.ok) return 'unknown';
    const html = await res.text();
    if (!html || typeof html !== 'string') return 'unknown';
    if (html.includes('upcomingEventData') || html.includes('"isUpcoming":true')) return 'upcoming';
    if (html.includes('liveStreamability') || html.includes('"isLive":true')) return 'live';
    return 'unknown';
  } catch {
    return 'unknown';
  }
}
// Channel avatar: first author thumbnail on the channel page. Returns '' when
// the page is a consent/bot shell or the layout changed — callers show an
// initial-letter placeholder instead.
export async function fetchChannelAvatar(channelId, fetchFn = fetch) {
  const pages = [
    `https://www.youtube.com/channel/${channelId}`,
    `https://www.youtube.com/channel/${channelId}/videos`,
  ];
  for (const pageUrl of pages) {
    try {
      const res = await timedFetch(pageUrl, { headers: { 'Accept-Language': 'en' } }, fetchFn);
      if (!res.ok) continue;
      const html = await res.text();
      const m = html.match(/"avatar":\s*\{"thumbnails":\[\{"url":"(https:[^"]+)"/);
      if (m) return m[1].replace(/\\\//g, '/').replace(/\\u0026/g, '&');
    } catch {
      continue;
    }
  }
  return '';
}

function pick(text, re) {
  const m = text.match(re);
  return m ? m[1] : '';
}

function decodeEntities(s) {
  return s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)));
}

// Every network call goes through here: hangs are worse than failures
// (a hanging fetch in the service worker leaves the popup spinner forever).
async function timedFetch(url, options, fetchFn = fetch) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    return await fetchFn(url, { ...options, signal: ctrl.signal });
  } catch (err) {
    if (err && err.name === 'AbortError') throw new Error('feed-network:timeout');
    throw new Error('feed-network');
  } finally {
    clearTimeout(timer);
  }
}

// Minimal Atom-reader: first <title> under <feed> is the channel name,
// each <entry> is one video. Regex-based because DOMParser is unreliable in SW.
// NOTE: Shorts come through as normal entries with a /shorts/ link — the href
// is used as-is, so no special-casing is needed.
export function parseFeedXml(xml) {
  if (!xml || !xml.includes('<feed')) {
    throw new Error('not-a-feed');
  }
  const channelTitle =
    decodeEntities(
      pick(xml, /<feed[^>]*>[\s\S]*?<title>([\s\S]*?)<\/title>/) ||
        pick(xml, /<author>\s*<name>([\s\S]*?)<\/name>/)
    ).trim();

  const channelId = pick(xml, /<yt:channelId>([^<]+)<\/yt:channelId>/).trim();
  const videos = [];
  const entryRe = /<entry>([\s\S]*?)<\/entry>/g;
  let m;
  while ((m = entryRe.exec(xml)) !== null) {
    const body = m[1];
    const videoId = pick(body, /<yt:videoId>([^<]+)<\/yt:videoId>/).trim();
    if (!videoId) continue;
    videos.push({
      videoId,
      title: decodeEntities(pick(body, /<title>([\s\S]*?)<\/title>/) || 'Untitled').trim(),
      published: pick(body, /<published>([^<]+)<\/published>/).trim(),
      link:
        pick(body, /<link[^>]*href="([^"]+)"/).trim() ||
        `https://www.youtube.com/watch?v=${videoId}`,
      thumb: pick(body, /<media:thumbnail[^>]*url="([^"]+)"/).trim(),
    });
  }
  return { channelId, channelTitle, videos };
}

export async function fetchChannelFeed(channelId, fetchFn = fetch) {
  const res = await timedFetch(feedUrl(channelId), {}, fetchFn);
  if (!res.ok) {
    throw new Error(`feed-http:${res.status}`);
  }
  const xml = await res.text();
  const feed = parseFeedXml(xml);
  if (!feed.channelId) feed.channelId = channelId;
  return feed;
}

// Accepts: raw channel ID, /channel/ URL, feeds URL, @handle (with or without @),
// /c/ or /user/ URL, watch URLs are rejected with 'not-a-channel'.
// Handle pages are scraped cookieless, so YouTube sometimes answers with a
// consent/bot page that contains no ID — that surfaces as 'unresolvable'.
export async function resolveChannelId(input, fetchFn = fetch) {
  const raw = (input || '').trim();
  if (!raw) throw new Error('empty');

  if (isChannelId(raw)) return raw;

  const direct =
    raw.match(/youtube\.com\/channel\/(UC[A-Za-z0-9_-]{22})/) ||
    raw.match(/channel_id=(UC[A-Za-z0-9_-]{22})/) ||
    raw.match(ID_IN_TEXT_RE);
  if (direct) {
    const id = direct[1] || direct[0];
    if (isChannelId(id)) return id;
  }

  if (/youtube\.com\/watch|youtu\.be\//.test(raw)) {
    throw new Error('not-a-channel');
  }

  // Candidate page URLs, tried in order. /c/ and /user/ are legacy and often
  // 404 — the handle form is the one that usually works.
  const handleMatch = raw.match(/@([A-Za-z0-9._-]+)/);
  const legacyMatch = raw.match(/youtube\.com\/(?:c|user)\/([A-Za-z0-9._-]+)/i);
  const bareWord = !/^https?:\/\//i.test(raw) && !raw.includes('/') && !raw.includes(' ');
  let pageUrls = [];
  if (handleMatch) {
    pageUrls = [`https://www.youtube.com/@${handleMatch[1]}`, `https://www.youtube.com/@${handleMatch[1]}/videos`];
  } else if (/^https?:\/\//i.test(raw)) {
    pageUrls = [raw];
  } else if (legacyMatch) {
    pageUrls = [`https://www.youtube.com/@${legacyMatch[1]}`, raw.startsWith('http') ? raw : `https://www.youtube.com/c/${legacyMatch[1]}`];
  } else if (bareWord) {
    pageUrls = [`https://www.youtube.com/@${raw.replace(/^@/, '')}`];
  } else if (/^UC[A-Za-z0-9_-]+$/.test(raw)) {
    throw new Error('unresolvable');
  } else {
    throw new Error('unresolvable');
  }

  // The page HEAD may contain channelIds of OTHER channels (featured,
  // trailer owner, topic links) BEFORE the owner's — e.g. @Halilcann's page
  // lists UCPnDqNhD1e51rcRqucXEg0A first while the owner is UCjpDOkJ90wnesiVMyUMs5xA.
  // The canonical link is authoritative for the page owner: check it first.
  const idPatterns = [
    /<link rel="canonical" href="https:\/\/www\.youtube\.com\/channel\/(UC[A-Za-z0-9_-]{22})/,
    /"channelId":"(UC[A-Za-z0-9_-]{22})"/,
    /"externalId":"(UC[A-Za-z0-9_-]{22})"/,
    /"browseId":"(UC[A-Za-z0-9_-]{22})"/,
    /youtube\.com\/channel\/(UC[A-Za-z0-9_-]{22})/,
    /channel_id=(UC[A-Za-z0-9_-]{22})/,
  ];
  for (const pageUrl of pageUrls) {
    let html = '';
    try {
      const res = await timedFetch(pageUrl, { headers: { 'Accept-Language': 'en' } }, fetchFn);
      if (!res.ok) continue;
      html = await res.text();
    } catch {
      continue;
    }
    for (const re of idPatterns) {
      const found = html.match(re);
      if (found && isChannelId(found[1])) return found[1];
    }
  }
  throw new Error('unresolvable');
}
