// SPDX-License-Identifier: GPL-3.0-or-later
// Translated UI texts. HTML elements declare their texts via data attributes:
//   data-i18n="key"              -> textContent
//   data-i18n-placeholder="key"  -> placeholder attribute
//   data-i18n-title="key"        -> title attribute
//   data-i18n-aria-label="key"   -> aria-label attribute

const ATTRIBUTES = {
    'data-i18n-placeholder': 'placeholder',
    'data-i18n-title': 'title',
    'data-i18n-aria-label': 'aria-label',
};

export function t(key, substitutions) {
    const text = browser.i18n.getMessage(key, substitutions);
    if (!text) {
        console.warn('[Fediscribe] Missing UI text:', key);
        return key;
    }
    return text;
}

export function applyI18n(root = document) {
    for (const element of root.querySelectorAll('[data-i18n]')) {
        element.textContent = t(element.dataset.i18n);
    }
    for (const [dataAttribute, targetAttribute] of Object.entries(ATTRIBUTES)) {
        for (const element of root.querySelectorAll(`[${dataAttribute}]`)) {
            element.setAttribute(targetAttribute, t(element.getAttribute(dataAttribute)));
        }
    }
}
