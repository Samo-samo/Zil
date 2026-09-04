const FALLBACK_LANG = 'en';

export async function lang(selectedLang) {
    let targetLang = FALLBACK_LANG;

    if (selectedLang && selectedLang !== "") {
        targetLang = selectedLang;
        await chrome.storage.local.set({ user_selected_lang: selectedLang });
    } else {
        const result = await chrome.storage.local.get(['user_selected_lang']);
        if (result && result.user_selected_lang) {
            targetLang = result.user_selected_lang;
        } else {
            const userLangLong = typeof navigator !== 'undefined' ? (navigator.language || navigator.userLanguage) : null;
            targetLang = userLangLong ? userLangLong.split('-')[0] : FALLBACK_LANG;
        }
    }

    try {
        let response = await fetch(`./locales/${targetLang}.json`);
        if (!response.ok) {
            response = await fetch(`./locales/${FALLBACK_LANG}.json`);
        }
        const strings = await response.json();
        
        if (typeof document !== 'undefined') {
            translateUI(strings);
        }
        
        return strings;
    } catch (err) {
        console.error("Language installation error:", err);
        return {};
    }
}

export async function getLang() {
    const result = await chrome.storage.local.get(['user_selected_lang']);
    if (result && result.user_selected_lang) {
        return result.user_selected_lang;
    }

    const userLangLong = typeof navigator !== 'undefined' ? (navigator.language || navigator.userLanguage) : null;
    return userLangLong ? userLangLong.split('-')[0] : FALLBACK_LANG;
}

function getValueByPath(obj, path) {
    return path.split('.').reduce((current, key) => {
        return (current && current[key] !== undefined) ? current[key] : null;
    }, obj);
}

function translateUI(strings) {
    if (typeof document === 'undefined') return;

    document.querySelectorAll('[data-i18n]').forEach(element => {
        const path = element.getAttribute('data-i18n');
        const value = getValueByPath(strings, path);
        if (value) {
            element.textContent = value;
        }
    });

    document.querySelectorAll('[id], [class], input, button, select, textarea').forEach(element => {
        Array.from(element.attributes).forEach(attr => {
            if (attr.name.startsWith('data-i18n-')) {
                const path = attr.value;
                const value = getValueByPath(strings, path);
                if (value) {
                    const targetAttribute = attr.name.replace('data-i18n-', '');
                    element[targetAttribute] = value;
                }
            }
        });
    });
}
