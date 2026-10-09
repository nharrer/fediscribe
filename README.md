# Fediscribe

Firefox extension that adds a **"Generate alt text"** button to Mastodon's alt-text dialog. It sends the image to an AI provider of your choice and fills in the generated image description, which you can then review and edit.

- Works on any Mastodon server (including the compose page `/publish`) and on servers that deliver images from a separate media server.
- Providers: **OpenAI, Anthropic, Google Gemini, OpenRouter**, each with a model list loaded live from the provider, or any model ID you enter.
- Language of the alt texts selectable, or automatic: the language of the post, otherwise that of the Mastodon interface.
- Plain JavaScript without a build step. Licensed under the GPL-3.0-or-later.

## Setup

1. Install the extension and open its settings (toolbar button, or `about:addons` → Fediscribe → Preferences).
2. **Mastodon servers:** choose your server from the list or type it in (e.g. `mastodon.social`). Fediscribe verifies that it is a Mastodon server and detects its media server. Click *Add server* and allow access when Firefox asks. Reload open tabs of that server.
3. **AI provider:** choose a provider, enter your API key, pick a model that accepts images and click *Test connection*.
4. Optionally choose the language of the alt texts.

In Mastodon, attach an image, open its alt-text dialog (*Add alt text* / *Edit*) and click **Generate alt text**. If the field already contains text, Fediscribe asks before replacing it.

The info button (ⓘ) next to it shows the model in use and details of the last request: duration, tokens and, with OpenRouter, the cost.

## Privacy

- Fediscribe collects no data and has no telemetry.
- When you click *Generate alt text*, the image is sent to the AI provider selected in the settings, and only there. Its privacy policy and terms apply.
- API keys and settings are stored locally in your browser (`browser.storage.local`) and are only sent to the respective provider.
- The settings page loads the list of popular servers from the joinmastodon.org directory (`api.joinmastodon.org`), at most once a day.
- Fediscribe only runs on the Mastodon servers you add and only requests access to those servers, their media servers and the four provider APIs.

## Troubleshooting

- Errors are shown below the button with the provider's own message.
- All log messages start with `[Fediscribe]`. Content script messages appear in the page console (F12; enable "Show Content Scripts"), background messages under `about:debugging` → Fediscribe → *Inspect*. Enable *Debug logging* in the settings for details.
- *"no access to the media server"*: the server's images come from a host that was not added. Remove the server and add it again with that host in the *Media servers* field.

## Development

```zsh
npx -y web-ext@8 lint --source-dir .   # lint
node --test                            # unit tests (Node.js 22+)
npx -y web-ext@8 build --source-dir . --artifacts-dir dist
```

Releasing a version (signing, installing): see [RELEASE.md](RELEASE.md).

Load temporarily via `about:debugging#/runtime/this-firefox` → *Load Temporary Add-on…* → `manifest.json`.

All UI texts live in `_locales/en/messages.json`. To add a translation, add `_locales/<lang>/messages.json`; no code changes are needed.

## License

[GPL-3.0-or-later](LICENSE)
