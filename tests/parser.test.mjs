// Zil parser unit tests. modules/parser.js is intentionally chrome-free and
// SW-safe, so the whole suite runs with plain `node --test tests/`.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseFeedXml,
  isChannelId,
  feedUrl,
  isShorts,
  normalizeChannels,
  resolveChannelId,
  fetchChannelFeed,
  fetchLiveVideoId,
  verifyLiveVideo,
  findLiveTile,
  isQuietNow,
  scopeOf,
  scopePool,
  scopeAllowsLive,
  classifyVideo,
  classifyForChannel,
  matchRuleDetail,
} from '../modules/parser.js';

const ID = 'UC1234567890123456789012';

const SAMPLE_FEED = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns:yt="http://www.youtube.com/xml/schemas/2015" xmlns:media="http://search.yahoo.com/mrss/" xmlns="http://www.w3.org/2005/Atom">
  <yt:channelId>${ID}</yt:channelId>
  <title>Test &amp; Kanal</title>
  <entry>
    <yt:videoId>VIDAAA111111111111111</yt:videoId>
    <title>Normal Video</title>
    <link rel="alternate" href="https://www.youtube.com/watch?v=VIDAAA111111111111111"/>
    <published>2026-09-04T10:00:00+00:00</published>
    <media:group><media:thumbnail url="https://i4.ytimg.com/vi/VIDAAA111111111111111/hqdefault.jpg"/></media:group>
  </entry>
  <entry>
    <yt:videoId>VIDBBB222222222222222</yt:videoId>
    <title>Bir Short</title>
    <link rel="alternate" href="https://www.youtube.com/shorts/VIDBBB222222222222222"/>
    <published>2026-09-01T10:00:00+00:00</published>
  </entry>
</feed>`;

describe('parseFeedXml', () => {
  it('parses channel, entries, entities and thumbs', () => {
    const feed = parseFeedXml(SAMPLE_FEED);
    assert.equal(feed.channelId, ID);
    assert.equal(feed.channelTitle, 'Test & Kanal');
    assert.equal(feed.videos.length, 2);
    assert.equal(feed.videos[0].link, 'https://www.youtube.com/watch?v=VIDAAA111111111111111');
    assert.equal(feed.videos[0].thumb, 'https://i4.ytimg.com/vi/VIDAAA111111111111111/hqdefault.jpg');
    assert.equal(feed.videos[1].thumb, '');
  });

  it('keeps Shorts hrefs as-is', () => {
    const feed = parseFeedXml(SAMPLE_FEED);
    assert.ok(feed.videos[1].link.includes('/shorts/'));
  });

  it('rejects non-feed bodies (consent/bot pages)', () => {
    assert.throws(() => parseFeedXml('<html>consent</html>'), /not-a-feed/);
  });
});

describe('channel ids and urls', () => {
  it('validates ids', () => {
    assert.ok(isChannelId(ID));
    assert.ok(!isChannelId('UCkisa'));
  });

  it('builds feed urls', () => {
    assert.ok(feedUrl(ID).includes(`channel_id=${ID}`));
  });

  it('detects shorts by link', () => {
    assert.ok(isShorts({ link: 'https://www.youtube.com/shorts/ABC' }));
    assert.ok(!isShorts({ link: 'https://www.youtube.com/watch?v=ABC' }));
    assert.ok(!isShorts(null));
  });

  it('normalizes legacy storage corruption', () => {
    assert.deepEqual(normalizeChannels(1), []);
    assert.deepEqual(normalizeChannels(undefined), []);
    const arr = [{ id: ID }];
    assert.equal(normalizeChannels(arr), arr);
  });

  it('resolves ids, channel urls and feed urls without fetch', async () => {
    assert.equal(await resolveChannelId(ID), ID);
    assert.equal(await resolveChannelId(`https://www.youtube.com/channel/${ID}/videos`), ID);
    await assert.rejects(resolveChannelId('https://www.youtube.com/watch?v=dQw4w9WgXcQ'), /not-a-channel/);
    await assert.rejects(resolveChannelId('   '), /empty/);
  });

  it('resolves handles via page scrape, canonical first', async () => {
    const other = 'UCPnDqNhD1e51rcRqucXEg0A';
    const page = `<link rel="canonical" href="https://www.youtube.com/channel/${ID}">`
      + `<body>{"channelId":"${other}","externalId":"${other}"}</body>`;
    const fetchFn = async () => ({ ok: true, text: async () => page });
    assert.equal(await resolveChannelId('@somebody', fetchFn), ID);
  });

  it('rejects unresolvable handles', async () => {
    const fetchFn = async () => ({ ok: false, status: 404, text: async () => '' });
    await assert.rejects(resolveChannelId('@yok', fetchFn), /unresolvable/);
  });

  it('surfaces feed http errors distinctly', async () => {
    await assert.rejects(fetchChannelFeed(ID, async () => ({ ok: false, status: 404 })), /feed-http:404/);
    await assert.rejects(fetchChannelFeed(ID, async () => { throw new TypeError('down'); }), /feed-network/);
  });
});

describe('live detection', () => {
  it('detects redirect urls', async () => {
    const r = await fetchLiveVideoId('UCx', async () => ({ ok: true, url: 'https://www.youtube.com/watch?v=ABCDEFGHIJK' }));
    assert.equal(r.liveId, 'ABCDEFGHIJK');
    assert.equal(r.via, 'redirect');
  });

  it('trusts only watch canonicals in /live bodies', async () => {
    const offline = `<link rel="canonical" href="https://www.youtube.com/channel/UCx">`
      + `<body>"videoId":"KPYtmPz5pbU","videoId":"KPYtmPz5pbU"</body>`;
    const r = await fetchLiveVideoId('UCx', async (u) => (u.includes('/embed/')
      ? { ok: true, text: async () => '<html></html>' }
      : { ok: true, url: 'https://www.youtube.com/channel/UCx/live', text: async () => offline }));
    assert.equal(r.liveId, null);
  });

  it('finds live tiles strictly (no cross-tile attribution)', () => {
    const tile = (id, live) => ({
      videoId: id,
      title: { runs: [{ text: 'T' }] },
      thumbnailOverlays: live ? [{ thumbnailOverlayTimeStatusRenderer: { style: 'LIVE' } }] : [],
    });
    assert.equal(findLiveTile({ contents: [tile('AAAAAAAAAAA', true)] }).liveId, 'AAAAAAAAAAA');
    const storm = findLiveTile({
      header: { style: 'LIVE' },
      contents: [tile('AAAAAAAAAAA', false)],
      trailer: { videoId: 'BBBBBBBBBBB', title: 'x' },
    });
    assert.equal(storm.liveId, null);
    assert.equal(findLiveTile({}).tilesSeen, 0);
  });

  it('classifies watch pages as live/upcoming/unknown', async () => {
    const mock = (html, status = 200) => async () => (status !== 200 ? { ok: false, status } : { ok: true, text: async () => html });
    assert.equal(await verifyLiveVideo('V', mock('upcomingEventData')), 'upcoming');
    assert.equal(await verifyLiveVideo('V', mock('liveStreamability')), 'live');
    assert.equal(await verifyLiveVideo('V', mock('plain')), 'unknown');
    assert.equal(await verifyLiveVideo('V', mock('', 404)), 'unknown');
  });
});

describe('quiet hours', () => {
  const at = (h) => new Date(2026, 0, 1, h, 30);
  it('handles overnight windows and edges', () => {
    const q = { enabled: true, start: 23, end: 7 };
    assert.equal(isQuietNow({ quiet: q }, at(2)), true);
    assert.equal(isQuietNow({ quiet: q }, at(23)), true);
    assert.equal(isQuietNow({ quiet: q }, at(7)), false);
    assert.equal(isQuietNow({ quiet: q }, at(12)), false);
  });

  it('handles same-day windows and disabled state', () => {
    assert.equal(isQuietNow({ quiet: { enabled: true, start: 9, end: 17 } }, at(12)), true);
    assert.equal(isQuietNow({ quiet: { enabled: false, start: 23, end: 7 } }, at(2)), false);
    assert.equal(isQuietNow(null, at(2)), false);
  });
});

describe('content scope', () => {
  const vs = [{ link: 'w?v=1' }, { link: 'x/shorts/2' }];
  it('maps legacy chShorts and filters pools', () => {
    assert.equal(scopeOf({ chShorts: 'hide' }), 'videos-live');
    assert.equal(scopeOf({ chShorts: 'show' }), 'all');
    assert.equal(scopeOf({}), 'default');
    assert.equal(scopePool('videos', vs, false).length, 1);
    assert.equal(scopePool('shorts', vs, false).length, 1);
    assert.equal(scopePool('live', vs, false).length, 0);
    assert.equal(scopePool('shorts-live', vs, false).length, 1);
    assert.equal(scopeAllowsLive('shorts-live'), true);
    assert.equal(scopeAllowsLive('videos'), false);
  });
});

describe('rules engine', () => {
  const rules = [
    { id: '1', pattern: 'trailer|fragman', field: 'title', action: 'block', enabled: true },
    { id: '2', pattern: 'Lofi', field: 'channel', action: 'important', enabled: true },
  ];

  it('matches with first-win and skips invalid', () => {
    assert.equal(classifyVideo(rules, 'New TRAILER', 'Any'), 'block');
    assert.equal(classifyVideo(rules, 'New video', 'Lofi Girl'), 'important');
    assert.equal(classifyVideo(rules, 'New video', 'Other'), 'notify');
    assert.equal(classifyVideo(null, 'x', 'y'), 'notify');
    const tricky = [
      { id: 'd', pattern: 'xyz', field: 'title', action: 'block', enabled: false },
      { id: 'e', pattern: '([invalid', field: 'title', action: 'block', enabled: true },
      { id: 'h', pattern: 'xyz', field: 'title', action: 'important', enabled: true },
    ];
    assert.equal(classifyVideo(tricky, 'xyz', 'C'), 'important');
  });

  it('prefers channel rules and attributes matches', () => {
    const ch = [{ id: 'c1', pattern: 'vlog', field: 'title', action: 'block', enabled: true }];
    const gl = [{ id: 'g1', pattern: 'vlog', field: 'title', action: 'important', enabled: true }];
    assert.equal(classifyForChannel(ch, gl, 'My VLOG', 'Ch'), 'block');
    const d = matchRuleDetail(ch, gl, 'My VLOG', 'Ch');
    assert.equal(d.action, 'block');
    assert.equal(d.rule.id, 'c1');
    const n = matchRuleDetail([], [], 'x', 'y');
    assert.equal(n.action, 'notify');
    assert.equal(n.rule, null);
  });
});
