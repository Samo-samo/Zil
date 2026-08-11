const FALLBACK_LANG = 'tr';

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

// Noktalı string yolunu (örn: "popup.title") nesne içinde bulan yardımcı fonksiyon
function getValueByPath(obj, path) {
    return path.split('.').reduce((current, key) => {
        return (current && current[key] !== undefined) ? current[key] : null;
    }, obj);
}

function translateUI(strings) {
    // 1. Normal metin içeren elemanlar (Klasik data-i18n)
    document.querySelectorAll('[data-i18n]').forEach(element => {
        const path = element.getAttribute('data-i18n');
        const value = getValueByPath(strings, path);
        if (value) {
            element.textContent = value;
        }
    });

    // 2. data-i18n- ile başlayan dinamik nitelikler (placeholder, title vb.)
    // İsminin içinde "data-i18n-" geçen tüm elementleri genel olarak seçiyoruz
    document.querySelectorAll('[id], [class], input, button, select, textarea').forEach(element => {
        // Elemanın tüm niteliklerini dönüyoruz
        Array.from(element.attributes).forEach(attr => {
            // Eğer nitelik "data-i18n-" ile başlıyorsa (Örn: data-i18n-placeholder)
            if (attr.name.startsWith('data-i18n-')) {
                const path = attr.value;
                const value = getValueByPath(strings, path);
                
                if (value) {
                    // "data-i18n-placeholder" -> "placeholder" kısmını koparıyoruz
                    const targetAttribute = attr.name.replace('data-i18n-', '');
                    
                    // Elementin doğrudan ilgili özelliğine (placeholder, title vb.) değeri basıyoruz
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