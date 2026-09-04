import { lang } from './modules/localizator.js';
import { resolveChannelId, fetchChannelFeed } from './modules/parser.js';

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
    renderChannels();
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

async function syncBadge() {
    const { channels = [] } = await chrome.storage.local.get(['channels']);
    const total = channels.reduce((n, c) => n + (c.unread || 0), 0);
    await chrome.action.setBadgeText({ text: total > 0 ? String(total) : '' });
}

function showAddError(code) {
    const el = document.getElementById('addError');
    const messages = {
        exists: t('addingPage.errorExists', 'This channel is already tracked.'),
        invalid: t('addingPage.errorInvalid', 'Could not find a channel for that input.'),
        fetch: t('addingPage.errorFetch', 'Could not read the channel feed. Try again.'),
    };
    el.textContent = messages[code] || messages.fetch;
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
        const { channels = [] } = await chrome.storage.local.get(['channels']);
        if (channels.some((c) => c.id === channelId)) {
            showAddError('exists');
            return;
        }
        const feed = await fetchChannelFeed(channelId);
        const latest = feed.videos[0];
        channels.push({
            id: channelId,
            name: feed.channelTitle || channelId,
            lastVideoId: latest ? latest.videoId : '',
            lastVideoTitle: latest ? latest.title : '',
            lastPublished: latest ? latest.published : '',
            lastVideoUrl: latest ? latest.link : '',
            unread: 0,
        });
        await chrome.storage.local.set({ channels });
        channelInput.value = '';
        switchPage('homepage');
        await renderChannels();
    } catch (err) {
        const code = err && err.message === 'unresolvable' ? 'invalid'
            : err && err.message === 'not-a-channel' ? 'invalid'
            : 'fetch';
        showAddError(code);
    } finally {
        btn.disabled = false;
        btn.textContent = originalText;
    }
});

document.getElementById('refreshBtn').addEventListener('click', async (event) => {
    const btn = event.currentTarget;
    btn.classList.add('spin');
    try {
        await chrome.runtime.sendMessage({ type: 'zil-check-now' });
    } catch {
        // Service worker may be waking up; badge/list refresh on storage change anyway.
    } finally {
        await renderChannels();
        btn.classList.remove('spin');
    }
});

async function openVideo(channelId, url) {
    if (!url) return;
    await chrome.tabs.create({ url });
    const { channels = [] } = await chrome.storage.local.get(['channels']);
    const next = channels.map((c) => (c.id === channelId ? { ...c, unread: 0 } : c));
    await chrome.storage.local.set({ channels: next });
    await syncBadge();
    await renderChannels();
}

async function removeChannel(channelId) {
    const { channels = [] } = await chrome.storage.local.get(['channels']);
    await chrome.storage.local.set({ channels: channels.filter((c) => c.id !== channelId) });
    await syncBadge();
    await renderChannels();
}

async function renderChannels() {
    const list = document.getElementById('channelList');
    const empty = document.getElementById('homeEmpty');
    const { channels = [] } = await chrome.storage.local.get(['channels']);
    list.textContent = '';
    empty.style.display = channels.length ? 'none' : 'block';
    for (const ch of channels) {
        const card = document.createElement('div');
        card.className = 'channel-card';

        const top = document.createElement('div');
        top.className = 'flex';
        const name = document.createElement('strong');
        name.className = 'grow channel-name';
        name.textContent = ch.name || ch.id;
        if (ch.unread > 0) {
            const dot = document.createElement('span');
            dot.className = 'unread-dot';
            dot.textContent = String(ch.unread);
            dot.title = t('home.unread', 'New videos');
            name.appendChild(document.createTextNode(' '));
            name.appendChild(dot);
        }
        const del = document.createElement('button');
        del.className = 'icon-btn small';
        del.title = t('home.remove', 'Remove channel');
        del.textContent = '×';
        del.addEventListener('click', () => removeChannel(ch.id));
        top.appendChild(name);
        top.appendChild(del);

        const latest = document.createElement('button');
        latest.className = 'link-btn';
        latest.title = t('home.openVideo', 'Open video');
        latest.textContent = ch.lastVideoTitle || ch.id;
        latest.addEventListener('click', () => openVideo(ch.id, ch.lastVideoUrl));

        const meta = document.createElement('div');
        meta.className = 'muted';
        if (ch.lastPublished) {
            meta.textContent = new Date(ch.lastPublished).toLocaleDateString();
        }

        card.appendChild(top);
        card.appendChild(latest);
        if (meta.textContent) card.appendChild(meta);
        list.appendChild(card);
    }
}

chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes.channels) {
        renderChannels();
    }
});

await renderChannels();
