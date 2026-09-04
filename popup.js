import { lang } from './modules/localizator.js';

let selectedLang = "";

lang(selectedLang);

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

document.getElementById('lang').addEventListener('change', function(event) {
    const selectedLang = event.target.value;
    lang(selectedLang);
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

document.getElementById("saveChannelBtn").addEventListener("click", async () => {
    const channelInput = document.getElementById("channelInput");
    const newChannelID = channelInput ? channelInput.value.trim() : "";
    if (!newChannelID) {
        return;
    }
    const result = await chrome.storage.local.get(['channels']);
    const channels = result.channels || [];
    channels.push({ id: newChannelID, name: "Yükleniyor...", lastVideoId: "" });
    await chrome.storage.local.set({ channels });
    switchPage('homepage');
})