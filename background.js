// SPDX-License-Identifier: GPL-3.0-or-later
// Background event page: message routing, image download, API calls and
// registration of the content script for the configured Mastodon servers.

import { getProvider } from './providers/index.js';
import { FediscribeError } from './shared/errors.js';
import { prepareImage, base64ToBytes } from './shared/image.js';
import { createLogger, setDebug } from './shared/log.js';
import { buildPrompt, cleanResponseText, DEFAULT_MAX_CHARS, resolveLanguage, truncateText } from './shared/prompt.js';
import { loadSettings, originPattern } from './shared/settings.js';

const log = createLogger('background');

const CONTENT_SCRIPT_ID = 'fediscribe-mastodon';
const IMAGE_FETCH_TIMEOUT_MS = 30_000;
const MODELS_TIMEOUT_MS = 30_000;

// ---------------------------------------------------------------------------
// Content script registration

async function grantedOrigins(origins) {
    const granted = [];
    for (const origin of origins) {
        if (await browser.permissions.contains({ origins: [origin] })) {
            granted.push(origin);
        }
    }
    return granted;
}

let syncQueue = Promise.resolve();

// Registers the content script for all configured servers whose permission
// has been granted. Runs serialized, because several events can trigger it.
function syncContentScripts() {
    syncQueue = syncQueue.then(doSyncContentScripts).catch((error) => {
        log.error('Registering the content script failed:', error);
    });
    return syncQueue;
}

async function doSyncContentScripts() {
    const settings = await loadSettings();
    const wanted = settings.servers.map((server) => originPattern(server.domain));
    const matches = (await grantedOrigins(wanted)).sort();

    const existing = await browser.scripting.getRegisteredContentScripts({ ids: [CONTENT_SCRIPT_ID] });
    const current = existing[0]?.matches?.slice().sort() ?? [];
    if (existing.length && JSON.stringify(current) === JSON.stringify(matches)) {
        log.debug('Content script registration is up to date:', matches);
        return;
    }
    if (existing.length) {
        await browser.scripting.unregisterContentScripts({ ids: [CONTENT_SCRIPT_ID] });
    }
    if (!matches.length) {
        log.info('No Mastodon server with granted permission; content script not registered.');
        return;
    }
    await browser.scripting.registerContentScripts([{
        id: CONTENT_SCRIPT_ID,
        matches,
        js: ['content/content.js'],
        css: ['content/content.css'],
        runAt: 'document_start',
        persistAcrossSessions: false,
    }]);
    log.info('Content script registered for:', matches);
}

// ---------------------------------------------------------------------------
// Images

async function downloadImage(url) {
    let parsed;
    try {
        parsed = new URL(url);
    } catch {
        throw new FediscribeError('imageFetch', `Invalid image URL: ${url}`);
    }
    if (parsed.protocol !== 'https:') {
        throw new FediscribeError('imageFetch', `Unsupported image URL: ${url}`);
    }
    if (!(await browser.permissions.contains({ origins: [originPattern(parsed.hostname)] }))) {
        throw new FediscribeError('imagePermission', parsed.hostname);
    }

    log.debug('Downloading image:', url);
    let response;
    try {
        response = await fetch(url, { credentials: 'omit', signal: AbortSignal.timeout(IMAGE_FETCH_TIMEOUT_MS) });
    } catch (error) {
        throw new FediscribeError('imageFetch', `${parsed.hostname}: ${error.message}`);
    }
    if (!response.ok) {
        throw new FediscribeError('imageFetch', `${parsed.hostname}: HTTP ${response.status}`, response.status);
    }
    const bytes = new Uint8Array(await response.arrayBuffer());
    return { bytes, mimeType: response.headers.get('Content-Type') ?? '' };
}

async function loadImage(image) {
    if (image?.base64) {
        return { bytes: base64ToBytes(image.base64), mimeType: image.mimeType ?? '' };
    }
    if (image?.url) {
        return downloadImage(image.url);
    }
    throw new FediscribeError('imageNotFound');
}

// A small drawn picture used by "Test connection".
async function createTestImage() {
    const canvas = new OffscreenCanvas(320, 200);
    const context = canvas.getContext('2d');
    context.fillStyle = '#7ec8f0';
    context.fillRect(0, 0, 320, 200);
    context.fillStyle = '#3c9a3c';
    context.fillRect(0, 140, 320, 60);
    context.fillStyle = '#ffd700';
    context.beginPath();
    context.arc(260, 50, 28, 0, 2 * Math.PI);
    context.fill();
    context.fillStyle = '#8b4513';
    context.fillRect(60, 90, 16, 55);
    context.fillStyle = '#228b22';
    context.beginPath();
    context.arc(68, 80, 32, 0, 2 * Math.PI);
    context.fill();
    const blob = await canvas.convertToBlob({ type: 'image/png' });
    return { bytes: new Uint8Array(await blob.arrayBuffer()), mimeType: 'image/png' };
}

// ---------------------------------------------------------------------------
// Generation

// Returns { text, usage, durationMs, image }.
async function describeImage({ providerId, apiKey, model, language, maxChars, rawImage, timeoutSeconds }) {
    const provider = getProvider(providerId);
    const prepared = await prepareImage(rawImage.bytes, rawImage.mimeType);
    log.debug(`Image prepared: ${prepared.width}x${prepared.height} ${prepared.mimeType}`
        + `${prepared.converted ? ' (converted)' : ''}, ${Math.round(prepared.base64.length / 1024)} KiB Base64`);

    const prompt = buildPrompt({ language, maxChars });
    const started = Date.now();
    log.info(`Requesting alt text from ${providerId} (model ${model}, language ${language}).`);
    const { text, usage } = await provider.generate(
        { apiKey, model, prompt, image: prepared },
        { signal: AbortSignal.timeout(timeoutSeconds * 1000) },
    );
    const durationMs = Date.now() - started;
    log.info(`Alt text received after ${(durationMs / 1000).toFixed(1)} s.`, usage);
    return {
        text: truncateText(cleanResponseText(text), maxChars),
        usage,
        durationMs,
        image: { width: prepared.width, height: prepared.height, converted: prepared.converted },
    };
}

// The last generate request (success or failure), shown in the info popup of
// the content script. Kept in storage.session: it survives the event page
// being suspended and is cleared when the browser closes.
const LAST_REQUEST_KEY = 'lastRequest';

async function recordLastRequest(entry) {
    try {
        await browser.storage.session.set({ [LAST_REQUEST_KEY]: { time: Date.now(), ...entry } });
    } catch (error) {
        log.warn('Storing the last request failed:', error);
    }
}

async function handleGenerate(message) {
    const settings = await loadSettings();
    setDebug(settings.debug);
    const providerId = settings.provider;
    const rawImage = await loadImage(message.image);
    const maxChars = Number(message.maxChars) > 0 ? Number(message.maxChars) : DEFAULT_MAX_CHARS;
    const model = settings.models[providerId];
    const language = resolveLanguage(settings.language, message.detectedLanguage);
    try {
        const result = await describeImage({
            providerId,
            apiKey: settings.apiKeys[providerId],
            model,
            language,
            maxChars,
            rawImage,
            timeoutSeconds: settings.timeoutSeconds,
        });
        await recordLastRequest({
            provider: providerId,
            model,
            language,
            chars: result.text.length,
            usage: result.usage,
            durationMs: result.durationMs,
            image: result.image,
        });
        return { text: result.text };
    } catch (error) {
        await recordLastRequest({ provider: providerId, model, language, error: serializeError(error) });
        throw error;
    }
}

// Data for the info popup next to the button in Mastodon's dialog.
async function handleGetInfo() {
    const settings = await loadSettings();
    let lastRequest = null;
    try {
        ({ [LAST_REQUEST_KEY]: lastRequest = null } = await browser.storage.session.get(LAST_REQUEST_KEY));
    } catch (error) {
        log.warn('Reading the last request failed:', error);
    }
    return {
        provider: settings.provider,
        model: settings.models[settings.provider],
        language: settings.language,
        lastRequest,
    };
}

async function handleTestConnection(message) {
    const settings = await loadSettings();
    setDebug(settings.debug);
    const { text } = await describeImage({
        providerId: message.provider,
        apiKey: message.apiKey,
        model: message.model,
        language: resolveLanguage(settings.language, browser.i18n.getUILanguage()),
        maxChars: DEFAULT_MAX_CHARS,
        rawImage: await createTestImage(),
        timeoutSeconds: settings.timeoutSeconds,
    });
    return { text };
}

async function handleListModels(message) {
    const provider = getProvider(message.provider);
    const models = await provider.listModels(
        { apiKey: message.apiKey },
        { signal: AbortSignal.timeout(MODELS_TIMEOUT_MS) },
    );
    log.info(`${models.length} models listed for ${message.provider}.`);
    return { models };
}

// ---------------------------------------------------------------------------
// Messages

const HANDLERS = {
    generate: handleGenerate,
    testConnection: handleTestConnection,
    listModels: handleListModels,
    getInfo: handleGetInfo,
    openOptions: async () => {
        await browser.runtime.openOptionsPage();
        return {};
    },
    // Sent by the content script every few seconds while a request runs, so
    // that Firefox does not suspend the event page in the middle of it.
    keepAlive: async () => ({}),
    syncContentScripts: async () => {
        await syncContentScripts();
        return {};
    },
};

function serializeError(error) {
    if (error instanceof FediscribeError) {
        return error.toJSON();
    }
    return { code: 'unknown', detail: String(error?.message ?? error), status: 0 };
}

browser.runtime.onMessage.addListener((message, sender) => {
    if (sender.id !== browser.runtime.id) {
        return undefined;
    }
    const handler = HANDLERS[message?.type];
    if (!handler) {
        return undefined;
    }
    if (message.type !== 'keepAlive') {
        log.debug('Message received:', message.type);
    }
    return handler(message, sender)
        .then((result) => ({ ok: true, ...result }))
        .catch((error) => {
            log.error(`"${message.type}" failed:`, error);
            return { ok: false, error: serializeError(error) };
        });
});

// ---------------------------------------------------------------------------
// Lifecycle

browser.action.onClicked.addListener(() => {
    browser.runtime.openOptionsPage();
});

browser.runtime.onStartup.addListener(syncContentScripts);
browser.runtime.onInstalled.addListener(syncContentScripts);
browser.permissions.onAdded.addListener(syncContentScripts);
browser.permissions.onRemoved.addListener(syncContentScripts);
browser.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes.servers) {
        syncContentScripts();
    }
    if (area === 'local' && changes.debug) {
        setDebug(changes.debug.newValue);
    }
});

loadSettings().then((settings) => setDebug(settings.debug));
// Registrations do not persist across browser sessions, and the event page may
// have been restarted; make sure the registration matches the settings.
syncContentScripts();
