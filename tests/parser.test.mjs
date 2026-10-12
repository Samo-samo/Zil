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
  resolveChannelCandidates,
  fetchChannelFeed,
  fetchLiveVideoId,
  verifyLiveVideo,
  findLiveTile,
  compareVersions,
  isQuietNow,
  scopeOf,
  scopePool,
  scopeIncludes,
  scopeFromBoxes,
  scopeAllowsLive,
  compileRulePattern,
  classifyVideo,
  classifyForChannel,
  matchRuleDetail,
  isNewVideo,
  decideVideoUpdate,
  countActualUnread,
  toggleRead,
  markRead,
  badgeCountForChannel,
  effectiveMode,
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

  it('keeps Unicode handles intact when building page urls', async () => {
    const seen = [];
    const fetchFn = async (u) => {
      seen.push(u);
      return { ok: true, text: async () => `<title>Yunus Emre Gündüz - YouTube</title><link rel="canonical" href="https://www.youtube.com/channel/${ID}">` };
    };
    const list = await resolveChannelCandidates('@YunusEmreGündüz', fetchFn);
    assert.equal(list[0].id, ID);
    assert.ok(seen[0].includes('@YunusEmreG'), 'handle not truncated, got ' + seen[0]);
    assert.ok(!seen[0].includes('@YunusEmreG/') && !seen[0].endsWith('@YunusEmreG'), 'full handle preserved');
  });

  it('returns ranked candidates instead of first-match only', async () => {
    const other = 'UCPnDqNhD1e51rcRqucXEg0A';
    const page = `<title>Some Channel - YouTube</title>`
      + `<link rel="canonical" href="https://www.youtube.com/channel/${ID}">`
      + `<body>{"channelId":"${other}"}</body>`;
    const fetchFn = async () => ({ ok: true, text: async () => page });
    const { resolveChannelCandidates: rcc } = await import('../modules/parser.js');
    const list = await rcc('@somebody', fetchFn);
    assert.equal(list.length, 2);
    assert.equal(list[0].id, ID);
    assert.equal(list[1].id, other);
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

describe('video update decision', () => {
  const V = (id) => ({ videoId: id, link: `https://www.youtube.com/watch?v=${id}` });
  const S = (id) => ({ videoId: id, link: `https://www.youtube.com/shorts/${id}` });

  it('baselines on first read', () => {
    const d = decideVideoUpdate([S('s1'), V('v1')], [V('v1')], null);
    assert.equal(d.action, 'baseline');
    assert.equal(d.video.videoId, 's1');
  });

  it('stays silent when only filtered items sit above the baseline', () => {
    // Yunus case: baseline is an older Shorts, newest is a newer Shorts,
    // newest allowed video is stale below the baseline.
    const feed = [S('s2'), S('s1'), V('v1')];
    const pool = [V('v1')];
    const d = decideVideoUpdate(feed, pool, 's1');
    assert.equal(d.action, 'silent');
    assert.equal(d.video.videoId, 's2');
  });

  it('notifies for the newest allowed video above the baseline', () => {
    const feed = [S('s2'), V('v2'), V('v1')];
    const pool = [V('v2'), V('v1')];
    const d = decideVideoUpdate(feed, pool, 'v1');
    assert.equal(d.action, 'notify');
    assert.equal(d.video.videoId, 'v2');
  });

  it('handles empty feeds and rotated-out baselines', () => {
    assert.equal(decideVideoUpdate([], [], 'x').action, 'none');
    const d = decideVideoUpdate([V('v9')], [V('v9')], 'v-gone');
    assert.equal(d.action, 'notify');
    assert.equal(d.video.videoId, 'v9');
  });
});

describe('unread reconciliation', () => {
  const ch = {
    lastReadAt: '2026-10-01T00:00:00Z',
    readIds: ['v0'],
    recent: [
      { videoId: 'v2', published: '2026-10-05T00:00:00Z' },
      { videoId: 'v1', published: '2026-10-02T00:00:00Z' },
      { videoId: 'v0', published: '2026-09-01T00:00:00Z' },
    ],
  };
  it('counts only openable new items', () => {
    assert.equal(countActualUnread(ch, false), 2);
    assert.equal(countActualUnread(ch, true), 3);
  });

  it('ignores blocked, read and muted items', () => {
    const blocked = { ...ch, recent: [...ch.recent, { videoId: 'vb', published: '2026-10-06T00:00:00Z', blocked: true }] };
    assert.equal(countActualUnread(blocked, false), 2);
    assert.equal(countActualUnread({ ...ch, chNotify: 'off' }, true), 0);
  });

  it('shares isNewVideo logic with the popup', () => {
    assert.ok(isNewVideo(ch, { videoId: 'vx', published: '2026-10-06T00:00:00Z' }));
    assert.ok(!isNewVideo(ch, { videoId: 'v0', published: '2026-10-06T00:00:00Z' }));
  });

  it('lets explicit unread marks beat the watermark', () => {
    // Auto-added old video: watermark-read, but user forces it unread.
    const old = { lastReadAt: '2026-10-10T00:00:00Z', readIds: [], unreadIds: [] };
    const v = { videoId: 'vx', published: '2026-10-01T00:00:00Z' };
    assert.ok(!isNewVideo(old, v));
    const forced = toggleRead(old, 'vx', false);
    assert.ok(isNewVideo(forced, v));
    assert.equal(countActualUnread({ ...forced, recent: [v] }, false), 1);
  });

  it('marks read unconditionally', () => {
    const ch = { readIds: [], unreadIds: ['vx'] };
    const marked = markRead(ch, 'vx');
    assert.deepEqual(marked.readIds, ['vx']);
    assert.deepEqual(marked.unreadIds, []);
    assert.equal(markRead(ch, null), ch);
  });
});

describe('read toggle and badge', () => {
  it('toggles read state both ways', () => {
    const ch = { id: 'A', readIds: ['v1'], unreadIds: [] };
    assert.deepEqual(toggleRead(ch, 'v2', true).readIds, ['v2', 'v1']);
    assert.deepEqual(toggleRead(ch, 'v2', true).unreadIds, []);
    const unmarked = toggleRead(ch, 'v1', false);
    assert.deepEqual(unmarked.readIds, []);
    assert.deepEqual(unmarked.unreadIds, ['v1']);
    assert.deepEqual(toggleRead(unmarked, 'v1', true).unreadIds, []);
    assert.equal(toggleRead(ch, null), ch);
  });

  it('derives one badge number for popup and worker', () => {
    const ch = {
      lastReadAt: '2026-10-01T00:00:00Z',
      readIds: [],
      recent: [
        { videoId: 'v2', published: '2026-10-05T00:00:00Z' },
        { videoId: 'v1', published: '2026-09-01T00:00:00Z' },
      ],
    };
    assert.equal(badgeCountForChannel(ch, {}), 1);
    assert.equal(badgeCountForChannel({ ...ch, paused: true }, {}), 0);
    assert.equal(badgeCountForChannel({ ...ch, chNotify: 'off' }, {}), 0);
    assert.equal(badgeCountForChannel({ ...ch, isLive: true, liveVideoId: 'L1' }, {}), 2);
  });

  it('excludes scope-hidden and blocked items from the badge', () => {
    const ch = {
      lastReadAt: '2026-10-01T00:00:00Z',
      readIds: [],
      recent: [
        { videoId: 's1', published: '2026-10-05T00:00:00Z', link: 'https://www.youtube.com/shorts/s1' },
        { videoId: 'v1', published: '2026-10-02T00:00:00Z', link: 'https://www.youtube.com/watch?v=v1' },
      ],
    };
    assert.equal(badgeCountForChannel(ch, {}), 2);
    assert.equal(badgeCountForChannel({ ...ch, chScope: 'videos' }, {}), 1);
    assert.equal(badgeCountForChannel({ ...ch, chScope: 'live' }, {}), 0);
    const blocked = { ...ch, recent: ch.recent.map((v) => ({ ...v, blocked: v.videoId === 's1' })) };
    assert.equal(badgeCountForChannel(blocked, {}), 1);
  });

  it('keeps the shared notify-mode helper sane', () => {
    assert.equal(effectiveMode({}, 'all'), 'all');
    assert.equal(effectiveMode({ chNotify: 'off' }, 'all'), 'off');
    assert.equal(effectiveMode({}, 'all', true), 'badge');
  });
});

describe('version compare', () => {
  it('orders semver with v prefix tolerated', () => {
    assert.equal(compareVersions('v1.4.0', '1.3.1'), 1);
    assert.equal(compareVersions('1.3.1', 'v1.4.0'), -1);
    assert.equal(compareVersions('1.3.1', '1.3.1'), 0);
    assert.equal(compareVersions('1.3', '1.3.0'), 0);
    assert.equal(compareVersions('1.10.0', '1.9.0'), 1);
    assert.equal(compareVersions('', '1.0.0'), -1);
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

  it('maps checkbox sets to scopes and back', () => {
    assert.equal(scopeFromBoxes(['videos', 'shorts', 'live']), 'all');
    assert.equal(scopeFromBoxes(['videos', 'live']), 'videos-live');
    assert.equal(scopeFromBoxes(['shorts', 'live']), 'shorts-live');
    assert.equal(scopeFromBoxes(['live']), 'live');
    assert.equal(scopeFromBoxes([]), 'default');
    assert.ok(scopeIncludes('videos-shorts', 'videos'));
    assert.ok(!scopeIncludes('videos-shorts', 'live'));
    assert.ok(scopeIncludes('all', 'shorts'));
    assert.ok(!scopeIncludes('default', 'videos'));
  });
});

describe('rule wildcards', () => {
  it('treats * as match-anything and keeps | alternation', () => {
    assert.equal(classifyVideo([{ id: '1', pattern: '*', field: 'title', action: 'block', enabled: true }], 'Anything at all', 'Ch'), 'block');
    assert.equal(classifyVideo([{ id: '1', pattern: 'EKİP', field: 'title', action: 'notify', enabled: true }], 'ekip videosu', 'Ch'), 'notify');
    assert.equal(classifyVideo([{ id: '1', pattern: 'shorts|trailer', field: 'title', action: 'block', enabled: true }], 'New trailer', 'Ch'), 'block');
  });

  it('matches special chars literally', () => {
    const r = [{ id: '1', pattern: 'C++ (part 1)', field: 'title', action: 'block', enabled: true }];
    assert.equal(classifyVideo(r, 'Learn C++ (part 1) today', 'Ch'), 'block');
    assert.equal(classifyVideo(r, 'Learn CXX part 1 today', 'Ch'), 'notify');
  });

  it('rejects empty patterns', () => {
    assert.throws(() => compileRulePattern(''), /empty-pattern/);
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
