// SPDX-License-Identifier: GPL-3.0-or-later
// Settings page.

import { applyI18n, t } from '../shared/i18n.js';
import { createLogger, setDebug } from '../shared/log.js';
import { inspectServer, loadPopularServers, parseHostList } from '../shared/mastodon.js';
import {
    DEFAULT_TIMEOUT_SECONDS, LANGUAGE_CODES, loadSettings, normalizeDomain, originPattern, saveSettings, serverHosts,
} from '../shared/settings.js';
import { setupCombobox } from './combobox.js';

const log = createLogger('options');

const $ = (id) => document.getElementById(id);

let settings;
// Result of the last server check, waiting for "Add server".
let pendingServer = null;
// Loaded model lists per provider.
const modelCache = {};

// ---------------------------------------------------------------------------
// Helpers

function errorText(error) {
    const code = String(error?.code ?? 'unknown');
    const key = `error${code.charAt(0).toUpperCase()}${code.slice(1)}`;
    const substitutions = [String(error?.detail || '-'), String(error?.status ?? '')];
    return browser.i18n.getMessage(key, substitutions) || t('errorUnknown', substitutions);
}

function setStatus(element, text, kind = 'info') {
    element.textContent = text;
    element.dataset.kind = kind;
}

let savedTimer;
async function save(partial) {
    Object.assign(settings, partial);
    await saveSettings(partial);
    setStatus($('saved-status'), t('settingsSaved'), 'success');
    clearTimeout(savedTimer);
    savedTimer = setTimeout(() => setStatus($('saved-status'), ''), 2000);
}

// Sends a message to the background script; throws the error it reports.
async function callBackground(message) {
    const response = await browser.runtime.sendMessage(message);
    if (!response?.ok) {
        throw response?.error ?? { code: 'extensionUnavailable' };
    }
    return response;
}

// ---------------------------------------------------------------------------
// API host permissions

const API_ORIGINS = browser.runtime.getManifest().host_permissions;

async function renderApiPermissions() {
    const granted = await browser.permissions.contains({ origins: API_ORIGINS });
    $('api-permissions').hidden = granted;
}

function setupApiPermissions() {
    $('api-permissions-grant').addEventListener('click', () => {
        // Must be called directly in the click handler (user action).
        browser.permissions.request({ origins: API_ORIGINS })
            .then(renderApiPermissions)
            .catch((error) => log.error('Permission request failed:', error));
    });
}

// ---------------------------------------------------------------------------
// Mastodon servers

async function renderServers() {
    // Built completely before replacing the list, so that overlapping calls
    // cannot produce duplicate entries.
    const items = [];

    for (const server of settings.servers) {
        const origins = serverHosts(server).map(originPattern);
        const granted = await browser.permissions.contains({ origins });

        const item = document.createElement('li');
        const info = document.createElement('div');
        const name = document.createElement('strong');
        name.textContent = server.domain;
        const media = document.createElement('div');
        media.className = 'hint';
        media.textContent = server.mediaHosts?.length
            ? t('serverMediaHosts', [server.mediaHosts.join(', ')])
            : t('serverNoMediaHosts');
        info.append(name, media);
        if (!granted) {
            const warning = document.createElement('div');
            warning.className = 'warning';
            warning.textContent = t('serverPermissionMissing');
            info.append(warning);
        }

        const buttons = document.createElement('div');
        buttons.className = 'buttons';
        if (!granted) {
            const grant = document.createElement('button');
            grant.type = 'button';
            grant.className = 'primary';
            grant.textContent = t('serverGrantButton');
            grant.addEventListener('click', () => {
                browser.permissions.request({ origins })
                    .then(renderServers)
                    .catch((error) => log.error('Permission request failed:', error));
            });
            buttons.append(grant);
        }
        const remove = document.createElement('button');
        remove.type = 'button';
        remove.textContent = t('serverRemoveButton');
        remove.addEventListener('click', () => removeServer(server.domain));
        buttons.append(remove);

        item.append(info, buttons);
        items.push(item);
    }
    $('server-list').replaceChildren(...items);
    $('server-empty').hidden = items.length > 0;
}

async function removeServer(domain) {
    const removed = settings.servers.find((server) => server.domain === domain);
    const servers = settings.servers.filter((server) => server.domain !== domain);
    await save({ servers });

    // Release permissions that no remaining server needs.
    const stillNeeded = new Set(servers.flatMap(serverHosts));
    const origins = serverHosts(removed)
        .filter((host) => !stillNeeded.has(host))
        .map(originPattern)
        .filter((origin) => !API_ORIGINS.includes(origin));
    if (origins.length) {
        await browser.permissions.remove({ origins });
    }
    log.info('Server removed:', domain);
    setStatus($('server-status'), t('serverRemoved', [domain]));
    renderServerSuggestions();
    await renderServers();
}

function resetServerCheck() {
    pendingServer = null;
    $('server-add').disabled = true;
    $('server-check').hidden = true;
    $('server-media').value = '';
}

// The check runs automatically, so that "Add server" can request the
// permissions right away: the request must happen directly in the click.
let checkTimer;
let checkedInput = '';

function scheduleServerCheck(delay) {
    clearTimeout(checkTimer);
    checkTimer = setTimeout(checkServer, delay);
}

async function checkServer() {
    clearTimeout(checkTimer);
    const input = $('server-domain').value.trim();
    if (input === checkedInput) {
        return;
    }
    checkedInput = input;
    resetServerCheck();
    if (!input) {
        setStatus($('server-status'), '');
        return;
    }
    const domain = normalizeDomain(input);
    if (!domain) {
        setStatus($('server-status'), t('serverInvalidDomain'), 'error');
        return;
    }
    setStatus($('server-status'), t('serverChecking', [domain]));
    try {
        const info = await inspectServer(domain);
        if (checkedInput !== input) {
            // The input changed in the meantime; a newer check is running.
            return;
        }
        log.info('Server checked:', info);
        pendingServer = info;
        $('server-check-result').textContent = t('serverFound', [info.title, info.version]);
        $('server-media').value = info.mediaHosts.join(' ');
        $('server-check').hidden = false;
        $('server-add').disabled = false;
        setStatus($('server-status'), info.mediaHosts.length
            ? t('serverMediaDetected')
            : t('serverMediaNotDetected'));
    } catch (error) {
        if (checkedInput !== input) {
            return;
        }
        log.error('Server check failed:', error);
        setStatus($('server-status'), errorText(error), 'error');
    }
}

// Popular servers for the drop-down list, loaded when the page opens (not on
// focus: Firefox does not open the drop-down by itself once a list that was
// empty during the click arrives). Without the list the field still accepts
// any server.
let popularServers = [];

// Fills the drop-down list, leaving out servers that are already added.
// Called again after adding or removing a server.
function renderServerSuggestions() {
    const added = new Set(settings.servers.map((server) => server.domain));
    const options = popularServers.filter((domain) => !added.has(domain)).map((domain) => {
        const option = document.createElement('option');
        option.value = domain;
        return option;
    });
    $('server-suggestions').replaceChildren(...options);
}

async function loadServerSuggestions() {
    try {
        popularServers = await loadPopularServers();
        renderServerSuggestions();
        log.debug(`${popularServers.length} server suggestions loaded.`);
    } catch (error) {
        log.warn('Loading the server suggestions failed:', error);
    }
}

function addServer() {
    if (!pendingServer) {
        return;
    }
    const { hosts, invalid } = parseHostList($('server-media').value);
    if (invalid.length) {
        setStatus($('server-status'), t('serverInvalidMedia', [invalid.join(', ')]), 'error');
        return;
    }
    const server = { domain: pendingServer.domain, mediaHosts: hosts.filter((host) => host !== pendingServer.domain) };
    const origins = serverHosts(server).map(originPattern);

    // Must be called directly in the click handler (user action), before any
    // other asynchronous step.
    browser.permissions.request({ origins }).then(async (granted) => {
        if (!granted) {
            setStatus($('server-status'), t('serverPermissionDenied'), 'error');
            return;
        }
        const servers = settings.servers.filter((existing) => existing.domain !== server.domain);
        servers.push(server);
        servers.sort((a, b) => a.domain.localeCompare(b.domain));
        await save({ servers });
        await callBackground({ type: 'syncContentScripts' });
        log.info('Server added:', server);
        resetServerCheck();
        $('server-domain').value = '';
        checkedInput = '';
        renderServerSuggestions();
        setStatus($('server-status'), t('serverAdded', [server.domain]), 'success');
        await renderServers();
    }).catch((error) => {
        log.error('Adding the server failed:', error);
        setStatus($('server-status'), errorText({ code: 'unknown', detail: error.message ?? error.detail }), 'error');
    });
}

function setupServers() {
    const field = $('server-domain');

    // Firefox opens the drop-down list only when the field already has focus,
    // so the first click would just focus it. Open it explicitly in that case.
    let focusedBeforeClick = false;
    field.addEventListener('mousedown', () => {
        focusedBeforeClick = document.activeElement === field;
    });
    field.addEventListener('click', () => {
        if (focusedBeforeClick) {
            return;
        }
        try {
            field.showPicker();
        } catch (error) {
            log.debug('showPicker() is not available:', error);
        }
    });
    field.addEventListener('input', (event) => {
        // Picking an entry from the list checks at once; typing waits for a pause.
        const picked = event.inputType === 'insertReplacementText' || !event.inputType;
        if (field.value.trim() !== checkedInput) {
            resetServerCheck();
        }
        scheduleServerCheck(picked ? 0 : 800);
    });
    field.addEventListener('change', checkServer);
    field.addEventListener('keydown', (event) => {
        if (event.key !== 'Enter') {
            return;
        }
        event.preventDefault();
        if (pendingServer && field.value.trim() === checkedInput) {
            addServer();
        } else {
            checkServer();
        }
    });
    $('server-add').addEventListener('click', addServer);
}

// ---------------------------------------------------------------------------
// Provider, API key and model

function currentProvider() {
    return $('provider').value;
}

let modelCombobox;

function renderModelList() {
    modelCombobox?.refresh();
}

async function loadModels({ force = false } = {}) {
    const provider = currentProvider();
    const apiKey = $('api-key').value.trim();
    if (!apiKey) {
        renderModelList();
        setStatus($('models-status'), t('modelsNeedKey'));
        return;
    }
    if (modelCache[provider] && !force) {
        renderModelList();
        return;
    }
    $('models-reload').disabled = true;
    setStatus($('models-status'), t('modelsLoading'));
    try {
        const { models } = await callBackground({ type: 'listModels', provider, apiKey });
        if (provider !== currentProvider()) {
            return;
        }
        modelCache[provider] = models;
        renderModelList();
        setStatus($('models-status'), t('modelsLoaded', [String(models.length)]), 'success');
    } catch (error) {
        log.error('Loading the model list failed:', error);
        delete modelCache[provider];
        renderModelList();
        setStatus($('models-status'), errorText(error), 'error');
    } finally {
        $('models-reload').disabled = false;
    }
}

function renderProvider() {
    const provider = currentProvider();
    modelCombobox.close();
    $('api-key').value = settings.apiKeys[provider] ?? '';
    $('model').value = settings.models[provider] ?? '';
    setStatus($('models-status'), '');
    setStatus($('test-status'), '');
    loadModels();
}

async function testConnection() {
    const provider = currentProvider();
    $('test-connection').disabled = true;
    setStatus($('test-status'), t('testRunning'));
    try {
        const { text } = await callBackground({
            type: 'testConnection',
            provider,
            apiKey: $('api-key').value,
            model: $('model').value,
        });
        setStatus($('test-status'), t('testSuccess', [text]), 'success');
    } catch (error) {
        log.error('Connection test failed:', error);
        setStatus($('test-status'), errorText(error), 'error');
    } finally {
        $('test-connection').disabled = false;
    }
}

function setupProvider() {
    $('provider').value = settings.provider;
    $('provider').addEventListener('change', async () => {
        await save({ provider: currentProvider() });
        renderProvider();
    });

    $('api-key').addEventListener('change', async () => {
        const provider = currentProvider();
        await save({ apiKeys: { ...settings.apiKeys, [provider]: $('api-key').value.trim() } });
        delete modelCache[provider];
        loadModels();
    });
    $('api-key-show').addEventListener('change', () => {
        $('api-key').type = $('api-key-show').checked ? 'text' : 'password';
    });

    modelCombobox = setupCombobox({
        input: $('model'),
        list: $('model-options'),
        getItems: () => modelCache[currentProvider()] ?? [],
        onCommit: (value) => save({ models: { ...settings.models, [currentProvider()]: value } }),
        emptyText: () => t('modelsNoMatch'),
    });
    $('models-reload').addEventListener('click', () => loadModels({ force: true }));
    $('test-connection').addEventListener('click', testConnection);

    renderProvider();
}

// ---------------------------------------------------------------------------
// Language and advanced settings

function setupLanguage() {
    const select = $('language');
    const auto = document.createElement('option');
    auto.value = 'auto';
    auto.textContent = t('languageAuto');
    select.append(auto);

    const displayNames = new Intl.DisplayNames([browser.i18n.getUILanguage()], { type: 'language' });
    const languages = LANGUAGE_CODES
        .map((code) => ({ code, name: displayNames.of(code) ?? code }))
        .sort((a, b) => a.name.localeCompare(b.name));
    for (const { code, name } of languages) {
        const option = document.createElement('option');
        option.value = code;
        option.textContent = name;
        select.append(option);
    }
    if (settings.language !== 'auto' && !LANGUAGE_CODES.includes(settings.language)) {
        const option = document.createElement('option');
        option.value = settings.language;
        option.textContent = settings.language;
        select.append(option);
    }
    select.value = settings.language;
    select.addEventListener('change', () => save({ language: select.value }));
}

function setupAdvanced() {
    $('timeout').value = settings.timeoutSeconds;
    $('timeout').addEventListener('change', () => {
        const value = Math.round(Number($('timeout').value));
        const timeoutSeconds = Number.isFinite(value) && value >= 10 && value <= 600 ? value : DEFAULT_TIMEOUT_SECONDS;
        $('timeout').value = timeoutSeconds;
        save({ timeoutSeconds });
    });

    $('debug').checked = settings.debug;
    $('debug').addEventListener('change', () => {
        setDebug($('debug').checked);
        save({ debug: $('debug').checked });
    });
}

// ---------------------------------------------------------------------------

async function init() {
    applyI18n();
    settings = await loadSettings();
    setDebug(settings.debug);

    setupApiPermissions();
    setupServers();
    setupProvider();
    setupLanguage();
    setupAdvanced();

    await renderApiPermissions();
    loadServerSuggestions();
    await renderServers();
    browser.permissions.onAdded.addListener(() => {
        renderApiPermissions();
        renderServers();
    });
    browser.permissions.onRemoved.addListener(() => {
        renderApiPermissions();
        renderServers();
    });
}

init().catch((error) => log.error('Initializing the settings page failed:', error));
