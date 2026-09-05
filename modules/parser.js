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

// Live detection, two strategies (returns { liveId, via, debug }):
//  1. /channel/ID/live redirects to a watch URL while live.
//  2. The embed player page contains a videoId only while live — verified
//     against a real offline embed page (no video identifiers at all there).
// Best effort — network errors throw, callers must catch and treat null as
// "unknown". Consent/bot pages surface as via 'consent'/'offline'.
export async function fetchLiveVideoId(channelId, fetchFn = fetch) {
  try {
    const res = await timedFetch(`https://www.youtube.com/channel/${channelId}/live`, {}, fetchFn);
    if (res.ok) {
      const url = res.url || '';
      if (/consent\.youtube\.com|accounts\.google\.com/.test(url)) {
        return { liveId: null, via: 'consent', debug: url.slice(0, 80) };
      }
      const m = url.match(/(?:[?&]v=|\/live\/|\/embed\/)([A-Za-z0-9_-]{11})/);
      if (m) return { liveId: m[1], via: 'redirect', debug: url.slice(0, 120) };
    }
  } catch {
    // Fall through to the embed strategy.
  }
  try {
    const res2 = await timedFetch(
      `https://www.youtube.com/embed/live_stream?channel=${channelId}`,
      { headers: { 'Accept-Language': 'en' } },
      fetchFn
    );
    if (res2.ok) {
      const html = await res2.text();
      const vid = html.match(/"videoId":"([A-Za-z0-9_-]{11})"/)
        || html.match(/\\"videoId\\":\\"([A-Za-z0-9_-]{11})/);
      if (vid) return { liveId: vid[1], via: 'embed', debug: '' };
      return { liveId: null, via: 'offline', debug: '' };
    }
    return { liveId: null, via: `embed-http`, debug: String(res2.status) };
  } catch {
    return { liveId: null, via: 'network', debug: '' };
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

  const idPatterns = [
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
