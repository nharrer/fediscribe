// SPDX-License-Identifier: GPL-3.0-or-later
// Settings stored in browser.storage.local, merged with defaults on load.

export const PROVIDER_IDS = ['openai', 'anthropic', 'gemini', 'openrouter'];

// Languages offered for the generated alt texts. "auto" means: same as the
// Mastodon interface. Display names come from Intl.DisplayNames.
export const LANGUAGE_CODES = [
    'en', 'de', 'fr', 'es', 'it', 'pt', 'nl', 'da', 'sv', 'nb', 'fi', 'pl', 'cs',
    'hu', 'ro', 'el', 'tr', 'ru', 'uk', 'ja', 'zh', 'ko', 'ar', 'he', 'hi', 'id',
];

export const DEFAULT_TIMEOUT_SECONDS = 90;

export const DEFAULT_SETTINGS = Object.freeze({
    // [{ domain: 'example.social', mediaHosts: ['assets.example.social'] }]
    servers: [],
    provider: 'openai',
    apiKeys: { openai: '', anthropic: '', gemini: '', openrouter: '' },
    models: { openai: '', anthropic: '', gemini: '', openrouter: '' },
    language: 'auto',
    debug: false,
    timeoutSeconds: DEFAULT_TIMEOUT_SECONDS,
});

export function mergeWithDefaults(stored = {}) {
    return {
        ...structuredClone(DEFAULT_SETTINGS),
        ...stored,
        apiKeys: { ...DEFAULT_SETTINGS.apiKeys, ...stored.apiKeys },
        models: { ...DEFAULT_SETTINGS.models, ...stored.models },
        servers: Array.isArray(stored.servers) ? stored.servers : [],
    };
}

export async function loadSettings() {
    const stored = await browser.storage.local.get(Object.keys(DEFAULT_SETTINGS));
    return mergeWithDefaults(stored);
}

export async function saveSettings(partial) {
    await browser.storage.local.set(partial);
}

// Turns user input like "https://Example.Social/@user" into "example.social".
// Returns null if the input is not a plausible host name.
export function normalizeDomain(input) {
    let text = String(input ?? '').trim();
    if (!text) {
        return null;
    }
    if (text.startsWith('@')) {
        // Accept handles like "@user@example.social".
        text = text.split('@').pop();
    }
    if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(text)) {
        text = `https://${text}`;
    }
    let url;
    try {
        url = new URL(text);
    } catch {
        return null;
    }
    const host = url.hostname.toLowerCase().replace(/\.$/, '');
    if (!/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(host) || url.port) {
        return null;
    }
    return host;
}

// Match pattern / permission origin for a host.
export function originPattern(host) {
    return `https://${host}/*`;
}

export function serverHosts(server) {
    return [server.domain, ...(server.mediaHosts ?? [])];
}
