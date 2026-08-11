const FALLBACK_LANG = 'en';

export async function lang() {
    const userLangLong = navigator.language || navigator.userLanguage;
    const userLang = userLangLong ? userLangLong.split('-')[0] : FALLBACK_LANG;

    try {
        let response = await fetch(`./locales/${userLang}.json`);
        if (!response.ok) {
            response = await fetch(`./locales/${FALLBACK_LANG}.json`);
        }
        const strings = await response.json();
        translateUI(strings);
    } catch (err) {
        console.error("Dil yükleme hatası:", err);
    }
}

function getValueByPath(obj, path) {
    return path.split('.').reduce((current, key) => {
        return (current && current[key] !== undefined) ? current[key] : null;
    }, obj);
}

function translateUI(strings) {
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

export function getLang() {
    const userLangLong = navigator.language || navigator.userLanguage;
    const userLang = userLangLong ? userLangLong.split('-')[0] : FALLBACK_LANG;
    return userLang;
}