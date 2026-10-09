// SPDX-License-Identifier: GPL-3.0-or-later
// Content script for Mastodon pages: detects the alt-text dialog, inserts the
// "Generate alt text" button and fills in the generated text.
//
// Registered dynamically (see background.js) only for the Mastodon servers
// added in the settings. Content scripts cannot be ES modules, so this file is
// self-contained.

(() => {
    'use strict';

    if (window.fediscribeLoaded) {
        return;
    }
    window.fediscribeLoaded = true;

    const LOG_PREFIX = '[Fediscribe] [content]';
    const KEEP_ALIVE_INTERVAL_MS = 10_000;
    const DEFAULT_MAX_CHARS = 1500;

    // The text field of the alt-text dialog. The placeholder and labels are
    // translated, so detection relies on the DOM structure only.
    const TEXTAREA_SELECTOR = 'textarea#description, textarea#upload-modal__description';
    const DIALOG_SELECTOR = '.modal-root__modal, [role="dialog"]';
    const PREVIEW_SELECTOR = '.dialog-modal__content__preview, .focal-point';

    let debugEnabled = false;

    const log = {
        debug: (...args) => {
            if (debugEnabled) {
                console.debug(LOG_PREFIX, ...args);
            }
        },
        info: (...args) => console.info(LOG_PREFIX, ...args),
        warn: (...args) => console.warn(LOG_PREFIX, ...args),
        error: (...args) => console.error(LOG_PREFIX, ...args),
    };

    browser.storage.local.get('debug').then((stored) => {
        debugEnabled = Boolean(stored.debug);
    }).catch(() => {});
    browser.storage.onChanged.addListener((changes, area) => {
        if (area === 'local' && changes.debug) {
            debugEnabled = Boolean(changes.debug.newValue);
        }
    });

    function t(key, substitutions) {
        return browser.i18n.getMessage(key, substitutions) || key;
    }

    // Maps an error { code, detail, status } from the background script to a
    // UI text; unknown codes fall back to a generic message with the detail.
    function errorText(error) {
        const code = String(error?.code ?? 'unknown');
        const key = `error${code.charAt(0).toUpperCase()}${code.slice(1)}`;
        const substitutions = [String(error?.detail || '-'), String(error?.status ?? '')];
        return browser.i18n.getMessage(key, substitutions) || t('errorUnknown', substitutions);
    }

    // -----------------------------------------------------------------------
    // Image

    function findImageSource(dialog) {
        const preview = dialog.querySelector(PREVIEW_SELECTOR) ?? dialog;
        const images = [...preview.querySelectorAll('img')]
            .filter((img) => img.currentSrc || img.src);
        if (images.length) {
            // The largest image is the media preview (not an avatar or icon).
            images.sort((a, b) => (b.naturalWidth * b.naturalHeight) - (a.naturalWidth * a.naturalHeight));
            return images[0].currentSrc || images[0].src;
        }
        // For videos and GIFs (which Mastodon converts to videos), use the
        // preview image if there is one.
        const video = preview.querySelector('video[poster]');
        if (video?.poster) {
            return video.poster;
        }
        return null;
    }

    function blobToBase64(blob) {
        return new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => resolve(String(reader.result).split(',', 2)[1] ?? '');
            reader.onerror = () => reject(reader.error);
            reader.readAsDataURL(blob);
        });
    }

    // blob: and data: URLs are only readable in the page, so they are read
    // here; https: URLs are loaded by the background script, which is not
    // subject to CORS.
    async function readImage(dialog) {
        const source = findImageSource(dialog);
        if (!source) {
            throw { code: 'imageNotFound' };
        }
        log.debug('Image source:', source.slice(0, 200));
        if (source.startsWith('https:')) {
            return { url: source };
        }
        if (source.startsWith('blob:') || source.startsWith('data:')) {
            let blob;
            try {
                const response = await fetch(source);
                blob = await response.blob();
            } catch (error) {
                throw { code: 'imageFetch', detail: error.message };
            }
            return { base64: await blobToBase64(blob), mimeType: blob.type };
        }
        throw { code: 'imageFetch', detail: `Unsupported image URL: ${source.slice(0, 100)}` };
    }

    // -----------------------------------------------------------------------
    // Text field

    // Language for the "Automatic" setting: the post language, which Mastodon
    // sets as lang attribute on the text field, otherwise the language of the
    // Mastodon interface. The background script falls back to English.
    function detectLanguage(textarea) {
        return textarea.lang || document.documentElement.lang || '';
    }

    function maxCharsOf(textarea) {
        return textarea.maxLength > 0 ? textarea.maxLength : DEFAULT_MAX_CHARS;
    }

    // Mastodon's React code only notices the change if the value is set with
    // the native setter and an input event follows.
    function fillText(textarea, text) {
        const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
        setter.call(textarea, text);
        textarea.dispatchEvent(new Event('input', { bubbles: true }));
        textarea.focus();
    }

    // -----------------------------------------------------------------------
    // Button

    function setStatus(status, text, kind) {
        status.textContent = text;
        status.hidden = !text;
        status.classList.toggle('fediscribe-status--error', kind === 'error');
    }

    async function generate(dialog, button, status) {
        const textarea = dialog.querySelector(TEXTAREA_SELECTOR);
        if (!textarea) {
            log.warn('Text field not found in dialog.');
            return;
        }
        if (textarea.value.trim() && !window.confirm(t('confirmOverwrite'))) {
            return;
        }

        button.disabled = true;
        button.classList.add('fediscribe-button--busy');
        button.textContent = t('buttonGenerating');
        setStatus(status, '', null);

        const keepAlive = setInterval(() => {
            browser.runtime.sendMessage({ type: 'keepAlive' }).catch(() => {});
        }, KEEP_ALIVE_INTERVAL_MS);

        try {
            const image = await readImage(dialog);
            let response;
            try {
                response = await browser.runtime.sendMessage({
                    type: 'generate',
                    image,
                    detectedLanguage: detectLanguage(textarea),
                    maxChars: maxCharsOf(textarea),
                });
            } catch (error) {
                throw { code: 'extensionUnavailable', detail: error.message };
            }
            if (!response) {
                throw { code: 'extensionUnavailable', detail: 'No response from the background script.' };
            }
            if (!response.ok) {
                throw response.error ?? { code: 'unknown', detail: 'The background script reported an error without details.' };
            }
            if (typeof response.text !== 'string' || !response.text.trim()) {
                throw { code: 'emptyResponse', detail: 'The background script returned no text.' };
            }

            // React may have replaced the text field in the meantime.
            const target = textarea.isConnected ? textarea : dialog.querySelector(TEXTAREA_SELECTOR);
            if (!target) {
                log.warn('The dialog was closed before the alt text arrived.');
                return;
            }
            fillText(target, response.text);
            log.info(`Alt text inserted (${response.text.length} characters).`);
        } catch (error) {
            log.error('Generating the alt text failed:', error);
            setStatus(status, errorText(error), 'error');
        } finally {
            clearInterval(keepAlive);
            button.disabled = false;
            button.classList.remove('fediscribe-button--busy');
            button.textContent = t('buttonGenerate');
        }
    }

    // -----------------------------------------------------------------------
    // Info popup: current model and details of the last request

    const SVG_NS = 'http://www.w3.org/2000/svg';
    let popupCounter = 0;

    function createInfoIcon() {
        const svg = document.createElementNS(SVG_NS, 'svg');
        svg.setAttribute('viewBox', '0 0 16 16');
        svg.setAttribute('width', '16');
        svg.setAttribute('height', '16');
        svg.setAttribute('aria-hidden', 'true');
        const circle = document.createElementNS(SVG_NS, 'circle');
        circle.setAttribute('cx', '8');
        circle.setAttribute('cy', '8');
        circle.setAttribute('r', '7');
        circle.setAttribute('fill', 'none');
        circle.setAttribute('stroke', 'currentColor');
        circle.setAttribute('stroke-width', '1.5');
        const dot = document.createElementNS(SVG_NS, 'circle');
        dot.setAttribute('cx', '8');
        dot.setAttribute('cy', '4.75');
        dot.setAttribute('r', '1');
        dot.setAttribute('fill', 'currentColor');
        const bar = document.createElementNS(SVG_NS, 'path');
        bar.setAttribute('d', 'M8 7.25 V11.75');
        bar.setAttribute('stroke', 'currentColor');
        bar.setAttribute('stroke-width', '1.6');
        bar.setAttribute('stroke-linecap', 'round');
        svg.append(circle, dot, bar);
        return svg;
    }

    function uiLocale() {
        return browser.i18n.getUILanguage();
    }

    function languageDisplayName(code) {
        try {
            return new Intl.DisplayNames([uiLocale()], { type: 'language' }).of(code) || code;
        } catch {
            return code;
        }
    }

    function formatNumber(value, options) {
        return new Intl.NumberFormat(uiLocale(), options).format(value);
    }

    function providerName(provider) {
        const key = `provider${provider.charAt(0).toUpperCase()}${provider.slice(1)}`;
        return browser.i18n.getMessage(key) || provider;
    }

    // The popup takes the dialog's background, so it fits every Mastodon theme.
    function backgroundOf(element) {
        for (let node = element; node && node !== document.documentElement; node = node.parentElement) {
            const color = getComputedStyle(node).backgroundColor;
            if (color && color !== 'transparent' && !/rgba\(.*,\s*0\)$/.test(color)) {
                return color;
            }
        }
        return getComputedStyle(document.body).backgroundColor;
    }

    function addRow(list, label, value) {
        const term = document.createElement('dt');
        term.textContent = label;
        const definition = document.createElement('dd');
        definition.textContent = value;
        list.append(term, definition);
    }

    // The popup data comes from the background script; every value is checked
    // before it is shown, and rows with missing values are left out.
    function isCount(value) {
        return typeof value === 'number' && Number.isFinite(value) && value >= 0;
    }

    function lastRequestRows(list, request) {
        if (isCount(request.time)) {
            addRow(list, t('infoTime'), new Date(request.time).toLocaleTimeString(uiLocale()));
        }
        if (request.error) {
            addRow(list, t('infoResult'), errorText(request.error));
            return;
        }
        const usage = request.usage && typeof request.usage === 'object' ? request.usage : {};
        if (typeof usage.model === 'string' && usage.model && usage.model !== request.model) {
            addRow(list, t('infoModelUsed'), usage.model);
        }
        if (typeof usage.upstream === 'string' && usage.upstream) {
            addRow(list, t('infoUpstream'), usage.upstream);
        }
        if (isCount(request.durationMs)) {
            addRow(list, t('infoDuration'), t('infoSeconds', [formatNumber(request.durationMs / 1000, { maximumFractionDigits: 1 })]));
        }
        if (isCount(usage.inputTokens)) {
            addRow(list, t('infoInputTokens'), formatNumber(usage.inputTokens));
        }
        if (isCount(usage.outputTokens)) {
            const output = formatNumber(usage.outputTokens);
            addRow(list, t('infoOutputTokens'), isCount(usage.reasoningTokens) && usage.reasoningTokens > 0
                ? t('infoOutputWithReasoning', [output, formatNumber(usage.reasoningTokens)])
                : output);
        }
        if (isCount(usage.cost)) {
            addRow(list, t('infoCost'), formatNumber(usage.cost, { style: 'currency', currency: 'USD', maximumSignificantDigits: 3 }));
        }
        const image = request.image && typeof request.image === 'object' ? request.image : {};
        if (isCount(image.width) && isCount(image.height)) {
            addRow(list, t('infoImage'), t('infoImageSize', [String(image.width), String(image.height)]));
        }
        if (isCount(request.chars)) {
            addRow(list, t('infoLength'), t('infoCharacters', [formatNumber(request.chars)]));
        }
    }

    function renderInfo(popup, info, textarea) {
        const heading = document.createElement('div');
        heading.className = 'fediscribe-info__heading';
        heading.textContent = t('infoCurrentHeading');

        const current = document.createElement('dl');
        addRow(current, t('infoProvider'), providerName(String(info.provider ?? '')));
        addRow(current, t('infoModel'), (typeof info.model === 'string' && info.model) || t('infoModelNotSet'));
        addRow(current, t('infoLanguage'), info.language === 'auto' || typeof info.language !== 'string'
            ? t('infoLanguageAuto', [languageDisplayName((textarea && detectLanguage(textarea)) || 'en')])
            : languageDisplayName(info.language));

        const lastHeading = document.createElement('div');
        lastHeading.className = 'fediscribe-info__heading';
        lastHeading.textContent = t('infoLastHeading');

        const children = [heading, current, lastHeading];
        if (info.lastRequest && typeof info.lastRequest === 'object') {
            const last = document.createElement('dl');
            lastRequestRows(last, info.lastRequest);
            children.push(last);
        } else {
            const none = document.createElement('p');
            none.textContent = t('infoNoRequest');
            children.push(none);
        }

        const settings = document.createElement('button');
        settings.type = 'button';
        settings.className = 'link-button fediscribe-info__settings';
        settings.textContent = t('infoOpenSettings');
        settings.addEventListener('click', (event) => {
            event.preventDefault();
            event.stopPropagation();
            browser.runtime.sendMessage({ type: 'openOptions' }).catch((error) => log.error('Opening the settings failed:', error));
        });
        children.push(settings);
        popup.replaceChildren(...children);
    }

    // Info button with a popup that opens on hover and stays open on click.
    function createInfo(dialog, wrapper) {
        const infoButton = document.createElement('button');
        infoButton.type = 'button';
        infoButton.className = 'fediscribe-info-button';
        infoButton.setAttribute('aria-label', t('infoButtonLabel'));
        infoButton.title = t('infoButtonLabel');
        infoButton.append(createInfoIcon());

        const popup = document.createElement('div');
        popup.className = 'fediscribe-info';
        popup.id = `fediscribe-info-${++popupCounter}`;
        popup.hidden = true;
        infoButton.setAttribute('aria-controls', popup.id);
        infoButton.setAttribute('aria-expanded', 'false');

        let pinned = false;

        async function show() {
            const textarea = dialog.querySelector(TEXTAREA_SELECTOR);
            let response;
            try {
                response = await browser.runtime.sendMessage({ type: 'getInfo' });
            } catch (error) {
                response = { ok: false, error: { code: 'extensionUnavailable', detail: error.message } };
            }
            let rendered = false;
            if (response?.ok) {
                try {
                    renderInfo(popup, response, textarea);
                    rendered = true;
                } catch (error) {
                    log.error('Rendering the info popup failed:', error);
                    response = { error: { code: 'unknown', detail: String(error?.message ?? error) } };
                }
            }
            if (!rendered) {
                const message = document.createElement('p');
                message.textContent = errorText(response?.error);
                popup.replaceChildren(message);
            }
            popup.style.backgroundColor = backgroundOf(dialog);
            // Opens upwards; downwards only if there is not enough room above.
            popup.classList.remove('fediscribe-info--below');
            popup.hidden = false;
            if (popup.getBoundingClientRect().top < 0) {
                popup.classList.add('fediscribe-info--below');
            }
            infoButton.setAttribute('aria-expanded', 'true');
        }

        function hide() {
            pinned = false;
            popup.hidden = true;
            infoButton.setAttribute('aria-expanded', 'false');
        }

        wrapper.addEventListener('mouseenter', () => {
            if (popup.hidden) {
                show();
            }
        });
        wrapper.addEventListener('mouseleave', () => {
            if (!pinned) {
                hide();
            }
        });
        infoButton.addEventListener('click', (event) => {
            event.preventDefault();
            event.stopPropagation();
            if (pinned) {
                hide();
                return;
            }
            pinned = true;
            if (popup.hidden) {
                show();
            }
        });
        infoButton.addEventListener('keydown', (event) => {
            if (event.key === 'Escape' && !popup.hidden) {
                // Close only the popup, not Mastodon's dialog.
                event.preventDefault();
                event.stopPropagation();
                hide();
            }
        });
        document.addEventListener('mousedown', (event) => {
            if (pinned && !wrapper.contains(event.target)) {
                hide();
            }
        }, true);

        return {
            infoButton,
            popup,
            // Updates an open popup, e.g. after a request finished.
            refresh: () => {
                if (!popup.hidden) {
                    show();
                }
            },
        };
    }

    function createControls(dialog) {
        const button = document.createElement('button');
        // type="button": the dialog contains a form that must not be submitted.
        button.type = 'button';
        button.className = 'link-button fediscribe-button';
        button.textContent = t('buttonGenerate');
        button.title = t('buttonGenerateTitle');

        const status = document.createElement('div');
        status.className = 'fediscribe-status';
        status.setAttribute('role', 'status');
        status.hidden = true;

        const wrapper = document.createElement('span');
        wrapper.className = 'fediscribe-controls';
        const info = createInfo(dialog, wrapper);
        wrapper.append(button, info.infoButton, info.popup);

        button.addEventListener('click', async (event) => {
            event.preventDefault();
            event.stopPropagation();
            await generate(dialog, button, status);
            info.refresh();
        });
        return { controls: wrapper, status };
    }

    function insertControls(dialog, textarea) {
        const { controls, status } = createControls(dialog);
        const toolbar = dialog.querySelector('.input__toolbar');
        if (toolbar) {
            const spacer = toolbar.querySelector(':scope > .spacer');
            const help = toolbar.querySelector('.help-button');
            if (spacer) {
                spacer.after(controls);
            } else if (help) {
                help.before(controls);
            } else {
                toolbar.append(controls);
            }
            toolbar.after(status);
        } else {
            // Unknown layout: place the controls below the text field.
            const anchor = textarea.closest('.label_input, .input') ?? textarea;
            const wrapper = document.createElement('div');
            wrapper.className = 'fediscribe-toolbar';
            wrapper.append(controls);
            anchor.after(wrapper, status);
        }
        log.debug(toolbar ? 'Button inserted into the dialog toolbar.' : 'Button inserted below the text field.');
    }

    // -----------------------------------------------------------------------
    // Dialog detection

    function scan() {
        for (const textarea of document.querySelectorAll(TEXTAREA_SELECTOR)) {
            const dialog = textarea.closest(DIALOG_SELECTOR);
            if (!dialog || dialog.querySelector('.fediscribe-button')) {
                continue;
            }
            log.debug('Alt-text dialog detected.');
            insertControls(dialog, textarea);
        }
    }

    // Mastodon renders the dialog asynchronously, so watch the DOM from page
    // start. Scans are coalesced to at most one per animation frame.
    let scanScheduled = false;
    const observer = new MutationObserver(() => {
        if (scanScheduled) {
            return;
        }
        scanScheduled = true;
        requestAnimationFrame(() => {
            scanScheduled = false;
            try {
                scan();
            } catch (error) {
                log.error('Scanning for the alt-text dialog failed:', error);
            }
        });
    });
    observer.observe(document, { childList: true, subtree: true });
    // In case the dialog is already open when the script starts.
    scan();
    log.info('Content script active.');
})();
