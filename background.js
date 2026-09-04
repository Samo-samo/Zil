import { fetchChannelFeed } from './modules/parser.js';

const ALARM_NAME = 'checkYouTubeRSS';
const CHECK_INTERVAL_MIN = 15;
const BADGE_COLOR = '#dc2626';
const NOTIF_ICON = 'icons/bell-128.png';

async function ensureAlarm() {
  const alarm = await chrome.alarms.get(ALARM_NAME);
  if (!alarm) {
    await chrome.alarms.create(ALARM_NAME, { periodInMinutes: CHECK_INTERVAL_MIN });
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

// Badge mirrors total unread across channels; storage change wakes the SW.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.channels) {
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
      .catch((err) => sendResponse({ ok: false, error: String(err && err.message || err) }));
    return true;
  }
  return false;
});

async function updateBadge() {
  try {
    const { channels = [] } = await chrome.storage.local.get(['channels']);
    const total = channels.reduce((n, c) => n + (c.unread || 0), 0);
    await chrome.action.setBadgeBackgroundColor({ color: BADGE_COLOR });
    await chrome.action.setBadgeText({ text: total > 0 ? String(total) : '' });
  } catch (err) {
    console.warn('Zil: badge update failed', err);
  }
}

async function notifyNewVideo(channel, video) {
  try {
    await chrome.notifications.create(`zil-${video.videoId}`, {
      type: 'basic',
      iconUrl: NOTIF_ICON,
      title: channel.name || 'Zil',
      message: video.title,
    });
  } catch (err) {
    console.warn('Zil: notification failed', err);
  }
}

async function checkNewVideos() {
  const { channels = [] } = await chrome.storage.local.get(['channels']);
  if (!channels.length) {
    await updateBadge();
    return { ok: true, checked: 0, newVideos: 0 };
  }

  let newVideos = 0;
  const updated = [];
  for (const ch of channels) {
    try {
      const feed = await fetchChannelFeed(ch.id);
      const latest = feed.videos[0];
      const next = { ...ch, name: feed.channelTitle || ch.name };
      if (latest) {
        next.lastVideoTitle = latest.title;
        next.lastPublished = latest.published;
        next.lastVideoUrl = latest.link;
        if (!ch.lastVideoId) {
          // First successful read: baseline without notifying.
          next.lastVideoId = latest.videoId;
        } else if (ch.lastVideoId !== latest.videoId) {
          next.lastVideoId = latest.videoId;
          next.unread = (ch.unread || 0) + 1;
          newVideos += 1;
          await notifyNewVideo(next, latest);
        }
      }
      updated.push(next);
    } catch (err) {
      console.warn(`Zil: check failed for ${ch.id}`, err);
      updated.push(ch);
    }
  }

  await chrome.storage.local.set({ channels: updated });
  await updateBadge();
  return { ok: true, checked: channels.length, newVideos };
}
