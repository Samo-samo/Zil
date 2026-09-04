// YouTube RSS helpers. Service-worker safe: no DOM, no chrome APIs — only fetch + RegExp.
// Kept chrome-free on purpose so it can be unit-tested with plain node.

const CHANNEL_ID_RE = /^UC[A-Za-z0-9_-]{22}$/;
const ID_IN_TEXT_RE = /UC[A-Za-z0-9_-]{22}/;

export function isChannelId(value) {
  return CHANNEL_ID_RE.test((value || '').trim());
}

export function feedUrl(channelId) {
  return `https://www.youtube.com/feeds/videos.xml?channel_id=${channelId}`;
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

// Minimal Atom/RSS-reader: first <title> under <feed> is the channel name,
// each <entry> is one video. Regex-based because DOMParser is unreliable in SW.
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
    });
  }
  return { channelId, channelTitle, videos };
}

export async function fetchChannelFeed(channelId, fetchFn = fetch) {
  const res = await fetchFn(feedUrl(channelId));
  if (!res.ok) {
    throw new Error(`feed-http:${res.status}`);
  }
  const xml = await res.text();
  const feed = parseFeedXml(xml);
  if (!feed.channelId) feed.channelId = channelId;
  return feed;
}

// Accepts: raw channel ID, /channel/ URL, feeds URL, @handle URL, /c/ or /user/ URL,
// or a bare handle. Watch-video URLs are rejected with 'not-a-channel'.
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

  let pageUrl = null;
  const handle = raw.match(/@([A-Za-z0-9._-]+)/);
  if (handle) {
    pageUrl = `https://www.youtube.com/@${handle[1]}`;
  } else if (/^https?:\/\//i.test(raw)) {
    pageUrl = raw;
  } else if (/^UC[A-Za-z0-9_-]+$/.test(raw)) {
    throw new Error('unresolvable');
  } else {
    pageUrl = `https://www.youtube.com/@${raw.replace(/^@/, '')}`;
  }

  let html = '';
  try {
    const res = await fetchFn(pageUrl, { headers: { 'Accept-Language': 'en' } });
    if (!res.ok) throw new Error(`fetch-http:${res.status}`);
    html = await res.text();
  } catch {
    throw new Error('unresolvable');
  }

  const found =
    html.match(/"channelId":"(UC[A-Za-z0-9_-]{22})"/) ||
    html.match(/"externalId":"(UC[A-Za-z0-9_-]{22})"/) ||
    html.match(/youtube\.com\/channel\/(UC[A-Za-z0-9_-]{22})/);
  if (found && isChannelId(found[1])) return found[1];
  throw new Error('unresolvable');
}
