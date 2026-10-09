// SPDX-License-Identifier: GPL-3.0-or-later

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { filterModels } from '../shared/search.js';
import { base64ToBytes, bytesToBase64, scaledSize, sniffMimeType } from '../shared/image.js';
import { extractMediaHosts, isMastodonInstance, parseHostList, selectPopularServers } from '../shared/mastodon.js';
import { buildPrompt, cleanResponseText, languageName, resolveLanguage, truncateText } from '../shared/prompt.js';
import { mergeWithDefaults, normalizeDomain, originPattern } from '../shared/settings.js';

describe('normalizeDomain', () => {
    it('accepts common input forms', () => {
        assert.equal(normalizeDomain('example.social'), 'example.social');
        assert.equal(normalizeDomain('  Example.Social  '), 'example.social');
        assert.equal(normalizeDomain('https://example.social/@user/123'), 'example.social');
        assert.equal(normalizeDomain('example.social/publish'), 'example.social');
        assert.equal(normalizeDomain('@user@example.social'), 'example.social');
        assert.equal(normalizeDomain('assets.example.social.'), 'assets.example.social');
    });

    it('rejects invalid input', () => {
        assert.equal(normalizeDomain(''), null);
        assert.equal(normalizeDomain('localhost'), null);
        assert.equal(normalizeDomain('exa mple.social'), null);
        assert.equal(normalizeDomain('example.social:8443'), null);
        assert.equal(normalizeDomain(undefined), null);
    });

    it('builds origin patterns', () => {
        assert.equal(originPattern('example.social'), 'https://example.social/*');
    });
});

describe('settings', () => {
    it('merges stored values with defaults', () => {
        const settings = mergeWithDefaults({ provider: 'gemini', apiKeys: { gemini: 'k' } });
        assert.equal(settings.provider, 'gemini');
        assert.equal(settings.apiKeys.gemini, 'k');
        assert.equal(settings.apiKeys.openai, '');
        assert.equal(settings.language, 'auto');
        assert.deepEqual(settings.servers, []);
    });
});

describe('prompt', () => {
    it('names the language and the character limit', () => {
        const { system, user } = buildPrompt({ language: 'de', maxChars: 420 });
        assert.match(system, /German/);
        assert.match(system, /420 characters/);
        assert.match(user, /German/);
    });

    it('resolves "auto" to the detected language, falling back to English', () => {
        assert.equal(resolveLanguage('auto', 'fr'), 'fr');
        assert.equal(resolveLanguage('auto', ''), 'en');
        assert.equal(resolveLanguage('de', 'fr'), 'de');
        assert.equal(languageName('pt-BR'), 'Brazilian Portuguese');
        assert.equal(languageName('not a code!'), 'not a code!');
    });

    it('truncates at sentence or word boundaries', () => {
        assert.equal(truncateText('Short.', 100), 'Short.');
        assert.equal(truncateText('One sentence here. Two sentence here.', 30), 'One sentence here.');
        const truncated = truncateText('aaaa bbbb cccc dddd eeee', 12);
        assert.ok(truncated.length <= 12, truncated);
        assert.ok(truncated.endsWith('…'));
        assert.ok(truncateText('x'.repeat(50), 10).length <= 10);
    });

    it('removes wrapping the model added', () => {
        assert.equal(cleanResponseText('"A cat on a sofa."'), 'A cat on a sofa.');
        assert.equal(cleanResponseText('Alt text: A cat.'), 'A cat.');
        assert.equal(cleanResponseText('„Eine Katze.“'), 'Eine Katze.');
        assert.equal(cleanResponseText('A "quoted" word.'), 'A "quoted" word.');
    });
});

describe('image helpers', () => {
    it('round-trips Base64', () => {
        const bytes = new Uint8Array(100_000).map((_, i) => i % 256);
        assert.deepEqual(base64ToBytes(bytesToBase64(bytes)), bytes);
        assert.equal(bytesToBase64(new TextEncoder().encode('ABC')), 'QUJD');
    });

    it('detects image types from magic bytes', () => {
        assert.equal(sniffMimeType(new Uint8Array([0xff, 0xd8, 0xff, 0xe0])), 'image/jpeg');
        assert.equal(sniffMimeType(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d])), 'image/png');
        assert.equal(sniffMimeType(new TextEncoder().encode('GIF89a')), 'image/gif');
        assert.equal(sniffMimeType(new TextEncoder().encode('RIFF\0\0\0\0WEBPVP8 ')), 'image/webp');
        assert.equal(sniffMimeType(new TextEncoder().encode('<html>')), '');
    });

    it('scales down keeping the aspect ratio', () => {
        assert.deepEqual(scaledSize(800, 600, 1568), { width: 800, height: 600 });
        assert.deepEqual(scaledSize(4000, 2000, 1000), { width: 1000, height: 500 });
        assert.deepEqual(scaledSize(100, 5000, 1000), { width: 20, height: 1000 });
    });
});

describe('Mastodon helpers', () => {
    it('recognizes Mastodon instance info', () => {
        assert.ok(isMastodonInstance({ domain: 'example.social', version: '4.4.0', configuration: {} }));
        assert.ok(!isMastodonInstance({ domain: 'example.social' }));
        assert.ok(!isMastodonInstance(null));
    });

    it('detects media hosts from the thumbnail and attachments', () => {
        const hosts = extractMediaHosts(
            'example.social',
            { thumbnail: { url: 'https://assets.example.social/site/thumb.png' } },
            [
                { media_attachments: [{ url: 'https://assets.example.social/a.jpg', preview_url: 'https://cdn.example.net/a.jpg' }] },
                { media_attachments: [{ url: 'https://example.social/system/b.jpg', preview_url: null }] },
                { media_attachments: [{ url: 'http://insecure.example/c.jpg' }] },
            ],
        );
        assert.deepEqual(hosts, ['assets.example.social', 'cdn.example.net']);
        assert.deepEqual(extractMediaHosts('example.social', null, { error: 'unauthorized' }), []);
    });

    it('parses user-entered host lists', () => {
        assert.deepEqual(parseHostList('assets.example.social, https://cdn.example.net/x  assets.example.social'),
            { hosts: ['assets.example.social', 'cdn.example.net'], invalid: [] });
        assert.deepEqual(parseHostList('nohost'), { hosts: [], invalid: ['nohost'] });
        assert.deepEqual(parseHostList(''), { hosts: [], invalid: [] });
    });

    it('selects the most active servers from the directory', () => {
        const directory = [
            { domain: 'small.example', last_week_users: 10 },
            { domain: 'Big.Example', last_week_users: 5000 },
            { domain: 'mid.example', last_week_users: 300 },
            { domain: 'no-users.example' },
            { domain: 'big.example', last_week_users: 1 },
            { name: 'broken entry' },
        ];
        assert.deepEqual(selectPopularServers(directory, 4), ['big.example', 'oldbytes.space', 'mid.example', 'small.example']);
        assert.deepEqual(selectPopularServers({ error: 'down' }), ['oldbytes.space']);
    });

    it('keeps pinned servers at their position even if the directory lists them', () => {
        const directory = [
            { domain: 'oldbytes.space', last_week_users: 99999 },
            { domain: 'a.example', last_week_users: 50 },
            { domain: 'b.example', last_week_users: 40 },
        ];
        assert.deepEqual(selectPopularServers(directory), ['a.example', 'oldbytes.space', 'b.example']);
    });
});

describe('model search', () => {
    const models = [
        { id: 'google/gemini-3.1-flash-lite', name: 'Google: Gemini 3.1 Flash Lite' },
        { id: 'google/gemini-3.8-flash', name: 'Google: Gemini 3.8 Flash' },
        { id: 'anthropic/claude-haiku-5.5', name: 'Anthropic: Claude Haiku 5.5' },
    ];

    it('matches all words in any order, case-insensitively', () => {
        assert.deepEqual(filterModels(models, 'lite FLASH').map((m) => m.id), ['google/gemini-3.1-flash-lite']);
        assert.deepEqual(filterModels(models, 'flash').length, 2);
        assert.deepEqual(filterModels(models, 'Claude').map((m) => m.id), ['anthropic/claude-haiku-5.5']);
        assert.deepEqual(filterModels(models, 'gpt'), []);
    });

    it('returns everything for an empty query', () => {
        assert.equal(filterModels(models, '  ').length, 3);
    });
});
