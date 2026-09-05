import { lang } from './modules/localizator.js';
import { resolveChannelId, fetchChannelFeed, normalizeChannels, isShorts } from './modules/parser.js';

const DEFAULT_SETTINGS = { checkIntervalMin: 15, notifyMode: 'all', skipShorts: false };
const REFRESH_TIMEOUT_MS = 25000;

let selectedLang = '';
let uiStrings = {};

lang(selectedLang).then((strings) => { uiStrings = strings || {}; });

function t(path, fallback) {
  const value = path.split('.').reduce(
    (current, key) => (current && current[key] !== undefined ? current[key] : null),
    uiStrings
  );
  return value || fallback;
}

function switchPage(activePageId) {
    document.getElementById('homepage').style.display = 'none';
    document.getElementById('settingsPage').style.display = 'none';
    document.getElementById('addingPage').style.display = 'none';

    const activePage = document.getElementById(activePageId);
    activePage.style.display = 'block';

    activePage.style.animation = 'none';
    activePage.offsetHeight;
    activePage.style.animation = null;
}

document.getElementById('settingsBtn').addEventListener('click', () => {
    switchPage('settingsPage');
});

document.getElementById('addingPageBtn').addEventListener('click', () => {
    switchPage('addingPage');
});

document.getElementById('backBtnSettings').addEventListener('click', () => {
    switchPage('homepage');
});

document.getElementById('backBtnAdd').addEventListener('click', () => {
    switchPage('homepage');
});

document.getElementById('lang').addEventListener('change', async function(event) {
    const next = event.target.value;
    uiStrings = (await lang(next)) || {};
    renderHome();
});

const darkModeToggle = document.getElementById('darkMode');

const storageResult = await chrome.storage.local.get(['theme']);
if (storageResult && storageResult.theme === 'dark') {
    document.body.classList.add('dark');
    if (darkModeToggle) darkModeToggle.checked = true;
}

darkModeToggle.addEventListener('change', async () => {
    if (darkModeToggle.checked) {
        document.body.classList.add('dark');
        await chrome.storage.local.set({ theme: 'dark' });
    } else {
        document.body.classList.remove('dark');
        await chrome.storage.local.set({ theme: 'light' });
    }
});

// ---- Check settings (interval + notify mode + shorts filter) ----
const checkIntervalSelect = document.getElementById('checkInterval');
const notifyModeSelect = document.getElementById('notifyMode');
const skipShortsToggle = document.getElementById('skipShorts');

async function loadSettings() {
    const { settings = {} } = await chrome.storage.local.get(['settings']);
    const merged = { ...DEFAULT_SETTINGS, ...settings };
    if (checkIntervalSelect) checkIntervalSelect.value = String(merged.checkIntervalMin);
    if (notifyModeSelect) notifyModeSelect.value = merged.notifyMode;
    if (skipShortsToggle) skipShortsToggle.checked = merged.skipShorts === true;
}

async function saveSettings() {
    const settings = {
        checkIntervalMin: Number(checkIntervalSelect ? checkIntervalSelect.value : 15) || 15,
        notifyMode: notifyModeSelect ? notifyModeSelect.value : 'all',
        skipShorts: skipShortsToggle ? skipShortsToggle.checked : false,
    };
    await chrome.storage.local.set({ settings });
    // Background rebuilds the alarm via storage.onChanged.
}

if (checkIntervalSelect) checkIntervalSelect.addEventListener('change', saveSettings);
if (notifyModeSelect) notifyModeSelect.addEventListener('change', saveSettings);
if (skipShortsToggle) skipShortsToggle.addEventListener('change', saveSettings);

await loadSettings();

// ---- Test notification + backup (advanced settings) ----
document.getElementById('testNotifBtn').addEventListener('click', async () => {
    await chrome.notifications.create(`zil-test-${Date.now()}`, {
        type: 'basic',
        iconUrl: 'icons/bell-notif-128.png',
        title: t('settings.testTitle', 'Zil'),
        message: t('settings.testMsg', 'Notifications are working.'),
    });
    // The test only fires an OS notification bubble — it never touches
    // channels or the badge, so say so explicitly.
    showBackupStatus('settings.testDone', 'Test notification sent (badge untouched).');
});

function showBackupStatus(key, fallback, isError = false) {
    const el = document.getElementById('backupStatus');
    el.textContent = t(key, fallback);
    el.classList.toggle('error-line', isError);
    el.hidden = false;
}

document.getElementById('exportBtn').addEventListener('click', async () => {
    const { channels = [], settings = {}, theme = 'light', ui = {} } = await chrome.storage.local.get(['channels', 'settings', 'theme', 'ui']);
    const backup = {
        app: 'zil',
        version: 1,
        exportedAt: new Date().toISOString(),
        channels: normalizeChannels(channels),
        settings,
        theme,
        ui,
    };
    const blob = new Blob([JSON.stringify(backup, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `zil-backup-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
    showBackupStatus('settings.exportDone', 'Backup exported.');
});

document.getElementById('importBtn').addEventListener('click', () => {
    document.getElementById('importFile').click();
});

document.getElementById('importFile').addEventListener('change', async (event) => {
    const file = event.target.files && event.target.files[0];
    event.target.value = '';
    if (!file) return;
    try {
        const data = JSON.parse(await file.text());
        const incoming = normalizeChannels(Array.isArray(data) ? data : data && data.channels);
        if (!incoming.length && !(data && data.app === 'zil')) {
            throw new Error('bad-backup');
        }
        const valid = incoming.filter((c) => c && typeof c.id === 'string' && isChannelIdLike(c.id));
        if (!valid.length) {
            throw new Error('bad-backup');
        }
        const current = await getChannels();
        const byId = new Map(current.map((c) => [c.id, c]));
        for (const c of valid) {
            byId.set(c.id, { unread: 0, ...byId.get(c.id), ...c });
        }
        await chrome.storage.local.set({ channels: [...byId.values()] });
        if (data && data.settings && typeof data.settings === 'object') {
            await chrome.storage.local.set({ settings: data.settings });
            await loadSettings();
        }
        if (data && data.ui && typeof data.ui === 'object') {
            await chrome.storage.local.set({ ui: data.ui });
        }
        await syncBadge();
        await renderHome();
        showBackupStatus('settings.importDone', 'Backup imported.');
    } catch {
        showBackupStatus('settings.importError', 'Invalid backup file.', true);
    }
});

function isChannelIdLike(id) {
    return typeof id === 'string' && id.length > 0;
}

async function syncBadge() {
    const channels = await getChannels();
    const total = channels.reduce((n, c) => n + (c.unread || 0), 0);
    await chrome.action.setBadgeText({ text: total > 0 ? String(total) : '' });
}

// Same choke point as background.js: heals the legacy non-array value.
async function getChannels() {
    const { channels: stored } = await chrome.storage.local.get(['channels']);
    const channels = normalizeChannels(stored);
    if (channels !== stored) {
        await chrome.storage.local.set({ channels });
    }
    return channels;
}

// Maps parser error codes to messages. Feed 404 means the channel does not
// exist, so it is an input problem — not a generic fetch failure.
function addErrorText(code) {
    if (code === 'exists') return t('addingPage.errorExists', 'This channel is already tracked.');
    if (code === 'unresolvable' || code === 'not-a-channel' || code === 'feed-http:404' || code === 'empty') {
        return t('addingPage.errorInvalid', 'Could not find a channel for that input.');
    }
    const base = t('addingPage.errorFetch', 'Could not read the channel feed. Try again.');
    return code && code !== 'fetch' ? `${base} (${code})` : base;
}

function showAddError(code) {
    const el = document.getElementById('addError');
    el.textContent = addErrorText(code);
    el.hidden = false;
}

function hideAddError() {
    document.getElementById('addError').hidden = true;
}

document.getElementById('saveChannelBtn').addEventListener('click', async (event) => {
    const btn = event.currentTarget;
    const channelInput = document.getElementById('channelInput');
    const raw = channelInput ? channelInput.value.trim() : '';
    if (!raw) return;
    hideAddError();
    btn.disabled = true;
    const originalText = btn.textContent;
    btn.textContent = t('addingPage.adding', 'Adding…');
    try {
        const channelId = await resolveChannelId(raw);
        const channels = await getChannels();
        if (channels.some((c) => c.id === channelId)) {
            showAddError('exists');
            return;
        }
        const feed = await fetchChannelFeed(channelId);
        const { settings = {} } = await chrome.storage.local.get(['settings']);
        const pool = settings.skipShorts === true
            ? feed.videos.filter((v) => !isShorts(v))
            : feed.videos;
        const newest = feed.videos[0];
        const shown = pool[0] || newest;
        channels.push({
            id: channelId,
            name: feed.channelTitle || channelId,
            lastVideoId: newest ? newest.videoId : '',
            lastVideoTitle: shown ? shown.title : '',
            lastPublished: shown ? shown.published : '',
            lastVideoUrl: shown ? shown.link : '',
            lastThumb: shown && shown.thumb ? shown.thumb : '',
            recent: feed.videos.slice(0, 5).map((v) => ({
                videoId: v.videoId,
                title: v.title,
                published: v.published,
                link: v.link,
                thumb: v.thumb || '',
            })),
            lastReadAt: newest && newest.published ? newest.published : new Date().toISOString(),
            unread: 0,
            lastCheck: new Date().toISOString(),
            lastOk: true,
            lastError: null,
        });
        await chrome.storage.local.set({ channels });
        channelInput.value = '';
        switchPage('homepage');
        await renderHome();
    } catch (err) {
        showAddError(err && err.message ? err.message : 'fetch');
    } finally {
        btn.disabled = false;
        btn.textContent = originalText;
    }
});

document.getElementById('refreshBtn').addEventListener('click', async (event) => {
    const btn = event.currentTarget;
    const started = Date.now();
    btn.classList.add('spin');
    try {
        // Race against a timeout: if the service worker hangs (e.g. a fetch
        // never settles), the spinner must still stop.
        const timeout = new Promise((_, reject) =>
            setTimeout(() => reject(new Error('refresh-timeout')), REFRESH_TIMEOUT_MS)
        );
        await Promise.race([
            chrome.runtime.sendMessage({ type: 'zil-check-now' }),
            timeout,
        ]);
    } catch {
        // Storage listener refreshes the list anyway on next successful check.
    } finally {
        // Minimum visible spin: 2 full turns at 0.6s so fast refreshes
        // still give smooth feedback instead of a flicker.
        const elapsed = Date.now() - started;
        if (elapsed < 1200) {
            await new Promise((resolve) => setTimeout(resolve, 1200 - elapsed));
        }
        await renderHome();
        btn.classList.remove('spin');
    }
});

async function openVideo(channelId, videoId, published, url, active = true) {
    if (!url) return;
    await chrome.tabs.create({ url, active });
    // Opening a video marks everything up to it as read; newer items stay new.
    const channels = await getChannels();
    const stamp = published || new Date().toISOString();
    const next = channels.map((c) => {
        if (c.id !== channelId) return c;
        return {
            ...c,
            unread: 0,
            lastReadAt: !c.lastReadAt || stamp > c.lastReadAt ? stamp : c.lastReadAt,
        };
    });
    await chrome.storage.local.set({ channels: next });
    await syncBadge();
    await renderHome();
}

async function openChannel(channelId, active = true) {
    await chrome.tabs.create({ url: `https://www.youtube.com/channel/${channelId}`, active });
}

// Relative time without locale files: Intl handles the language.
function timeAgo(iso) {
    const ts = new Date(iso).getTime();
    if (Number.isNaN(ts)) return '';
    const seconds = Math.round((Date.now() - ts) / 1000);
    const locale = (typeof navigator !== 'undefined' && navigator.language) || 'en';
    try {
        const rtf = new Intl.RelativeTimeFormat(locale, { numeric: 'auto' });
        if (Math.abs(seconds) < 45) return rtf.format(-seconds, 'second');
        const units = [[31536000, 'year'], [2592000, 'month'], [86400, 'day'], [3600, 'hour'], [60, 'minute']];
        for (const [len, unit] of units) {
            if (Math.abs(seconds) >= len || unit === 'minute') {
                return rtf.format(-Math.round(seconds / len), unit);
            }
        }
    } catch {
        return new Date(ts).toLocaleDateString();
    }
    return '';
}

const CH_NOTIFY_ORDER = ['default', 'all', 'badge', 'off'];

function chNotifyLabel(state) {
    if (state === 'all') return t('settings.mode.all', 'Notification + badge');
    if (state === 'badge') return t('settings.mode.badge', 'Badge only');
    if (state === 'off') return t('settings.mode.off', 'Off');
    return t('settings.chDefault', 'Follow global setting');
}

async function cycleChNotify(channelId) {
    const channels = await getChannels();
    const next = channels.map((c) => {
        if (c.id !== channelId) return c;
        const cur = CH_NOTIFY_ORDER.includes(c.chNotify) ? c.chNotify : 'default';
        return { ...c, chNotify: CH_NOTIFY_ORDER[(CH_NOTIFY_ORDER.indexOf(cur) + 1) % CH_NOTIFY_ORDER.length] };
    });
    await chrome.storage.local.set({ channels: next });
    await syncBadge();
    await renderHome();
}

const BELL_SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"></path><path d="M13.73 21a2 2 0 0 1-3.46 0"></path>SLASH</svg>';
const BELL_SLASH = '<line x1="2" y1="2" x2="22" y2="22"></line>';

const CH_SHORTS_ORDER = ['default', 'hide', 'show'];

function chShortsLabel(state) {
    if (state === 'hide') return t('settings.chShortsHide', 'Hide Shorts');
    if (state === 'show') return t('settings.chShortsShow', 'Show Shorts');
    return t('settings.chShortsDefault', 'Follow global');
}

async function cycleChShorts(channelId) {
    const channels = await getChannels();
    const next = channels.map((c) => {
        if (c.id !== channelId) return c;
        const cur = CH_SHORTS_ORDER.includes(c.chShorts) ? c.chShorts : 'default';
        return { ...c, chShorts: CH_SHORTS_ORDER[(CH_SHORTS_ORDER.indexOf(cur) + 1) % CH_SHORTS_ORDER.length] };
    });
    await chrome.storage.local.set({ channels: next });
    await renderHome();
}

const SHORTS_SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="5" width="18" height="14" rx="3"></rect><polygon points="10 9 15 12 10 15 10 9"></polygon>SLASH</svg>';

async function removeChannel(channelId) {
    const channels = await getChannels();
    await chrome.storage.local.set({ channels: channels.filter((c) => c.id !== channelId) });
    await syncBadge();
    await renderHome();
}

async function markAllRead() {
    const channels = await getChannels();
    if (!channels.some((c) => c.unread > 0)) return;
    const now = new Date().toISOString();
    await chrome.storage.local.set({ channels: channels.map((c) => ({ ...c, unread: 0, lastReadAt: now })) });
    await syncBadge();
    await renderHome();
}

document.getElementById('markReadBtn').addEventListener('click', markAllRead);

function lastErrorText(code) {
    const prefix = t('home.lastError', 'Last check failed');
    return `${prefix} (${code})`;
}

// ---- Homepage views: unified video feed (default) vs per-channel list ----
async function getView() {
    const { ui = {} } = await chrome.storage.local.get(['ui']);
    return ui.view === 'channels' ? 'channels' : 'videos';
}

async function setView(view) {
    const { ui = {} } = await chrome.storage.local.get(['ui']);
    await chrome.storage.local.set({ ui: { ...ui, view } });
    await renderHome();
}

document.getElementById('viewVideosBtn').addEventListener('click', () => setView('videos'));
document.getElementById('viewChannelsBtn').addEventListener('click', () => setView('channels'));

async function renderHome() {
    const view = await getView();
    document.getElementById('viewVideosBtn').classList.toggle('active', view === 'videos');
    document.getElementById('viewChannelsBtn').classList.toggle('active', view === 'channels');
    document.getElementById('videoList').style.display = view === 'videos' ? 'flex' : 'none';
    document.getElementById('channelList').style.display = view === 'channels' ? 'flex' : 'none';
    if (view === 'videos') {
        await renderVideoList();
    } else {
        await renderChannelList();
    }
}

async function renderVideoList() {
    const list = document.getElementById('videoList');
    const empty = document.getElementById('homeEmpty');
    const channels = await getChannels();
    const { settings = {} } = await chrome.storage.local.get(['settings']);
    const items = [];
    for (const ch of channels) {
        const recent = Array.isArray(ch.recent) ? ch.recent : [];
        const hideShorts = ch.chShorts === 'hide' || (ch.chShorts !== 'show' && settings.skipShorts === true);
        for (const v of recent) {
            if (hideShorts && isShorts(v)) continue;
            items.push({
                ...v,
                channelId: ch.id,
                channelName: ch.name || ch.id,
                lastReadAt: ch.lastReadAt || '',
                unread: ch.unread || 0,
                liveHere: ch.isLive && ch.liveVideoId === v.videoId,
            });
        }
    }
    items.sort((a, b) => (b.published || '').localeCompare(a.published || ''));
    const shown = items.slice(0, 25);
    list.textContent = '';
    empty.style.display = shown.length ? 'none' : 'block';
    for (const item of shown) {
        const card = document.createElement('div');
        card.className = 'channel-card';
        card.title = t('home.openVideo', 'Open video');
        card.addEventListener('click', () => openVideo(item.channelId, item.videoId, item.published, item.link));
        card.addEventListener('auxclick', (e) => {
            if (e.button === 1) {
                e.preventDefault();
                openVideo(item.channelId, item.videoId, item.published, item.link, false);
            }
        });

        if (item.thumb) {
            const thumb = document.createElement('img');
            thumb.className = 'thumb';
            thumb.src = item.thumb;
            thumb.alt = '';
            thumb.loading = 'lazy';
            card.appendChild(thumb);
        } else {
            const missing = document.createElement('div');
            missing.className = 'thumb thumb-missing';
            missing.textContent = t('home.noThumb', 'No thumbnail');
            card.appendChild(missing);
        }

        const body = document.createElement('div');
        body.className = 'grow channel-body';

        // Title first, channel second (swapped vs the channel view).
        const title = document.createElement('strong');
        title.className = 'video-title';
        if (item.published && item.lastReadAt && item.published > item.lastReadAt) {
            const dot = document.createElement('span');
            dot.className = 'new-dot';
            dot.title = t('home.isNew', 'New');
            title.appendChild(dot);
            title.appendChild(document.createTextNode(' '));
        }
        title.appendChild(document.createTextNode(item.title || item.videoId));
        body.appendChild(title);

        const chan = document.createElement('button');
        chan.className = 'channel-link';
        chan.title = t('home.openChannel', 'Open channel');
        chan.textContent = item.channelName;
        chan.addEventListener('click', (e) => {
            e.stopPropagation();
            openChannel(item.channelId);
        });
        chan.addEventListener('auxclick', (e) => {
            if (e.button === 1) {
                e.preventDefault();
                e.stopPropagation();
                openChannel(item.channelId, false);
            }
        });
        body.appendChild(chan);

        const meta = document.createElement('div');
        meta.className = 'muted';
        if (item.published) {
            meta.textContent = timeAgo(item.published);
            meta.title = new Date(item.published).toLocaleString();
        }
        if (meta.textContent) body.appendChild(meta);

        const pills = document.createElement('div');
        pills.className = 'pill-row';
        let hasPill = false;
        if (item.liveHere) {
            const live = document.createElement('span');
            live.className = 'live-btn';
            const liveDot = document.createElement('span');
            liveDot.className = 'live-dot';
            live.appendChild(liveDot);
            live.appendChild(document.createTextNode(t('home.live', 'LIVE')));
            pills.appendChild(live);
            hasPill = true;
        }
        if (isShorts(item)) {
            const sh = document.createElement('span');
            sh.className = 'pill pill-shorts';
            sh.textContent = 'Shorts';
            pills.appendChild(sh);
            hasPill = true;
        }
        if (hasPill) body.appendChild(pills);

        card.appendChild(body);
        list.appendChild(card);
    }
}

async function renderChannelList() {
    const list = document.getElementById('channelList');
    const empty = document.getElementById('homeEmpty');
    const channels = await getChannels();
    list.textContent = '';
    empty.style.display = channels.length ? 'none' : 'block';
    for (const ch of channels) {
        const card = document.createElement('div');
        card.className = 'channel-card';
        card.title = t('home.openVideo', 'Open video');
        const videoUrl = ch.lastVideoUrl || '';
        const channelUrl = `https://www.youtube.com/channel/${ch.id}`;
        // Whole card opens the video; middle-click opens in a background tab.
        card.addEventListener('click', () => openVideo(ch.id, ch.lastVideoId, ch.lastPublished, videoUrl));
        card.addEventListener('auxclick', (e) => {
            if (e.button === 1) {
                e.preventDefault();
                openVideo(ch.id, ch.lastVideoId, ch.lastPublished, videoUrl, false);
            }
        });

        if (ch.lastThumb) {
            const thumb = document.createElement('img');
            thumb.className = 'thumb';
            thumb.src = ch.lastThumb;
            thumb.alt = '';
            thumb.loading = 'lazy';
            card.appendChild(thumb);
        } else {
            const missing = document.createElement('div');
            missing.className = 'thumb thumb-missing';
            missing.textContent = t('home.noThumb', 'No thumbnail');
            card.appendChild(missing);
        }

        const body = document.createElement('div');
        body.className = 'grow channel-body';

        const top = document.createElement('div');
        top.className = 'flex card-top';
        const name = document.createElement('button');
        name.className = 'channel-name grow';
        name.title = t('home.openChannel', 'Open channel');
        name.textContent = ch.name || ch.id;
        name.addEventListener('click', (e) => {
            e.stopPropagation();
            openChannel(ch.id);
        });
        name.addEventListener('auxclick', (e) => {
            if (e.button === 1) {
                e.preventDefault();
                e.stopPropagation();
                openChannel(ch.id, false);
            }
        });
        if (ch.unread > 0) {
            const dot = document.createElement('span');
            dot.className = 'unread-dot';
            dot.textContent = String(ch.unread);
            dot.title = t('home.unread', 'New videos');
            name.appendChild(document.createTextNode(' '));
            name.appendChild(dot);
        }
        const bell = document.createElement('button');
        bell.className = 'icon-btn small';
        const chState = CH_NOTIFY_ORDER.includes(ch.chNotify) ? ch.chNotify : 'default';
        bell.title = `${t('home.chNotify', 'Channel notifications')}: ${chNotifyLabel(chState)}`;
        bell.innerHTML = BELL_SVG.replace('SLASH', chState === 'off' ? BELL_SLASH : '');
        bell.classList.toggle('dimmed', chState === 'off' || chState === 'badge');
        bell.addEventListener('click', (e) => {
            e.stopPropagation();
            cycleChNotify(ch.id);
        });
        const shortsBtn = document.createElement('button');
        shortsBtn.className = 'icon-btn small';
        const shState = CH_SHORTS_ORDER.includes(ch.chShorts) ? ch.chShorts : 'default';
        shortsBtn.title = `${t('home.chShorts', 'Channel Shorts filter')}: ${chShortsLabel(shState)}`;
        shortsBtn.innerHTML = SHORTS_SVG.replace('SLASH', shState === 'hide' ? BELL_SLASH : '');
        shortsBtn.classList.toggle('dimmed', shState === 'hide');
        shortsBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            cycleChShorts(ch.id);
        });
        const del = document.createElement('button');
        del.className = 'icon-btn small';
        del.title = t('home.remove', 'Remove channel');
        del.textContent = '×';
        del.addEventListener('click', (e) => {
            e.stopPropagation();
            removeChannel(ch.id);
        });
        top.appendChild(name);
        top.appendChild(bell);
        top.appendChild(shortsBtn);
        top.appendChild(del);

        const latest = document.createElement('div');
        latest.className = 'latest-title';
        latest.textContent = ch.lastVideoTitle || ch.id;

        if (ch.isLive && ch.liveVideoId) {
            const liveUrl = `https://www.youtube.com/watch?v=${ch.liveVideoId}`;
            const live = document.createElement('button');
            live.className = 'live-btn';
            const liveDot = document.createElement('span');
            liveDot.className = 'live-dot';
            live.appendChild(liveDot);
            live.appendChild(document.createTextNode(t('home.live', 'LIVE')));
            live.title = t('home.openVideo', 'Open video');
            live.addEventListener('click', (e) => {
                e.stopPropagation();
                openVideo(ch.id, ch.liveVideoId, new Date().toISOString(), liveUrl);
            });
            live.addEventListener('auxclick', (e) => {
                if (e.button === 1) {
                    e.preventDefault();
                    e.stopPropagation();
                    openVideo(ch.id, ch.liveVideoId, new Date().toISOString(), liveUrl, false);
                }
            });
            body.appendChild(live);
        }
        body.appendChild(top);
        body.appendChild(latest);
        const meta = document.createElement('div');
        meta.className = 'muted';
        if (ch.lastPublished) {
            meta.textContent = timeAgo(ch.lastPublished);
            meta.title = new Date(ch.lastPublished).toLocaleString();
        }
        if (meta.textContent) body.appendChild(meta);

        if (ch.lastOk === false && ch.lastError) {
            const err = document.createElement('div');
            err.className = 'muted error-line';
            err.textContent = lastErrorText(ch.lastError);
            body.appendChild(err);
        }

        card.appendChild(body);
        list.appendChild(card);
    }
}

chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes.channels) {
        renderHome();
    }
});

await renderHome();

// First run after upgrade: no video history yet — pull once silently so the
// default video feed is not empty.
{
    const existing = await getChannels();
    const hasRecent = existing.some((c) => Array.isArray(c.recent) && c.recent.length);
    if (existing.length && !hasRecent) {
        document.getElementById('refreshBtn').click();
    }
}
