import { fetchChannelFeed, normalizeChannels, isShorts } from './modules/parser.js';

const ALARM_NAME = 'checkYouTubeRSS';
const BADGE_COLOR = '#dc2626';
const NOTIF_ICON = 'icons/bell-128.png';

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
  await ensureAlarm();
  await updateBadge();
});

chrome.runtime.onStartup.addListener(async () => {
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
  if (notifId.startsWith('zil-')) {
    const videoId = notifId.slice(4);
    chrome.tabs.create({ url: `https://www.youtube.com/watch?v=${videoId}` });
    chrome.notifications.clear(notifId);
  }
});

// Popup triggers a manual refresh through this (SW may be asleep otherwise).
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg && msg.type === 'zil-check-now') {
    checkNewVideos()
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

async function checkNewVideos() {
  const { notifyMode, skipShorts } = await getSettings();
  const channels = await getChannels();
  if (!channels.length) {
    await updateBadge();
    return { ok: true, checked: 0, newVideos: 0 };
  }

  let newVideos = 0;
  const now = new Date().toISOString();
  const updated = [];
  for (const ch of channels) {
    try {
      const feed = await fetchChannelFeed(ch.id);
      const newest = feed.videos[0];
      // With the Shorts filter on, track the newest non-Shorts video, but
      // still compare against the unfiltered newest so a fresh Shorts upload
      // does not re-notify for the video below it on the next run.
      const pool = skipShorts ? feed.videos.filter((v) => !isShorts(v)) : feed.videos;
      const latest = pool[0];
      const next = {
        ...ch,
        name: feed.channelTitle || ch.name,
        lastCheck: now,
        lastOk: true,
        lastError: null,
      };
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
        next.unread = (ch.unread || 0) + 1;
        newVideos += 1;
        if (notifyMode === 'all') {
          await notifyNewVideo(next, latest);
        }
      } else if (latest) {
        // Nothing new, but refresh display fields (name/thumb may change).
        next.lastVideoTitle = latest.title;
        next.lastPublished = latest.published;
        next.lastVideoUrl = latest.link;
        next.lastThumb = latest.thumb || ch.lastThumb || '';
      }
      updated.push(next);
    } catch (err) {
      const code = String((err && err.message) || err);
      console.warn(`Zil: check failed for ${ch.id} (${code})`);
      updated.push({ ...ch, lastCheck: now, lastOk: false, lastError: code });
    }
  }

  await chrome.storage.local.set({ channels: updated });
  await updateBadge();
  return { ok: true, checked: channels.length, newVideos };
}
