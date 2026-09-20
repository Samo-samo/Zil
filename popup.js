import { lang } from './modules/localizator.js';
import { resolveChannelId, fetchChannelFeed, normalizeChannels, isShorts, fetchChannelAvatar, scopeOf, scopePool, CH_SCOPE_ORDER, classifyForChannel, matchRuleDetail } from './modules/parser.js';

const DEFAULT_SETTINGS = { checkIntervalMin: 15, notifyMode: 'all', skipShorts: false, quiet: { enabled: false, start: 23, end: 7 }, liveMode: 'auto', liveIntervalMin: 30 };
const REFRESH_TIMEOUT_MS = 25000;

let selectedLang = '';
let uiStrings = {};
let feedLimit = 25;
let importantOnly = false;
// Cached global live mode ('off' hides all live UI). Refreshed in renderHome.
let liveModeCache = 'auto';

lang(selectedLang).then(async (strings) => {
    uiStrings = strings || {};
    // First paint happens before locales arrive (all-English fallbacks);
    // repaint once the real strings land.
    try {
        await renderHome();
    } catch {
        // renderHome not ready yet — bottom init covers it.
    }
});

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

// ---- Check settings (interval + notify mode + shorts filter + quiet hours) ----
const checkIntervalSelect = document.getElementById('checkInterval');
const notifyModeSelect = document.getElementById('notifyMode');
const skipShortsToggle = document.getElementById('skipShorts');
const quietEnableToggle = document.getElementById('quietEnable');
const quietStartSelect = document.getElementById('quietStart');
const quietEndSelect = document.getElementById('quietEnd');
const liveModeSelect = document.getElementById('liveMode');
const liveIntervalSelect = document.getElementById('liveInterval');
const importantBypassToggle = document.getElementById('importantBypass');

function fillHourOptions(select) {
    for (let h = 0; h < 24; h++) {
        const opt = document.createElement('option');
        opt.value = String(h);
        opt.textContent = `${String(h).padStart(2, '0')}:00`;
        select.appendChild(opt);
    }
}

if (quietStartSelect && !quietStartSelect.options.length) fillHourOptions(quietStartSelect);
if (quietEndSelect && !quietEndSelect.options.length) fillHourOptions(quietEndSelect);

async function loadSettings() {
    const { settings = {} } = await chrome.storage.local.get(['settings']);
    const merged = { ...DEFAULT_SETTINGS, ...settings };
    if (checkIntervalSelect) checkIntervalSelect.value = String(merged.checkIntervalMin);
    if (notifyModeSelect) notifyModeSelect.value = merged.notifyMode;
    if (skipShortsToggle) skipShortsToggle.checked = merged.skipShorts === true;
    const q = (merged.quiet && typeof merged.quiet === 'object') ? merged.quiet : {};
    if (quietEnableToggle) quietEnableToggle.checked = q.enabled === true;
    if (quietStartSelect) quietStartSelect.value = String(Number.isInteger(q.start) ? q.start : 23);
    if (quietEndSelect) quietEndSelect.value = String(Number.isInteger(q.end) ? q.end : 7);
    if (liveModeSelect) liveModeSelect.value = ['off', 'auto', 'manual'].includes(merged.liveMode) ? merged.liveMode : 'auto';
    if (liveIntervalSelect) liveIntervalSelect.value = String([15, 30, 60, 120].includes(merged.liveIntervalMin) ? merged.liveIntervalMin : 30);
    if (importantBypassToggle) importantBypassToggle.checked = merged.importantBypassQuiet !== false;
    updateLiveIntervalState();
    await renderRules();
}

function updateLiveIntervalState() {
    const row = document.getElementById('liveIntervalRow');
    const mode = liveModeSelect ? liveModeSelect.value : 'auto';
    if (row) row.classList.toggle('is-disabled', mode === 'off');
    if (liveIntervalSelect) liveIntervalSelect.disabled = mode === 'off';
}

async function saveSettings() {
    const settings = {
        checkIntervalMin: Number(checkIntervalSelect ? checkIntervalSelect.value : 15) || 15,
        notifyMode: notifyModeSelect ? notifyModeSelect.value : 'all',
        skipShorts: skipShortsToggle ? skipShortsToggle.checked : false,
        quiet: {
            enabled: quietEnableToggle ? quietEnableToggle.checked : false,
            start: quietStartSelect ? Number(quietStartSelect.value) : 23,
            end: quietEndSelect ? Number(quietEndSelect.value) : 7,
        },
        liveMode: liveModeSelect ? liveModeSelect.value : 'auto',
        liveIntervalMin: liveIntervalSelect ? Number(liveIntervalSelect.value) || 30 : 30,
        importantBypassQuiet: importantBypassToggle ? importantBypassToggle.checked : true,
    };
    await chrome.storage.local.set({ settings });
    // Background rebuilds the alarm via storage.onChanged.
}

if (checkIntervalSelect) checkIntervalSelect.addEventListener('change', saveSettings);
if (notifyModeSelect) notifyModeSelect.addEventListener('change', saveSettings);
if (skipShortsToggle) skipShortsToggle.addEventListener('change', saveSettings);
if (quietEnableToggle) quietEnableToggle.addEventListener('change', saveSettings);
if (quietStartSelect) quietStartSelect.addEventListener('change', saveSettings);
if (quietEndSelect) quietEndSelect.addEventListener('change', saveSettings);
if (liveModeSelect) {
    liveModeSelect.addEventListener('change', saveSettings);
    liveModeSelect.addEventListener('change', updateLiveIntervalState);
}
if (liveIntervalSelect) liveIntervalSelect.addEventListener('change', saveSettings);
if (importantBypassToggle) importantBypassToggle.addEventListener('change', saveSettings);

function ruleActionLabel(action) {
    if (action === 'block') return t('settings.ruleBlock', 'Block');
    if (action === 'important') return t('settings.ruleImportant', 'Important');
    return t('settings.ruleNotify', 'Notify');
}

function ruleFieldLabel(field) {
    if (field === 'channel') return t('settings.ruleFieldChannel', 'Channel');
    if (field === 'both') return t('settings.ruleFieldBoth', 'Both');
    return t('settings.ruleFieldTitle', 'Title');
}

function ruleActionPill(action) {
    const act = action === 'block' ? 'block' : action === 'important' ? 'important' : 'notify';
    const pill = document.createElement('i');
    pill.className = `m-act m-act-${act}`;
    pill.textContent = ruleActionLabel(act);
    return pill;
}

function optionSelect(values, labelFn, current) {
    const sel = document.createElement('select');
    for (const v of values) {
        const opt = document.createElement('option');
        opt.value = v;
        opt.textContent = labelFn(v);
        sel.appendChild(opt);
    }
    sel.value = current;
    return sel;
}

// Shared view/edit rule row for the global list and the channel modal.
// onSave(updatedRule) persists; rerender() rebuilds the owning list.
function buildRuleRow(r, { index, total, onSave, onDelete, onMove, onToggle, rerender }) {
    const row = document.createElement('div');
    row.className = 'flex rule-row m-rule' + (r.enabled === false ? ' is-disabled' : '');
    const text = document.createElement('span');
    text.className = 'grow rule-pattern';
    text.textContent = r.pattern;
    text.title = r.pattern;
    const meta = document.createElement('span');
    meta.className = 'muted small m-rule-meta';
    meta.appendChild(ruleActionPill(r.action));
    meta.appendChild(document.createTextNode(` · ${ruleFieldLabel(r.field)}`));
    const toggle = document.createElement('button');
    toggle.className = 'icon-btn small' + (r.enabled === false ? ' dimmed' : '');
    toggle.title = t('home.ruleToggle', 'Enable/disable rule');
    toggle.textContent = r.enabled === false ? '○' : '✓';
    toggle.addEventListener('click', () => onToggle(r.id));
    const up = document.createElement('button');
    up.className = 'icon-btn small';
    up.title = t('home.ruleUp', 'Move up');
    up.textContent = '▲';
    up.disabled = index === 0;
    up.addEventListener('click', () => onMove(r.id, -1));
    const down = document.createElement('button');
    down.className = 'icon-btn small';
    down.title = t('home.ruleDown', 'Move down');
    down.textContent = '▼';
    down.disabled = index >= total - 1;
    down.addEventListener('click', () => onMove(r.id, 1));
    const edit = document.createElement('button');
    edit.className = 'icon-btn small m-edit';
    edit.title = t('home.editRule', 'Edit rule');
    edit.textContent = '✎';
    edit.addEventListener('click', () => enterRuleEdit(row, r, { onSave, rerender }));
    const del = document.createElement('button');
    del.className = 'icon-btn small';
    del.title = t('settings.ruleDelete', 'Delete rule');
    del.textContent = '×';
    del.addEventListener('click', onDelete);
    row.appendChild(text);
    row.appendChild(meta);
    row.appendChild(toggle);
    row.appendChild(up);
    row.appendChild(down);
    row.appendChild(edit);
    row.appendChild(del);
    return row;
}

function enterRuleEdit(row, r, { onSave, rerender }) {
    row.classList.add('is-editing');
    row.textContent = '';
    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'm-edit-input';
    input.value = r.pattern;
    const bar = document.createElement('div');
    bar.className = 'm-edit-bar';
    const fieldSel = optionSelect(['title', 'channel', 'both'], ruleFieldLabel, r.field);
    const actionSel = optionSelect(['block', 'notify', 'important'], ruleActionLabel, r.action);
    const save = document.createElement('button');
    save.className = 'btn secondary m-save';
    save.textContent = t('home.save', 'Save');
    save.addEventListener('click', async () => {
        const pattern = input.value.trim();
        try {
            if (!pattern) throw new Error('empty');
            new RegExp(pattern, 'i');
        } catch {
            input.setAttribute('aria-invalid', 'true');
            input.focus();
            return;
        }
        await onSave({ ...r, pattern, field: fieldSel.value, action: actionSel.value });
        await rerender();
    });
    const cancel = document.createElement('button');
    cancel.className = 'icon-btn small m-cancel';
    cancel.title = t('home.close', 'Close');
    cancel.textContent = '×';
    cancel.addEventListener('click', () => rerender());
    bar.appendChild(fieldSel);
    bar.appendChild(actionSel);
    bar.appendChild(save);
    bar.appendChild(cancel);
    row.appendChild(input);
    row.appendChild(bar);
    input.focus();
}

async function renderRules() {
    const list = document.getElementById('ruleList');
    if (!list) return;
    const { settings = {} } = await chrome.storage.local.get(['settings']);
    const rules = Array.isArray(settings.rules) ? settings.rules : [];
    list.textContent = '';
    rules.forEach((r, index) => {
        list.appendChild(buildRuleRow(r, {
            index,
            total: rules.length,
            onSave: async (updated) => {
                const cur = await chrome.storage.local.get(['settings']);
                const all = Array.isArray(cur.settings && cur.settings.rules) ? cur.settings.rules : [];
                await chrome.storage.local.set({ settings: { ...(cur.settings || {}), rules: all.map((x) => (x && x.id === updated.id ? updated : x)) } });
            },
            onDelete: async () => {
                const cur = await chrome.storage.local.get(['settings']);
                const all = Array.isArray(cur.settings && cur.settings.rules) ? cur.settings.rules : [];
                await chrome.storage.local.set({ settings: { ...(cur.settings || {}), rules: all.filter((x) => x && x.id !== r.id) } });
                await renderRules();
            },
            onMove: async (id, dir) => {
                const cur = await chrome.storage.local.get(['settings']);
                const all = Array.isArray(cur.settings && cur.settings.rules) ? [...cur.settings.rules] : [];
                const from = all.findIndex((x) => x && x.id === id);
                const to = from + dir;
                if (from < 0 || to < 0 || to >= all.length) return;
                [all[from], all[to]] = [all[to], all[from]];
                await chrome.storage.local.set({ settings: { ...(cur.settings || {}), rules: all } });
                await renderRules();
            },
            onToggle: async (id) => {
                const cur = await chrome.storage.local.get(['settings']);
                const all = Array.isArray(cur.settings && cur.settings.rules) ? cur.settings.rules : [];
                await chrome.storage.local.set({ settings: { ...(cur.settings || {}), rules: all.map((x) => (x && x.id === id ? { ...x, enabled: x.enabled === false } : x)) } });
                await renderRules();
            },
            rerender: renderRules,
        }));
    });
    const badge = document.getElementById('ruleCount');
    if (badge) {
        badge.textContent = String(rules.length);
        badge.classList.toggle('has-rules', rules.length > 0);
    }
}

document.getElementById('ruleAddBtn').addEventListener('click', async () => {
    const input = document.getElementById('ruleInput');
    const pattern = input ? input.value.trim() : '';
    if (!pattern) return;
    try {
        new RegExp(pattern, 'i');
    } catch {
        showBackupStatus('settings.ruleError', 'Invalid pattern.', true);
        return;
    }
    const cur = await chrome.storage.local.get(['settings']);
    const settings = cur.settings || {};
    const rules = Array.isArray(settings.rules) ? [...settings.rules] : [];
    const fieldSel = document.getElementById('ruleField');
    const actionSel = document.getElementById('ruleAction');
    rules.push({
        id: 'r' + Date.now().toString(36),
        pattern,
        field: fieldSel ? fieldSel.value : 'title',
        action: actionSel ? actionSel.value : 'notify',
        enabled: true,
    });
    await chrome.storage.local.set({ settings: { ...settings, rules } });
    if (input) input.value = '';
    await renderRules();
});

// Self-test: run all rules (channel-first, then global) against stored video
// titles so regexes can be verified with real data before relying on them.
document.getElementById('ruleTestBtn').addEventListener('click', async () => {
    const { channels = [], settings = {} } = await chrome.storage.local.get(['channels', 'settings']);
    const globalRules = Array.isArray(settings.rules) ? settings.rules : [];
    const hits = new Map();
    let videos = 0;
    for (const ch of normalizeChannels(channels)) {
        for (const v of (Array.isArray(ch.recent) ? ch.recent : [])) {
            videos += 1;
            const found = matchRuleDetail(ch.rules, globalRules, v.title || '', ch.name || '');
            if (found.rule) {
                const key = `${found.rule.pattern} → ${found.action}`;
                hits.set(key, (hits.get(key) || 0) + 1);
            }
        }
    }
    const el = document.getElementById('backupStatus');
    if (!hits.size) {
        el.textContent = `${t('settings.ruleTestNone', 'No matches.')} (${videos} video)`;
    } else {
        el.textContent = [...hits.entries()].map(([k, n]) => `${k} (${n})`).join(' · ');
    }
    el.classList.remove('error-line');
    el.hidden = false;
});

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

document.getElementById('restoreBtn').addEventListener('click', async () => {
    const { autoBackups = [] } = await chrome.storage.local.get(['autoBackups']);
    if (!autoBackups.length) {
        showBackupStatus('settings.restoreEmpty', 'No auto backup yet.', true);
        return;
    }
    const snap = autoBackups[autoBackups.length - 1];
    const patch = {};
    if (Array.isArray(snap.channels)) patch.channels = snap.channels;
    if (snap.settings && typeof snap.settings === 'object') patch.settings = snap.settings;
    if (typeof snap.theme === 'string') patch.theme = snap.theme;
    if (snap.ui && typeof snap.ui === 'object') patch.ui = snap.ui;
    await chrome.storage.local.set(patch);
    await loadSettings();
    document.body.classList.toggle('dark', patch.theme === 'dark');
    const dmToggle = document.getElementById('darkMode');
    if (dmToggle) dmToggle.checked = patch.theme === 'dark';
    await syncBadge();
    await renderHome();
    showBackupStatus('settings.restoreDone', 'Auto backup restored.');
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
        const pool = scopePool('default', feed.videos, settings.skipShorts === true);
        const newest = feed.videos[0];
        const shown = pool[0] || newest;
        let avatar = '';
        try {
            avatar = await fetchChannelAvatar(channelId);
        } catch {
            avatar = '';
        }
        const nowIso = new Date().toISOString();
        channels.push({
            id: channelId,
            name: feed.channelTitle || channelId,
            avatar,
            addedAt: nowIso,
            lastVideoId: newest ? newest.videoId : '',
            lastVideoTitle: shown ? shown.title : '',
            lastPublished: shown ? shown.published : '',
            lastVideoUrl: shown ? shown.link : '',
            lastThumb: shown && shown.thumb ? shown.thumb : '',
            recent: feed.videos.slice(0, 15).map((v) => ({
                videoId: v.videoId,
                title: v.title,
                published: v.published,
                link: v.link,
                thumb: v.thumb || '',
                important: classifyForChannel([], Array.isArray(settings.rules) ? settings.rules : [], v.title, feed.channelTitle || channelId) === 'important',
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
    // Per-video read state: only the opened video is marked, the rest of the
    // channel stays unread.
    const channels = await getChannels();
    const next = channels.map((c) => {
        if (c.id !== channelId) return c;
        const readIds = Array.isArray(c.readIds) ? [...c.readIds] : [];
        let unread = c.unread || 0;
        if (videoId && !readIds.includes(videoId)) {
            readIds.unshift(videoId);
            unread = Math.max(0, unread - 1);
        }
        return { ...c, readIds: readIds.slice(0, 100), unread };
    });
    await chrome.storage.local.set({ channels: next });
    await syncBadge();
    await renderHome();
}

// A video counts as new when never opened and newer than the channel's
// read watermark (seeded at first check so history doesn't all light up).
function isNewVideo(ch, v) {
    const readIds = Array.isArray(ch.readIds) ? ch.readIds : [];
    if (!v || !v.videoId || readIds.includes(v.videoId)) return false;
    if (!v.published) return true;
    if (!ch.lastReadAt) return true;
    return v.published > ch.lastReadAt;
}

// Middle-click autoscroll starts on mousedown — auxclick is too late to stop
// it, so every middle-clickable element gets this first.
function noAutoscroll(el) {
    el.addEventListener('mousedown', (e) => {
        if (e.button === 1) e.preventDefault();
    });
}

let openMenuEl = null;

function closeCardMenu() {
    if (openMenuEl) {
        openMenuEl.remove();
        openMenuEl = null;
    }
}

document.addEventListener('click', closeCardMenu);
document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
        closeCardMenu();
        closeChannelModal();
    }
});

function toggleCardMenu(card, channelId) {
    const wasOpen = !!openMenuEl && openMenuEl.dataset.ch === channelId;
    closeCardMenu();
    if (wasOpen) return;
    const menu = document.createElement('div');
    menu.className = 'ctx-menu';
    menu.dataset.ch = channelId;
    const cust = document.createElement('button');
    cust.className = 'ctx-item';
    cust.textContent = t('home.customize', 'Customize');
    cust.addEventListener('click', (e) => {
        e.stopPropagation();
        closeCardMenu();
        openChannelModal(channelId);
    });
    const del = document.createElement('button');
    del.className = 'ctx-item danger';
    del.textContent = t('home.remove', 'Remove channel');
    del.addEventListener('click', (e) => {
        e.stopPropagation();
        closeCardMenu();
        removeChannel(channelId);
    });
    menu.appendChild(cust);
    menu.appendChild(del);
    card.appendChild(menu);
    openMenuEl = menu;
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

const GEAR_SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="4" y1="21" x2="4" y2="14"></line><line x1="4" y1="10" x2="4" y2="3"></line><line x1="12" y1="21" x2="12" y2="12"></line><line x1="12" y1="8" x2="12" y2="3"></line><line x1="20" y1="21" x2="20" y2="16"></line><line x1="20" y1="12" x2="20" y2="3"></line><line x1="1" y1="14" x2="7" y2="14"></line><line x1="9" y1="8" x2="15" y2="8"></line><line x1="17" y1="16" x2="23" y2="16"></line></svg>';
const CHEV_SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 18 15 12 9 6"></polyline></svg>';

// Expanded/collapsed state lives in memory (default: collapsed).
const expandedChannels = new Set();
const expandedVideos = new Set();

function copyText(text, btn, doneLabel) {
    const done = () => {
        const old = btn.textContent;
        btn.textContent = doneLabel;
        setTimeout(() => { btn.textContent = old; }, 1200);
    };
    if (typeof navigator !== 'undefined' && navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).then(done, done);
    } else {
        done();
    }
}

function detailRow(label, valueText, opts = {}) {
    const row = document.createElement('div');
    row.className = 'kv';
    const k = document.createElement('span');
    k.className = 'muted';
    k.textContent = label;
    row.appendChild(k);
    const v = opts.button ? document.createElement('button') : document.createElement('span');
    v.className = opts.button ? 'kv-val linklike' : 'kv-val';
    v.textContent = valueText;
    if (opts.title) v.title = opts.title;
    if (opts.onClick) v.addEventListener('click', opts.onClick);
    row.appendChild(v);
    return row;
}

function selectRow(id, labelText, options, current, onPick) {
    const wrap = document.createElement('div');
    wrap.className = 'flex setting-row';
    const lab = document.createElement('label');
    lab.htmlFor = id;
    lab.textContent = labelText;
    const selWrap = document.createElement('div');
    selWrap.className = 'select-wrapper';
    const sel = document.createElement('select');
    sel.id = id;
    for (const [value, label] of options) {
        const opt = document.createElement('option');
        opt.value = value;
        opt.textContent = label;
        sel.appendChild(opt);
    }
    sel.value = current;
    sel.addEventListener('change', () => onPick(sel.value));
    selWrap.appendChild(sel);
    wrap.appendChild(lab);
    wrap.appendChild(selWrap);
    return wrap;
}

function closeChannelModal() {
    document.getElementById('modalOverlay').hidden = true;
}

async function openChannelModal(channelId) {
    const channels = await getChannels();
    const ch = channels.find((c) => c.id === channelId);
    if (!ch) return;
    document.getElementById('modalTitle').textContent = ch.name || ch.id;
    document.getElementById('modalClose').title = t('home.close', 'Close');
    const body = document.getElementById('modalBody');
    body.textContent = '';

    const idRow = document.createElement('button');
    idRow.className = 'm-id';
    idRow.title = t('home.copyId', 'Copy channel ID');
    idRow.textContent = ch.id;
    idRow.addEventListener('click', (e) => copyText(ch.id, e.currentTarget, t('home.copied', 'Copied')));
    body.appendChild(idRow);

    const chSec = document.createElement('div');
    chSec.className = 'm-sec';
    const chSecLabel = document.createElement('div');
    chSecLabel.className = 'section-label';
    chSecLabel.textContent = t('home.channelSection', 'Channel');
    chSec.appendChild(chSecLabel);
    body.appendChild(chSec);

    const nState = CH_NOTIFY_ORDER.includes(ch.chNotify) ? ch.chNotify : 'default';
    chSec.appendChild(selectRow(
        `chNotify-${ch.id}`,
        t('home.chNotify', 'Channel notifications'),
        CH_NOTIFY_ORDER.map((opt) => [opt, chNotifyLabel(opt)]),
        nState,
        async (v) => {
            const all = await getChannels();
            await chrome.storage.local.set({ channels: all.map((c) => (c.id === ch.id ? { ...c, chNotify: v } : c)) });
            await syncBadge();
            await renderHome();
        }
    ));

    chSec.appendChild(selectRow(
        `chScope-${ch.id}`,
        t('home.contentScope', 'Content'),
        CH_SCOPE_ORDER.map((opt) => [opt, scopeLabel(opt)]),
        scopeOf(ch),
        async (v) => {
            const all = await getChannels();
            await chrome.storage.local.set({
                channels: all.map((c) => {
                    if (c.id !== ch.id) return c;
                    const { chShorts: _legacy, ...rest } = c;
                    return { ...rest, chScope: v };
                }),
            });
            await renderHome();
        }
    ));

    chSec.appendChild(selectRow(
        `chLive-${ch.id}`,
        t('home.liveCheck', 'Live check'),
        CH_LIVE_ORDER.map((opt) => [opt, liveCheckLabel(opt)]),
        CH_LIVE_ORDER.includes(ch.chLive) ? ch.chLive : 'default',
        async (v) => {
            const all = await getChannels();
            await chrome.storage.local.set({ channels: all.map((c) => (c.id === ch.id ? { ...c, chLive: v } : c)) });
            await renderHome();
        }
    ));

    const mRulesLabel = document.createElement('div');
    mRulesLabel.className = 'section-label';
    mRulesLabel.style.marginTop = '12px';
    mRulesLabel.textContent = `${t('settings.rulesTitle', 'Title rules')} (${t('home.channelOnly', 'this channel')})`;
    const mRuleBadge = document.createElement('span');
    mRuleBadge.className = 'group-badge';
    mRuleBadge.textContent = '0';
    mRulesLabel.appendChild(document.createTextNode(' '));
    mRulesLabel.appendChild(mRuleBadge);
    body.appendChild(mRulesLabel);
    const mRuleList = document.createElement('div');
    mRuleList.className = 'rules-scroll m-rules-scroll';
    body.appendChild(mRuleList);
    const mEmpty = document.createElement('div');
    mEmpty.className = 'm-empty';
    mEmpty.textContent = t('settings.ruleEmpty', 'No rules — videos follow global rules.');
    mEmpty.hidden = true;
    body.appendChild(mEmpty);

    async function persistChannelRules(next) {
        const all = await getChannels();
        await chrome.storage.local.set({ channels: all.map((c) => (c.id === ch.id ? { ...c, rules: next } : c)) });
        await renderHome();
    }

    async function renderModalRules() {
        const all = await getChannels();
        const cur = all.find((c) => c.id === ch.id);
        const crules = cur && Array.isArray(cur.rules) ? cur.rules : [];
        mRuleList.textContent = '';
        crules.forEach((r, index) => {
            mRuleList.appendChild(buildRuleRow(r, {
                index,
                total: crules.length,
                onSave: async (updated) => {
                    const latest = await getChannels();
                    const found = latest.find((c) => c.id === ch.id);
                    const rest = found && Array.isArray(found.rules)
                        ? found.rules.map((x) => (x && x.id === updated.id ? updated : x))
                        : [];
                    await persistChannelRules(rest);
                },
                onDelete: async () => {
                    const latest = await getChannels();
                    const found = latest.find((c) => c.id === ch.id);
                    const rest = found && Array.isArray(found.rules) ? found.rules.filter((x) => x && x.id !== r.id) : [];
                    await persistChannelRules(rest);
                    await renderModalRules();
                },
                onMove: async (id, dir) => {
                    const latest = await getChannels();
                    const found = latest.find((c) => c.id === ch.id);
                    const rest = found && Array.isArray(found.rules) ? [...found.rules] : [];
                    const from = rest.findIndex((x) => x && x.id === id);
                    const to = from + dir;
                    if (from < 0 || to < 0 || to >= rest.length) return;
                    [rest[from], rest[to]] = [rest[to], rest[from]];
                    await persistChannelRules(rest);
                    await renderModalRules();
                },
                onToggle: async (id) => {
                    const latest = await getChannels();
                    const found = latest.find((c) => c.id === ch.id);
                    const rest = found && Array.isArray(found.rules)
                        ? found.rules.map((x) => (x && x.id === id ? { ...x, enabled: x.enabled === false } : x))
                        : [];
                    await persistChannelRules(rest);
                    await renderModalRules();
                },
                rerender: renderModalRules,
            }));
        });
        mRuleBadge.textContent = String(crules.length);
        mRuleBadge.classList.toggle('has-rules', crules.length > 0);
        mEmpty.hidden = crules.length > 0;
    }

    const mRuleAddRow = document.createElement('div');
    mRuleAddRow.className = 'm-add';
    const mRuleInput = document.createElement('input');
    mRuleInput.type = 'text';
    mRuleInput.placeholder = t('settings.rulePlaceholder', 'Pattern, e.g. shorts|trailer');
    const mFieldWrap = document.createElement('div');
    mFieldWrap.className = 'select-wrapper';
    const mFieldSel = optionSelect(['title', 'channel', 'both'], ruleFieldLabel, 'title');
    mFieldWrap.appendChild(mFieldSel);
    const mActionWrap = document.createElement('div');
    mActionWrap.className = 'select-wrapper';
    const mActionSel = optionSelect(['block', 'notify', 'important'], ruleActionLabel, 'notify');
    mActionWrap.appendChild(mActionSel);
    const mAddBtn = document.createElement('button');
    mAddBtn.className = 'btn secondary';
    mAddBtn.textContent = t('settings.ruleAdd', 'Add');
    mAddBtn.addEventListener('click', async () => {
        const pattern = mRuleInput.value.trim();
        if (!pattern) return;
        try {
            new RegExp(pattern, 'i');
        } catch {
            mRuleInput.title = t('settings.ruleError', 'Invalid pattern.');
            mRuleInput.focus();
            return;
        }
        const all = await getChannels();
        const cur = all.find((c) => c.id === ch.id);
        const crules = cur && Array.isArray(cur.rules) ? [...cur.rules] : [];
        crules.push({ id: 'r' + Date.now().toString(36), pattern, field: mFieldSel.value, action: mActionSel.value, enabled: true });
        await persistChannelRules(crules);
        mRuleInput.value = '';
        await renderModalRules();
    });
    mRuleAddRow.appendChild(mRuleInput);
    mRuleAddRow.appendChild(mFieldWrap);
    mRuleAddRow.appendChild(mActionWrap);
    mRuleAddRow.appendChild(mAddBtn);
    body.appendChild(mRuleAddRow);
    const mHint = document.createElement('p');
    mHint.className = 'hint';
    mHint.textContent = `${t('settings.ruleOrderHint', 'First match wins.')} ${t('settings.ruleMatchHint', 'Patterns match anywhere inside the text.')}`;
    body.appendChild(mHint);

    await renderModalRules();

    document.getElementById('modalOverlay').hidden = false;
}

document.getElementById('modalClose').addEventListener('click', closeChannelModal);
document.getElementById('modalOverlay').addEventListener('click', (e) => {
    if (e.target.id === 'modalOverlay') closeChannelModal();
});

const CH_LIVE_ORDER = ['default', 'on', 'off'];

function liveCheckLabel(state) {
    if (state === 'on') return t('settings.chLiveOn', 'Check live');
    if (state === 'off') return t('settings.chLiveOff', 'Skip');
    return t('settings.chLiveDef', 'Follow global');
}

function scopeLabel(state) {
    if (state === 'all') return t('settings.scopeAll', 'Everything');
    if (state === 'videos') return t('settings.scopeVideos', 'Only videos');
    if (state === 'shorts') return t('settings.scopeShorts', 'Only Shorts');
    if (state === 'live') return t('settings.scopeLive', 'Only live');
    if (state === 'videos-shorts') return t('settings.scopeVideosShorts', 'Videos + Shorts');
    if (state === 'videos-live') return t('settings.scopeVideosLive', 'Videos + live');
    if (state === 'shorts-live') return t('settings.scopeShortsLive', 'Shorts + live');
    return t('settings.scopeDefault', 'Follow global');
}

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
    await chrome.storage.local.set({
        channels: channels.map((c) => ({
            ...c,
            unread: 0,
            lastReadAt: now,
            readIds: [...new Set([
                ...((Array.isArray(c.recent) ? c.recent : []).map((v) => v.videoId)),
                ...(Array.isArray(c.readIds) ? c.readIds : []),
            ])].slice(0, 100),
        })),
    });
    await syncBadge();
    await renderHome();
}

document.getElementById('markReadBtn').addEventListener('click', markAllRead);

// Long titles are clamped to 100 chars; the full title stays in the tooltip.
function fitTitle(s, limit = 100) {
    const str = s || '';
    return str.length > limit ? str.slice(0, limit).trimEnd() + '…' : str;
}

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
document.getElementById('filterImportantBtn').addEventListener('click', (e) => {
    importantOnly = !importantOnly;
    e.currentTarget.classList.toggle('active', importantOnly);
    renderHome();
});
document.getElementById('liveLeft').addEventListener('click', () => {
    document.getElementById('liveStrip').scrollBy({ left: -220 });
});
document.getElementById('liveRight').addEventListener('click', () => {
    document.getElementById('liveStrip').scrollBy({ left: 220 });
});

async function renderLiveStrip() {
    const wrap = document.getElementById('liveStripWrap');
    const strip = document.getElementById('liveStrip');
    const channels = await getChannels();
    const live = channels.filter((c) => c.isLive && c.liveVideoId);
    strip.textContent = '';
    wrap.hidden = live.length === 0;
    if (!live.length) return;
    for (const ch of live) {
        const url = `https://www.youtube.com/watch?v=${ch.liveVideoId}`;
        const btn = document.createElement('button');
        btn.className = 'live-item';
        btn.title = `${ch.name || ch.id} — ${t('home.live', 'LIVE')}`;
        if (ch.avatar) {
            const im = document.createElement('img');
            im.src = ch.avatar;
            im.alt = '';
            im.loading = 'lazy';
            btn.appendChild(im);
        } else {
            const ph = document.createElement('span');
            ph.className = 'live-item-ph';
            ph.textContent = (ch.name || ch.id || '?').trim().charAt(0).toUpperCase();
            btn.appendChild(ph);
        }
        btn.addEventListener('click', () => openVideo(ch.id, ch.liveVideoId, new Date().toISOString(), url));
        btn.addEventListener('auxclick', (e) => {
            if (e.button === 1) {
                e.preventDefault();
                openVideo(ch.id, ch.liveVideoId, new Date().toISOString(), url, false);
            }
        });
        noAutoscroll(btn);
        strip.appendChild(btn);
    }
}

async function renderHome() {
    closeCardMenu();
    const view = await getView();
    const { settings = {} } = await chrome.storage.local.get(['settings']);
    const merged = { ...DEFAULT_SETTINGS, ...settings };
    liveModeCache = ['off', 'auto', 'manual'].includes(merged.liveMode) ? merged.liveMode : 'auto';
    document.getElementById('viewVideosBtn').classList.toggle('active', view === 'videos');
    document.getElementById('viewChannelsBtn').classList.toggle('active', view === 'channels');
    document.getElementById('videoList').style.display = view === 'videos' ? 'flex' : 'none';
    document.getElementById('channelList').style.display = view === 'channels' ? 'flex' : 'none';
    if (view === 'videos') {
        await renderVideoList();
    } else {
        await renderChannelList();
    }
    await renderLiveStrip();
    document.getElementById('channelSearchWrap').style.display = view === 'channels' ? 'block' : 'none';
}

async function renderVideoList() {
    const list = document.getElementById('videoList');
    const empty = document.getElementById('homeEmpty');
    const channels = await getChannels();
    const { settings = {} } = await chrome.storage.local.get(['settings']);
    const items = [];
    for (const ch of channels) {
        const recent = Array.isArray(ch.recent) ? ch.recent : [];
        const pool = scopePool(scopeOf(ch), recent, settings.skipShorts === true);
        for (const v of pool) {
            items.push({
                ...v,
                channelId: ch.id,
                channelName: ch.name || ch.id,
                lastReadAt: ch.lastReadAt || '',
                readIds: Array.isArray(ch.readIds) ? ch.readIds : [],
                unread: ch.unread || 0,
                liveHere: ch.isLive && ch.liveVideoId === v.videoId,
            });
        }
    }
    items.sort((a, b) => (b.published || '').localeCompare(a.published || ''));
    const feed = importantOnly ? items.filter((i) => i.important) : items;
    const shown = feed.slice(0, feedLimit);
    list.textContent = '';
    empty.style.display = shown.length ? 'none' : 'block';
    const impCount = items.filter((i) => i.important && isNewVideo(i, i)).length;
    if (impCount > 0) {
        const counter = document.createElement('div');
        counter.className = 'muted';
        counter.textContent = `${impCount} ${t('home.important', 'Important')}`;
        list.appendChild(counter);
    }
    for (const item of shown) {
        const card = document.createElement('div');
        card.className = 'channel-card' + (isNewVideo(item, item) ? ' is-new' : '') + (item.important ? ' is-important' : '');
        if (item.important) {
            const rail = document.createElement('span');
            rail.className = 'important-rail';
            rail.textContent = t('home.important', 'Important');
            card.appendChild(rail);
        }
        card.title = t('home.openVideo', 'Open video');
        card.addEventListener('click', () => openVideo(item.channelId, item.videoId, item.published, item.link));
        card.addEventListener('auxclick', (e) => {
            if (e.button === 1) {
                e.preventDefault();
                openVideo(item.channelId, item.videoId, item.published, item.link, false);
            }
        });
        noAutoscroll(card);

        const more = document.createElement('button');
        more.className = 'icon-btn small card-menu-btn';
        more.title = t('home.more', 'More');
        more.textContent = '⋮';
        more.addEventListener('click', (e) => {
            e.stopPropagation();
            toggleCardMenu(card, item.channelId);
        });
        card.appendChild(more);

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
        title.appendChild(document.createTextNode(fitTitle(item.title || item.videoId)));
        title.title = item.title || item.videoId;
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
        noAutoscroll(chan);
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
        if (liveModeCache !== 'off' && item.liveHere) {
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

    if (feed.length > shown.length) {
        const moreBtn = document.createElement('button');
        moreBtn.className = 'btn secondary load-more';
        moreBtn.textContent = `${t('home.loadMore', 'Show more')} (${feed.length - shown.length})`;
        moreBtn.addEventListener('click', () => {
            feedLimit += 25;
            renderHome();
        });
        list.appendChild(moreBtn);
    }
}

document.getElementById('channelSearch').addEventListener('input', () => {
    renderHome();
});

async function renderChannelList() {
    const list = document.getElementById('channelList');
    const empty = document.getElementById('homeEmpty');
    const channels = await getChannels();
    const query = (document.getElementById('channelSearch').value || '').trim().toLowerCase();
    const visible = query
        ? channels.filter((c) => (c.name || '').toLowerCase().includes(query) || (c.id || '').toLowerCase().includes(query))
        : channels;
    list.textContent = '';
    empty.style.display = visible.length ? 'none' : 'block';
    for (const ch of visible) {
        const card = document.createElement('div');
        card.className = 'channel-card ch-card';
        const isOpen = expandedChannels.has(ch.id);

        // --- Header: avatar + name + customize + expand arrow ---
        const main = document.createElement('div');
        main.className = 'ch-main';
        main.title = isOpen ? t('home.collapse', 'Collapse') : t('home.expand', 'Expand');
        main.addEventListener('click', () => {
            if (expandedChannels.has(ch.id)) expandedChannels.delete(ch.id);
            else expandedChannels.add(ch.id);
            renderHome();
        });

        if (ch.avatar) {
            const av = document.createElement('img');
            av.className = 'avatar';
            av.src = ch.avatar;
            av.alt = '';
            av.loading = 'lazy';
            main.appendChild(av);
        } else {
            const ph = document.createElement('div');
            ph.className = 'avatar avatar-ph';
            ph.textContent = (ch.name || ch.id || '?').trim().charAt(0).toUpperCase();
            main.appendChild(ph);
        }

        const headText = document.createElement('div');
        headText.className = 'grow ch-head';
        const name = document.createElement('strong');
        name.className = 'channel-name';
        name.textContent = ch.name || ch.id;
        if (ch.unread > 0) {
            const dot = document.createElement('span');
            dot.className = 'unread-dot';
            dot.textContent = String(ch.unread);
            dot.title = t('home.unread', 'New videos');
            name.appendChild(document.createTextNode(' '));
            name.appendChild(dot);
        }
        headText.appendChild(name);
        if (liveModeCache !== 'off' && ch.isLive && ch.liveVideoId) {
            const lm = document.createElement('span');
            lm.className = 'live-mini';
            lm.textContent = t('home.live', 'LIVE');
            headText.appendChild(document.createTextNode(' '));
            headText.appendChild(lm);
        }
        main.appendChild(headText);

        const gear = document.createElement('button');
        gear.className = 'icon-btn small';
        gear.title = t('home.customize', 'Customize');
        gear.innerHTML = GEAR_SVG;
        gear.addEventListener('click', (e) => {
            e.stopPropagation();
            openChannelModal(ch.id);
        });
        main.appendChild(gear);

        const arrow = document.createElement('button');
        arrow.className = 'icon-btn small ch-arrow' + (isOpen ? ' open' : '');
        arrow.title = main.title;
        arrow.innerHTML = CHEV_SVG;
        arrow.addEventListener('click', (e) => {
            e.stopPropagation();
            if (expandedChannels.has(ch.id)) expandedChannels.delete(ch.id);
            else expandedChannels.add(ch.id);
            renderHome();
        });
        main.appendChild(arrow);
        card.appendChild(main);

        if (isOpen) {
            const detail = document.createElement('div');
            detail.className = 'ch-detail';

            detail.appendChild(detailRow(t('home.copyId', 'Copy channel ID'), ch.id, {
                button: true,
                title: ch.id,
                onClick: (e) => copyText(ch.id, e.currentTarget, t('home.copied', 'Copied')),
            }));

            if (ch.addedAt) {
                const addedDate = new Date(ch.addedAt);
                detail.appendChild(detailRow(
                    t('home.added', 'Added'),
                    addedDate.toLocaleDateString(),
                    { title: addedDate.toLocaleString() }
                ));
            }

            if (ch.lastCheck) {
                let checkText = timeAgo(ch.lastCheck);
                if (ch.lastOk === false && ch.lastError) checkText += ` (${ch.lastError})`;
                detail.appendChild(detailRow(t('home.lastCheck', 'Last check'), checkText || '—'));
            }

            const liveRow = document.createElement('div');
            liveRow.className = 'kv';
            const liveK = document.createElement('span');
            liveK.className = 'muted';
            liveK.textContent = t('home.liveCheck', 'Live check');
            const liveV = document.createElement('span');
            liveV.className = 'kv-val';
            if (ch.isLive && ch.liveVideoId) {
                const pill = document.createElement('span');
                pill.className = 'live-mini';
                pill.textContent = t('home.live', 'LIVE');
                liveV.appendChild(pill);
            } else if (ch.liveCheckedAt) {
                liveV.textContent = `${t('home.liveOff', 'Not live')} (${ch.liveVia || '?'})`;
            } else {
                liveV.textContent = t('home.liveUnknown', 'Unknown');
            }
            liveRow.appendChild(liveK);
            liveRow.appendChild(liveV);
            if (ch.liveDebug) liveV.title = ch.liveDebug;
            if (liveModeCache !== 'off') detail.appendChild(liveRow);

            const actions = document.createElement('div');
            actions.className = 'ch-actions';
            const openBtn = document.createElement('button');
            openBtn.className = 'mini-btn';
            openBtn.textContent = t('home.openChannel', 'Open channel');
            openBtn.addEventListener('click', () => openChannel(ch.id));
            const custBtn = document.createElement('button');
            custBtn.className = 'mini-btn';
            custBtn.textContent = t('home.customize', 'Customize');
            custBtn.addEventListener('click', () => openChannelModal(ch.id));
            const delBtn = document.createElement('button');
            delBtn.className = 'mini-btn danger';
            delBtn.textContent = t('home.remove', 'Remove channel');
            delBtn.addEventListener('click', () => removeChannel(ch.id));
            let liveBtn = null;
            if (liveModeCache !== 'off') {
            liveBtn = document.createElement('button');
            liveBtn.className = 'mini-btn';
            liveBtn.textContent = t('home.checkLive', 'Check live');
            liveBtn.addEventListener('click', async (e) => {
                const btn = e.currentTarget;
                btn.disabled = true;
                try {
                    await chrome.runtime.sendMessage({ type: 'zil-check-live', channelId: ch.id });
                } catch {
                    // SW wakes on storage change anyway.
                } finally {
                    btn.disabled = false;
                    await renderHome();
                }
            });
            }
            actions.appendChild(openBtn);
            actions.appendChild(custBtn);
            if (liveModeCache !== 'off') actions.appendChild(liveBtn);
            actions.appendChild(delBtn);
            detail.appendChild(actions);

            const recent = Array.isArray(ch.recent) ? ch.recent : [];
            const vidsOpen = expandedVideos.has(ch.id);
            const vidsToggle = document.createElement('button');
            vidsToggle.className = 'vids-toggle' + (vidsOpen ? ' open' : '');
            const vidsChev = document.createElement('span');
            vidsChev.className = 'vids-chev';
            vidsChev.innerHTML = CHEV_SVG;
            vidsToggle.appendChild(vidsChev);
            vidsToggle.appendChild(document.createTextNode(`${t('home.videos', 'Videos')} (${recent.length})`));
            vidsToggle.addEventListener('click', () => {
                if (expandedVideos.has(ch.id)) expandedVideos.delete(ch.id);
                else expandedVideos.add(ch.id);
                renderHome();
            });
            detail.appendChild(vidsToggle);

            if (vidsOpen) {
                const vids = document.createElement('div');
                vids.className = 'ch-videos';
                for (const v of recent) {
                    const row = document.createElement('div');
                    row.className = 'ch-video-row';
                    row.title = t('home.openVideo', 'Open video');
                    row.addEventListener('click', () => openVideo(ch.id, v.videoId, v.published, v.link));
                    row.addEventListener('auxclick', (e) => {
                        if (e.button === 1) {
                            e.preventDefault();
                            openVideo(ch.id, v.videoId, v.published, v.link, false);
                        }
                    });
                    noAutoscroll(row);
                    if (v.thumb) {
                        const im = document.createElement('img');
                        im.className = 'ch-video-thumb';
                        im.src = v.thumb;
                        im.alt = '';
                        im.loading = 'lazy';
                        row.appendChild(im);
                    }
                    const vt = document.createElement('div');
                    vt.className = 'grow ch-video-title';
                    vt.textContent = fitTitle(v.title || v.videoId);
                    vt.title = v.title || v.videoId;
                    row.appendChild(vt);
                    if (v.published) {
                        const tm = document.createElement('div');
                        tm.className = 'muted small';
                        tm.textContent = timeAgo(v.published);
                        row.appendChild(tm);
                    }
                    vids.appendChild(row);
                }
                detail.appendChild(vids);
            }

            card.appendChild(detail);
        }

        list.appendChild(card);
    }
}

chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && (changes.channels || changes.settings)) {
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
