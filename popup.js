import { lang, getLang } from './modules/localizator.js';

lang();

const homepage = document.getElementById('homepage');
const settingsPage = document.getElementById('settingsPage');
const addingPage = document.getElementById('addingPage');

document.getElementById('settingsBtn').addEventListener('click', () => {
    homepage.style.display = 'none';
    settingsPage.style.display = 'block';
    
    const selectedLang = getLang();
    document.getElementById('lang').value = selectedLang;
});

document.getElementById('addingPageBtn').addEventListener('click', () => {
    homepage.style.display = 'none';
    addingPage.style.display = 'block';
});

document.getElementById('backBtnSettings').addEventListener('click', () => {
    settingsPage.style.display = 'none';
    homepage.style.display = 'block';
});

document.getElementById('backBtnAdd').addEventListener('click', () => {
    addingPage.style.display = 'none';
    homepage.style.display = 'block';
});