import { fetchChannelFeed, normalizeChannels, scopeOf, scopePool, scopeAllowsLive, isQuietNow, fetchLiveVideoId, verifyLiveVideo, fetchChannelAvatar, classifyVideo } from './modules/parser.js';

const ALARM_NAME = 'checkYouTubeRSS';
const BADGE_COLOR = '#dc2626';
const NOTIF_ICON = 'icons/bell-notif-128.png';

// One-time cleanup of the false-positive era: drop stale live flags (and the
// notified marker, so a genuinely-live channel notifies once on re-enable).
async function migrateOnce() {
  const { migrations = {} } = await chrome.storage.local.get(['migrations']);
  if (migrations.liveResetV1) return;
  const channels = await getChannels();
  await chrome.storage.local.set({
    channels: channels.map((c) => ({ ...c, isLive: false, liveVideoId: null, lastNotifiedLiveId: null })),
    migrations: { ...migrations, liveResetV1: true },
  });
  await updateBadge();
}

export const DEFAULT_SETTINGS = { checkIntervalMin: 15, notifyMode: 'all', skipShorts: false, quiet: { enabled: false, start: 23, end: 7 }, liveMode: 'auto', liveIntervalMin: 30 };
// notifyMode: 'all' (notification + badge) | 'badge' (badge only) | 'off'
// liveMode: 'off' (no live checks at all) | 'auto' (all channels unless chLive==='off') | 'manual' (only chLive==='on')

// Single choke point for channel reads: normalizes legacy corruption
// (non-array 'channels' value) and heals storage on the spot.
async function getChannels() {
  const { channels: stored } = await chrome.storage.local.get(['channels']);
  const channels = normalizeChannels(stored);
  if (channels !== stored) {
    await chrome.storage.local.set({ channels });
  }
  return channels;
}

async function getSettings() {
  const { settings = {} } = await chrome.storage.local.get(['settings']);
  const merged = { ...DEFAULT_SETTINGS, ...settings };
  if (![15, 30, 60, 120].includes(merged.checkIntervalMin)) merged.checkIntervalMin = 15;
  if (!['all', 'badge', 'off'].includes(merged.notifyMode)) merged.notifyMode = 'all';
  merged.skipShorts = merged.skipShorts === true;
  merged.rules = Array.isArray(merged.rules) ? merged.rules : [];
  merged.importantBypassQuiet = merged.importantBypassQuiet !== false;
  if (!['off', 'auto', 'manual'].includes(merged.liveMode)) merged.liveMode = 'auto';
  if (![15, 30, 60, 120].includes(merged.liveIntervalMin)) merged.liveIntervalMin = 30;
  const q = (merged.quiet && typeof merged.quiet === 'object') ? merged.quiet : {};
  merged.quiet = {
    enabled: q.enabled === true,
    start: Number.isInteger(q.start) && q.start >= 0 && q.start <= 23 ? q.start : 23,
    end: Number.isInteger(q.end) && q.end >= 0 && q.end <= 23 ? q.end : 7,
  };
  return merged;
}

async function ensureAlarm() {
  const { checkIntervalMin } = await getSettings();
  const alarm = await chrome.alarms.get(ALARM_NAME);
  if (!alarm || Math.round(alarm.periodInMinutes) !== checkIntervalMin) {
    await chrome.alarms.create(ALARM_NAME, { periodInMinutes: checkIntervalMin });
  }
}

chrome.runtime.onInstalled.addListener(async () => {
  await migrateOnce();
  await ensureAlarm();
  await updateBadge();
});

chrome.runtime.onStartup.addListener(async () => {
  await migrateOnce();
  await ensureAlarm();
  checkNewVideos();
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === ALARM_NAME) {
    checkNewVideos();
  }
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  if (changes.channels) {
    updateBadge();
  }
  if (changes.settings) {
    // Interval changed in popup settings -> rebuild the alarm.
    ensureAlarm();
    updateBadge();
  }
});

chrome.notifications.onClicked.addListener((notifId) => {
  if (notifId.startsWith('zil-test-')) {
    chrome.notifications.clear(notifId);
    return;
  }
  let videoId = null;
  if (notifId.startsWith('zil-live-')) videoId = notifId.slice(9);
  else if (notifId.startsWith('zil-')) videoId = notifId.slice(4);
  if (!videoId) return;
  chrome.tabs.create({ url: `https://www.youtube.com/watch?v=${videoId}` });
  chrome.notifications.clear(notifId);
  markVideoRead(videoId).catch((err) => console.warn('Zil: mark-read on click failed', err));
});

// Opening via an OS notification bubble marks that video read, same as
// opening from the popup. Finds the owning channel by live / latest / recent id.
async function markVideoRead(videoId) {
  const channels = await getChannels();
  let changed = false;
  const next = channels.map((c) => {
    const owns = c.liveVideoId === videoId || c.lastVideoId === videoId
      || (Array.isArray(c.recent) && c.recent.some((v) => v.videoId === videoId));
    if (!owns) return c;
    const readIds = Array.isArray(c.readIds) ? [...c.readIds] : [];
    if (readIds.includes(videoId)) return c;
    readIds.unshift(videoId);
    changed = true;
    return { ...c, readIds: readIds.slice(0, 100), unread: Math.max(0, (c.unread || 0) - 1) };
  });
  if (!changed) return;
  await chrome.storage.local.set({ channels: next });
  await updateBadge();
}

// Popup triggers a manual refresh through this (SW may be asleep otherwise).
// 'zil-check-live' probes a single stored channel for live status, persists
// the result, notifies on transition exactly like the loop, and responds
// with { ok, channelId, isLive, liveVideoId, liveVia, liveDebug,
// liveCheckedAt, notified }.
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg && msg.type === 'zil-check-now') {
    checkNewVideos()
      .then((result) => sendResponse(result))
      .catch((err) => sendResponse({ ok: false, error: String((err && err.message) || err) }));
    return true;
  }
  if (msg && msg.type === 'zil-check-live' && typeof msg.channelId === 'string') {
    probeOneChannelLive(msg.channelId)
      .then((result) => sendResponse(result))
      .catch((err) => sendResponse({ ok: false, error: String((err && err.message) || err) }));
    return true;
  }
  return false;
});

const AUTO_BACKUP_MAX = 5;
const AUTO_BACKUP_INTERVAL_MS = 24 * 3600 * 1000;

// Silent daily snapshot (channels + settings + theme + ui), capped. Restored
// from the popup's advanced settings; never prompts, never leaves the device.
async function maybeAutoBackup(channels) {
  try {
    const stored = await chrome.storage.local.get(['autoBackups', 'settings', 'theme', 'ui']);
    const backups = Array.isArray(stored.autoBackups) ? stored.autoBackups : [];
    const lastAt = backups.length ? new Date(backups[backups.length - 1].at).getTime() : 0;
    if (Date.now() - lastAt < AUTO_BACKUP_INTERVAL_MS) return;
    backups.push({
      at: new Date().toISOString(),
      channels,
      settings: stored.settings || {},
      theme: stored.theme || 'light',
      ui: stored.ui || {},
    });
    await chrome.storage.local.set({ autoBackups: backups.slice(-AUTO_BACKUP_MAX) });
  } catch (err) {
    console.warn('Zil: auto backup failed', err);
  }
}

async function updateBadge() {
  try {
    const { notifyMode } = await getSettings();
    if (notifyMode === 'off') {
      await chrome.action.setBadgeText({ text: '' });
      return;
    }
    const channels = await getChannels();
    const total = channels.reduce((n, c) => n + (c.unread || 0), 0);
    await chrome.action.setBadgeBackgroundColor({ color: BADGE_COLOR });
    await chrome.action.setBadgeText({ text: total > 0 ? String(total) : '' });
  } catch (err) {
    console.warn('Zil: badge update failed', err);
  }
}

async function notifyLive(channel, liveId, important = false) {
  let tr = false;
  try {
    const { user_selected_lang } = await chrome.storage.local.get(['user_selected_lang']);
    tr = user_selected_lang === 'tr';
  } catch {
    tr = false;
  }
  try {
    await chrome.notifications.create(`zil-live-${liveId}`, {
      type: 'basic',
      iconUrl: NOTIF_ICON,
      title: channel.name || 'Zil',
      message: tr ? 'Su an canli yayinda — izlemek icin tikla' : 'Live now — click to watch',
      requireInteraction: important === true,
    });
  } catch (err) {
    console.warn('Zil: live notification failed', err);
  }
}

// Per-channel override (chNotify) wins over the global mode; 'default'/missing
// means "follow global". Quiet hours downgrade any 'all' to 'badge'.
function effectiveMode(ch, globalMode, quietActive = false) {
  const m = ch.chNotify && ch.chNotify !== 'default' ? ch.chNotify : globalMode;
  const base = ['all', 'badge', 'off'].includes(m) ? m : 'all';
  if (quietActive && base === 'all') return 'badge';
  return base;
}

async function notifyNewVideo(channel, video, important = false) {
  const base = {
    iconUrl: NOTIF_ICON,
    title: channel.name || 'Zil',
    message: video.title,
    requireInteraction: important === true,
  };
  try {
    if (video.thumb) {
      // Rich notification with the video thumbnail; falls back to basic
      // below if the remote image is rejected.
      await chrome.notifications.create(`zil-${video.videoId}`, {
        ...base,
        type: 'image',
        imageUrl: video.thumb,
      });
    } else {
      await chrome.notifications.create(`zil-${video.videoId}`, { ...base, type: 'basic' });
    }
  } catch (err) {
    console.warn('Zil: rich notification failed, retrying basic', err);
    try {
      await chrome.notifications.create(`zil-${video.videoId}`, { ...base, type: 'basic' });
    } catch (err2) {
      console.warn('Zil: notification failed', err2);
    }
  }
}

// A video check is one tiny RSS fetch (~50-100KB static XML). A live probe is
// a channel HTML page (~1MB) plus an InnerTube JSON (~1MB) — roughly 25x the
// traffic and far more bot-mitigation attention. So live probes are throttled
// per channel (settings.liveIntervalMin); video checks always run. Manual
// probes bypass the throttle.
async function applyLiveCheck(base, live, notifyMode, now, quietActive = false, force = false, rules = [], importantBypassQuiet = true) {
  if (live.mode === 'off') {
    return { next: { ...base, isLive: false, liveVideoId: null }, counted: false, notified: false };
  }
  if (!force && base.liveCheckedAt && Date.parse(now) - new Date(base.liveCheckedAt).getTime() < live.intervalMin * 60000) {
    return { next: { ...base }, counted: false, notified: false, throttled: true };
  }
  const scope = scopeOf(base);
  const allowLive = scopeAllowsLive(scope) && (live.mode !== 'manual' || base.chLive === 'on') && base.chLive !== 'off';
  const probe = allowLive ? await fetchLiveVideoId(base.id) : { liveId: null, via: 'filtered', debug: '' };
  let liveId = probe && probe.liveId ? probe.liveId : null;
  let via = probe ? probe.via : 'none';
  // Upcoming premieres resolve like lives (waiting-room watch page) — verify
  // against the player response before believing the candidate.
  if (liveId) {
    const verdict = await verifyLiveVideo(liveId);
    console.log(`Zil: live verify ${liveId} -> ${verdict}`);
    if (verdict === 'upcoming') {
      liveId = null;
      via = 'upcoming';
    }
  }
  console.log(`Zil: live probe ${base.id} -> via=${via} liveId=${liveId || '-'}${probe && probe.debug ? ' debug=' + probe.debug : ''}`);
  const next = {
    ...base,
    isLive: !!liveId,
    liveVideoId: liveId,
    liveVia: via,
    liveDebug: probe && probe.debug ? probe.debug : '',
    liveCheckedAt: now,
  };
  let counted = false;
  let notified = false;
  if (liveId && base.lastNotifiedLiveId !== liveId) {
    next.lastNotifiedLiveId = liveId;
    // Lives carry no title at probe time: channel/both-field rules still apply.
    const verdictLive = classifyVideo(rules, '', base.name || '');
    if (verdictLive === 'block') {
      console.log(`Zil: live blocked by rule for ${base.id}`);
    } else {
      const quietForLive = quietActive && !(verdictLive === 'important' && importantBypassQuiet && notifyMode === 'all');
      const effLive = effectiveMode(base, notifyMode, quietForLive);
      if (effLive !== 'off') {
        next.unread = (next.unread || base.unread || 0) + 1;
        counted = true;
      }
      if (effLive === 'all') {
        await notifyLive(next, liveId, verdictLive === 'important');
        notified = true;
      }
    }
  }
  return { next, counted, notified };
}

async function probeOneChannelLive(channelId) {
  const settings = await getSettings();
  const { notifyMode } = settings;
  const live = { mode: settings.liveMode, intervalMin: settings.liveIntervalMin };
  const channels = await getChannels();
  const idx = channels.findIndex((c) => c && c.id === channelId);
  if (idx < 0) return { ok: false, error: 'unknown-channel' };
  const now = new Date().toISOString();
  try {
    const { next, counted, notified } = await applyLiveCheck(channels[idx], live, notifyMode, now, isQuietNow(settings), true, settings.rules, settings.importantBypassQuiet);
    const updated = channels.slice();
    updated[idx] = next;
    await chrome.storage.local.set({ channels: updated });
    await updateBadge();
    return {
      ok: true,
      channelId,
      isLive: next.isLive === true,
      liveVideoId: next.liveVideoId || null,
      liveVia: next.liveVia || 'none',
      liveDebug: next.liveDebug || '',
      liveCheckedAt: next.liveCheckedAt || now,
      notified: notified === true,
      counted: counted === true,
    };
  } catch (liveErr) {
    console.warn(`Zil: live check failed for ${channelId}`, liveErr);
    return { ok: false, error: String((liveErr && liveErr.message) || liveErr) };
  }
}

async function checkNewVideos() {
  const { notifyMode, skipShorts, checkIntervalMin, quiet, liveMode, liveIntervalMin, rules, importantBypassQuiet } = await getSettings();
  const quietActive = isQuietNow({ quiet });
  const live = { mode: liveMode, intervalMin: liveIntervalMin };
  const channels = await getChannels();
  if (!channels.length) {
    await updateBadge();
    return { ok: true, checked: 0, newVideos: 0 };
  }

  let newVideos = 0;
  let skipped = 0;
  const now = new Date().toISOString();
  const nowMs = Date.now();
  const updated = [];
  for (const ch of channels) {
    // Error backoff: repeatedly failing channels are checked less often.
    if (ch.nextRetryAt && nowMs < new Date(ch.nextRetryAt).getTime()) {
      skipped += 1;
      updated.push(ch);
      continue;
    }
    try {
      const feed = await fetchChannelFeed(ch.id);
      const newest = feed.videos[0];
      // With the Shorts filter on, track the newest non-Shorts video, but
      // still compare against the unfiltered newest so a fresh Shorts upload
      // does not re-notify for the video below it on the next run.
      // Per-channel content scope (videos / shorts / live combos).
      const scope = scopeOf(ch);
      const pool = scopePool(scope, feed.videos, skipShorts);
      const latest = pool[0];
      const next = {
        ...ch,
        name: feed.channelTitle || ch.name,
        lastCheck: now,
        lastOk: true,
        lastError: null,
        failCount: 0,
        nextRetryAt: null,
      };
      if (feed.videos.length) {
        // Video history for the unified homepage feed (max 15 per channel).
        next.recent = feed.videos.slice(0, 15).map((v) => ({
          videoId: v.videoId,
          title: v.title,
          published: v.published,
          link: v.link,
          thumb: v.thumb || '',
        }));
        if (!ch.lastReadAt && feed.videos[0].published) {
          // Seed so pre-existing videos don't all light up as new.
          next.lastReadAt = feed.videos[0].published;
        }
      }
      if (newest && !ch.lastVideoId) {
        // First successful read: baseline on the ACTUAL newest (even a Short)
        // without notifying, so enabling the filter later stays quiet.
        next.lastVideoId = newest.videoId;
        const shown = latest || newest;
        next.lastVideoTitle = shown.title;
        next.lastPublished = shown.published;
        next.lastVideoUrl = shown.link;
        next.lastThumb = shown.thumb || ch.lastThumb || '';
      } else if (newest && newest.videoId !== ch.lastVideoId && latest && latest.videoId !== ch.lastVideoId) {
        next.lastVideoId = latest.videoId;
        next.lastVideoTitle = latest.title;
        next.lastPublished = latest.published;
        next.lastVideoUrl = latest.link;
        next.lastThumb = latest.thumb || ch.lastThumb || '';
        const verdict = classifyVideo(rules, latest.title, next.name);
        if (verdict === 'block') {
          console.log(`Zil: blocked by rule: ${latest.title}`);
        } else {
          // Important videos bypass quiet hours (never a global/per-channel 'off').
          const quietForThis = quietActive && !(verdict === 'important' && importantBypassQuiet && notifyMode === 'all');
          const eff = effectiveMode(ch, notifyMode, quietForThis);
          if (eff !== 'off') {
            next.unread = (ch.unread || 0) + 1;
            newVideos += 1;
          }
          if (eff === 'all') {
            await notifyNewVideo(next, latest, verdict === 'important');
          }
        }
      } else if (latest) {
        // Nothing new, but refresh display fields (name/thumb may change).
        next.lastVideoTitle = latest.title;
        next.lastPublished = latest.published;
        next.lastVideoUrl = latest.link;
        next.lastThumb = latest.thumb || ch.lastThumb || '';
      }
      // Channel avatar: fetch once, keep forever (cheap, rarely changes).
      if (!ch.avatar) {
        try {
          const av = await fetchChannelAvatar(ch.id);
          if (av) next.avatar = av;
        } catch {
          // Placeholder stays.
        }
      }
      try {
        const { next: withLive, counted } = await applyLiveCheck(next, live, notifyMode, now, quietActive, false, rules, importantBypassQuiet);
        if (counted) newVideos += 1;
        updated.push(withLive);
      } catch (liveErr) {
        console.warn(`Zil: live check failed for ${ch.id}`, liveErr);
        updated.push(next);
      }
    } catch (err) {
      const code = String((err && err.message) || err);
      console.warn(`Zil: check failed for ${ch.id} (${code})`);
      // Exponential backoff: 15, 30, 60, 120 … capped at 480 min, and never
      // more often than the configured check interval.
      const failCount = (ch.failCount || 0) + 1;
      const delayMin = Math.min(Math.max(15 * 2 ** (failCount - 1), checkIntervalMin), 480);
      updated.push({
        ...ch,
        lastCheck: now,
        lastOk: false,
        lastError: code,
        failCount,
        nextRetryAt: new Date(nowMs + delayMin * 60000).toISOString(),
      });
    }
  }

  await chrome.storage.local.set({ channels: updated });
  await updateBadge();
  await maybeAutoBackup(updated);
  return { ok: true, checked: channels.length - skipped, newVideos, skipped };
}
