# Fediscribe – Plan

Firefox extension that adds a button to Mastodon's alt-text dialog and generates an image description using AI.

Fediscribe is open, readable code under the GPL, with robust handling of the pitfalls listed below from the start.

## Goals

- Works on **any Mastodon server**, configurable in the settings.
- Providers: **OpenAI, Anthropic, Google Gemini, OpenRouter**, each with **model selection**.
- **Language** of the alt texts selectable in the settings.
- Plain JavaScript without a build step; the code in the repository is the code in the extension.
- Errors are shown with their actual cause, plus info logging in the console.

Non-goals: other platforms (Bluesky, Facebook, …), telemetry.

## Known pitfalls

| Pitfall | Solution in Fediscribe |
|---|---|
| API keys change format over time (e.g. Gemini keys starting with `AQ.`) | No key format validation; the key is only checked for being non-empty. "Test connection" shows whether it works. |
| Hard-coded models get shut down by the provider | The model list is fetched live from the provider, plus a free-text field. |
| Mastodon runs on countless servers | Servers are added in the settings; the content script is registered dynamically. |
| Images on a separate media server (e.g. `assets.example.social`) are blocked by CORS | Images are always loaded in the background script. The media server is detected automatically when adding a server, and its permission is requested along with it. |
| Firefox terminates the background script during slow API calls ("Extension was reloaded") | Keep-alive signals during the request, plus a timeout with a clear message. |
| Mastodon renders the dialog asynchronously; timing-based detection misses it | A `MutationObserver` runs from page start. The dialog is detected via Mastodon's DOM structure, not via (translated) texts. |
| Swallowed errors make problems impossible to diagnose | Errors are shown with their cause and logged with the prefix `[Fediscribe]`. |

## Architecture

```
fediscribe/
├── manifest.json          MV3, Firefox (gecko)
├── background.js          Message routing, image download, API calls, content script registration
├── providers/
│   ├── openai.js          generate(), listModels()
│   ├── anthropic.js
│   ├── gemini.js
│   └── openrouter.js
├── shared/
│   ├── settings.js        Load/save (browser.storage.local), defaults
│   ├── prompt.js          Prompt text depending on the language
│   ├── i18n.js            Fill in translated texts for elements with data-i18n attributes
│   └── log.js             Logging with prefix
├── content/
│   ├── content.js         Detect dialog, insert button, fill in text
│   └── content.css
├── options/               Settings page
│   ├── options.html
│   ├── options.js
│   └── options.css
├── _locales/
│   └── en/messages.json   All UI strings (default and, for now, only locale)
├── icons/
├── tests/                 node --test for pure functions (request building, response parsing, URL normalization)
├── package.json           Dev tools only: web-ext (lint/build/sign)
├── LICENSE                GPL-3.0
└── README.md
```

### Flow

1. The **content script** (only on configured Mastodon servers) detects the alt-text dialog and inserts the "Generate alt text" button.
2. Click → determine the image URL from the dialog:
   - The content script reads `blob:`/`data:` URLs itself.
   - The background script loads `https:` URLs.
3. Message to the background script with the image (Base64 + MIME type). While waiting, the page sends a keep-alive signal every 10 s.
4. The **background script** downscales the image if needed, calls the selected provider with the selected model, and returns the text or an error.
5. The content script fills the text into the text field in a way that Mastodon's React code picks up the change (native setter + `input` event). Existing text is only overwritten after confirmation.

### Adding a Mastodon server (settings page)

1. The user enters the domain (e.g. `example.social`); it is normalized.
2. Check whether it is a Mastodon server (`/api/v2/instance`).
3. Detect the media server: read a media URL of a public post from `/api/v1/timelines/public?local=true&only_media=true`. If none is available, let the user enter the media server manually.
4. `browser.permissions.request()` for the server and the media server. This is only possible from the settings page, because Firefox requires a user action for it.
5. Register the content script via `browser.scripting.registerContentScripts()`; re-register on extension startup.

### Settings

- **Mastodon servers:** list with add/remove, including media server
- **Provider:** OpenAI / Anthropic / Gemini / OpenRouter
- **API key** per provider (stored locally in `browser.storage.local`)
- **Model:** dropdown (loaded live from the provider, filtered by image capability where the API provides it) and free-text field
- **Language** of the alt text: German, English, … or "same as the Mastodon interface"
- **"Test connection" button:** sends a small test image to the provider
- **Debug logging** on/off (default: info messages on)

### Providers

| Provider | Image description endpoint | Model list | Auth |
|---|---|---|---|
| OpenAI | `POST /v1/chat/completions` | `GET /v1/models` | `Authorization: Bearer` |
| Anthropic | `POST /v1/messages` | `GET /v1/models` | `x-api-key`, `anthropic-version`, `anthropic-dangerous-direct-browser-access: true` |
| Gemini | `POST /v1beta/models/{model}:generateContent` | `GET /v1beta/models` | `x-goog-api-key` (header, not `?key=`) |
| OpenRouter | `POST /api/v1/chat/completions` (OpenAI-compatible) | `GET /api/v1/models` (filter: image input) | `Authorization: Bearer` |

The exact current parameters (e.g. token limits, model names) are verified against each provider's documentation during implementation.

### Prompt

- Our own wording: describes the essentials first, mentions visible text, no "Image of …", no speculation.
- Language from the settings.
- Length: target 1–3 sentences; upper limit from the text field's `maxlength` (if present), otherwise 1500 characters.

## Permissions

- `storage`, `scripting`
- `host_permissions`: the four API hosts
- `optional_host_permissions`: `https://*/*`. Only the Mastodon and media servers actually added are requested from it.
- `data_collection_permissions`: none. Images are only sent to the selected provider.

## Implementation steps

1. Skeleton: manifest (incl. `default_locale`), `_locales/en/messages.json`, i18n helper, logging, settings (without UI), lint with `web-ext`.
2. Provider modules with unit tests (request building, response parsing, error cases).
3. Background script: messages, image download, downscaling, keep-alive, timeout.
4. Settings page: add server incl. media server detection and permissions, provider/key/model, language, connection test.
5. Content script: verify dialog detection against the real Mastodon DOM (web interface and `/publish`), button, filling in text.
6. Manual tests on a real Mastodon server with a separate media server, with all four providers.
7. README, `web-ext build`, signing (unlisted).

## Decisions

- Mastodon only; four providers with model selection; language selectable.
- **No clipboard feature** (for now).
- **Sign unlisted only for now** (for personal use). A **public AMO version is planned for later**. Therefore from the start: permanent extension ID, license file, no third-party code, no telemetry, privacy notice in the README.

- **License: GPL-3.0-or-later.** Full text in `LICENSE`; every source file gets a short header with `SPDX-License-Identifier: GPL-3.0-or-later`. Rationale: derivatives should stay open, so that Fediscribe cannot end up as a closed product.

- **Extension ID: `fediscribe@netzgewitter.com`** (`browser_specific_settings.gecko.id`). Permanent; never change it, otherwise Firefox treats it as a new extension.

- **Project language: English.** All documents, source code, code comments, log messages and user interface texts are written in English. (The language of the *generated alt texts* remains a user setting.)

- **Translatable UI, English only for now.** All UI texts (button, error messages, settings page, extension name and description) come from `_locales/en/messages.json` via `browser.i18n.getMessage()`; no UI text is hard-coded. The manifest sets `"default_locale": "en"` and uses `__MSG_…__` for name and description. HTML elements get `data-i18n` attributes that `shared/i18n.js` fills in. Firefox picks the locale from its UI language and falls back to `en`. Only English is shipped for now; adding a language later means adding `_locales/<lang>/messages.json` without code changes.

## Context for implementation

### Mastodon DOM notes

- The alt-text dialog has a toolbar; the button goes after `.spacer` or before `.help-button`.
- The text field has `id="description"`; the placeholder is translated and therefore not suitable for detection.
- The image is an `<img>` in the dialog, usually with an `https:` URL on the media server (which may send no CORS headers).
- Both the normal web interface **and** the separate compose page `/publish` must be supported and tested.

### Firefox quirks (MV3)

- `host_permissions` are **optional** in Firefox MV3; the user must grant them. The settings page should detect missing permissions and request them via a button (`browser.permissions.request`, user action only).
- **Do not set a `connect-src` rule** in `content_security_policy`: it also applies to the background script and would block dynamically added media servers.
- The background is an **event page** (`"background": {"scripts": [...]}`), not a service worker. Firefox terminates it after about 30 s without events, even if a `fetch` is still running. Countermeasure: keep-alive messages from the content script.
- Content script logs appear in the page console (F12; enable "Show Content Scripts" in the debugger settings). Background logs appear under `about:debugging` → extension → **Inspect**. Open DevTools keep the event page alive and distort tests of timing issues.
- Temporarily loaded and signed installed versions have **separate** settings and permissions.
- Release builds of Firefox only install extensions signed by Mozilla.

### Testing and signing

```zsh
# Lint and tests
npx -y web-ext@8 lint --source-dir .
node --test tests/

# Load temporarily: about:debugging#/runtime/this-firefox → "Load Temporary Add-on…" → manifest.json

# Sign unlisted (AMO API credentials: https://addons.mozilla.org/developers/addon/api/key/)
read -r "WEB_EXT_API_KEY?JWT issuer: "; read -rs "WEB_EXT_API_SECRET?JWT secret: "; echo
export WEB_EXT_API_KEY WEB_EXT_API_SECRET
npx -y web-ext@8 sign --source-dir . --artifacts-dir dist --channel unlisted
```

- `version` must be incremented for every new signing.
- `web-ext` must ignore development files (`--ignore-files` or `webExt.ignoreFiles` in `package.json`: `tests/`, `dist/`, `PLAN.md`, `CLAUDE.md`, `CLAUDE.local.md`, `node_modules/`). `LICENSE` is included in the package.
