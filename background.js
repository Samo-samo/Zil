import { fetchChannelFeed, normalizeChannels, scopeOf, scopePool, scopeAllowsLive, fetchLiveVideoId, fetchChannelAvatar } from './modules/parser.js';

const ALARM_NAME = 'checkYouTubeRSS';
const BADGE_COLOR = '#dc2626';
const NOTIF_ICON = 'icons/bell-notif-128.png';

// Live detection is DISABLED: it catches real lives but flags every channel
// as live (false-positive storm). See .ai/LIVE.md. While false, checks clear
// stale isLive flags instead of probing.
const LIVE_ENABLED = true;

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

export const DEFAULT_SETTINGS = { checkIntervalMin: 15, notifyMode: 'all', skipShorts: false };
// notifyMode: 'all' (notification + badge) | 'badge' (badge only) | 'off'

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
  if (notifId.startsWith('zil-live-')) {
    const videoId = notifId.slice(9);
    chrome.tabs.create({ url: `https://www.youtube.com/watch?v=${videoId}` });
    chrome.notifications.clear(notifId);
  } else if (notifId.startsWith('zil-')) {
    const videoId = notifId.slice(4);
    chrome.tabs.create({ url: `https://www.youtube.com/watch?v=${videoId}` });
    chrome.notifications.clear(notifId);
  }
});

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

async function notifyLive(channel, liveId) {
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
    });
  } catch (err) {
    console.warn('Zil: live notification failed', err);
  }
}

// Per-channel override (chNotify) wins over the global mode; 'default'/missing
// means "follow global". Forward-compatible: C4 UI writes chNotify.
function effectiveMode(ch, globalMode) {
  const m = ch.chNotify && ch.chNotify !== 'default' ? ch.chNotify : globalMode;
  return ['all', 'badge', 'off'].includes(m) ? m : 'all';
}

async function notifyNewVideo(channel, video) {
  const base = {
    iconUrl: NOTIF_ICON,
    title: channel.name || 'Zil',
    message: video.title,
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

// Live detection: best effort, never fatal to the whole check.
// Dual strategy inside fetchLiveVideoId; result diagnostics are stored
// so the popup can show why a live stream was (not) seen.
async function applyLiveCheck(base, notifyMode, now) {
  if (!LIVE_ENABLED) {
    return { next: { ...base, isLive: false, liveVideoId: null }, counted: false, notified: false };
  }
  const scope = scopeOf(base);
  const allowLive = scopeAllowsLive(scope);
  const live = allowLive ? await fetchLiveVideoId(base.id) : { liveId: null, via: 'filtered', debug: '' };
  const liveId = live && live.liveId ? live.liveId : null;
  const next = {
    ...base,
    isLive: !!liveId,
    liveVideoId: liveId,
    liveVia: live ? live.via : 'none',
    liveDebug: live && live.debug ? live.debug : '',
    liveCheckedAt: now,
  };
  let counted = false;
  let notified = false;
  if (liveId && base.lastNotifiedLiveId !== liveId) {
    next.lastNotifiedLiveId = liveId;
    const effLive = effectiveMode(base, notifyMode);
    if (effLive !== 'off') {
      next.unread = (next.unread || base.unread || 0) + 1;
      counted = true;
    }
    if (effLive === 'all') {
      await notifyLive(next, liveId);
      notified = true;
    }
  }
  return { next, counted, notified };
}

async function probeOneChannelLive(channelId) {
  if (!LIVE_ENABLED) return { ok: false, error: 'disabled' };
  const { notifyMode } = await getSettings();
  const channels = await getChannels();
  const idx = channels.findIndex((c) => c && c.id === channelId);
  if (idx < 0) return { ok: false, error: 'unknown-channel' };
  const now = new Date().toISOString();
  try {
    const { next, counted, notified } = await applyLiveCheck(channels[idx], notifyMode, now);
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
  const { notifyMode, skipShorts, checkIntervalMin } = await getSettings();
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
        const eff = effectiveMode(ch, notifyMode);
        if (eff !== 'off') {
          next.unread = (ch.unread || 0) + 1;
          newVideos += 1;
        }
        if (eff === 'all') {
          await notifyNewVideo(next, latest);
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
        const { next: withLive, counted } = await applyLiveCheck(next, notifyMode, now);
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
  return { ok: true, checked: channels.length - skipped, newVideos, skipped };
}
