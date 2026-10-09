// SPDX-License-Identifier: GPL-3.0-or-later

import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';

import * as anthropic from '../providers/anthropic.js';
import { errorFromResponse, extractErrorMessage, sendRequest } from '../providers/common.js';
import * as gemini from '../providers/gemini.js';
import { getProvider } from '../providers/index.js';
import * as openai from '../providers/openai.js';
import * as openrouter from '../providers/openrouter.js';

const prompt = { system: 'SYSTEM', user: 'USER' };
const image = { base64: 'QUJD', mimeType: 'image/png' };
const options = { apiKey: ' key-123 ', model: ' some-model ', prompt, image };

describe('OpenAI', () => {
    it('builds a chat completion request with the image as data URL', () => {
        const request = openai.buildGenerateRequest(options);
        assert.equal(request.url, 'https://api.openai.com/v1/chat/completions');
        assert.equal(request.method, 'POST');
        assert.equal(request.headers.Authorization, 'Bearer key-123');
        assert.equal(request.body.model, 'some-model');
        assert.deepEqual(request.body.messages[0], { role: 'system', content: 'SYSTEM' });
        const content = request.body.messages[1].content;
        assert.deepEqual(content[0], { type: 'text', text: 'USER' });
        assert.equal(content[1].image_url.url, 'data:image/png;base64,QUJD');
    });

    it('parses the text', () => {
        const text = openai.parseGenerateResponse({ choices: [{ message: { content: ' A cat. ' }, finish_reason: 'stop' }] });
        assert.equal(text, 'A cat.');
    });

    it('reports refusals and empty answers', () => {
        assert.throws(() => openai.parseGenerateResponse({ choices: [{ message: { refusal: 'No.' } }] }), { code: 'blocked' });
        assert.throws(() => openai.parseGenerateResponse({ choices: [{ message: { content: '' }, finish_reason: 'length' }] }),
            { code: 'emptyResponse', detail: 'finish_reason: length' });
        assert.throws(() => openai.parseGenerateResponse({}), { code: 'emptyResponse' });
    });

    it('lists chat models only', () => {
        const models = openai.parseModelsResponse({
            data: [{ id: 'gpt-x' }, { id: 'text-embedding-3-small' }, { id: 'whisper-1' }, { id: 'a-model' }, { id: 'gpt-image-1' }],
        });
        assert.deepEqual(models.map((model) => model.id), ['a-model', 'gpt-x']);
    });
});

describe('OpenRouter', () => {
    it('uses the OpenAI-compatible endpoint', () => {
        const request = openrouter.buildGenerateRequest(options);
        assert.equal(request.url, 'https://openrouter.ai/api/v1/chat/completions');
        assert.equal(request.headers.Authorization, 'Bearer key-123');
        assert.equal(request.body.messages[1].content[1].type, 'image_url');
    });

    it('lists only models with image input', () => {
        const models = openrouter.parseModelsResponse({
            data: [
                { id: 'b/vision', name: 'Vision', architecture: { input_modalities: ['text', 'image'] } },
                { id: 'a/text', name: 'Text', architecture: { input_modalities: ['text'] } },
                { id: 'c/old', architecture: { modality: 'text+image->text' } },
            ],
        });
        assert.deepEqual(models, [{ id: 'b/vision', name: 'Vision' }, { id: 'c/old', name: 'c/old' }]);
    });
});

describe('Anthropic', () => {
    it('builds a messages request', () => {
        const request = anthropic.buildGenerateRequest(options);
        assert.equal(request.url, 'https://api.anthropic.com/v1/messages');
        assert.equal(request.headers['x-api-key'], 'key-123');
        assert.equal(request.headers['anthropic-version'], '2023-06-01');
        assert.equal(request.headers['anthropic-dangerous-direct-browser-access'], 'true');
        assert.equal(request.body.system, 'SYSTEM');
        assert.ok(request.body.max_tokens > 0);
        assert.deepEqual(request.body.messages[0].content[0],
            { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'QUJD' } });
    });

    it('parses text blocks', () => {
        const text = anthropic.parseGenerateResponse({
            content: [{ type: 'text', text: 'A dog ' }, { type: 'text', text: 'running.' }],
            stop_reason: 'end_turn',
        });
        assert.equal(text, 'A dog running.');
        assert.throws(() => anthropic.parseGenerateResponse({ content: [], stop_reason: 'refusal' }), { code: 'blocked' });
    });

    it('lists models with display names', () => {
        const models = anthropic.parseModelsResponse({ data: [{ id: 'claude-b', display_name: 'Claude B' }, { id: 'claude-a' }] });
        assert.deepEqual(models, [{ id: 'claude-a', name: 'claude-a' }, { id: 'claude-b', name: 'Claude B' }]);
    });
});

describe('Gemini', () => {
    it('sends the key in the header, not in the URL', () => {
        const request = gemini.buildGenerateRequest({ ...options, apiKey: 'AQ.some-new-format', model: 'models/gemini-x' });
        assert.equal(request.url, 'https://generativelanguage.googleapis.com/v1beta/models/gemini-x:generateContent');
        assert.equal(request.headers['x-goog-api-key'], 'AQ.some-new-format');
        assert.ok(!request.url.includes('key='));
        assert.deepEqual(request.body.systemInstruction, { parts: [{ text: 'SYSTEM' }] });
        assert.deepEqual(request.body.contents[0].parts[0], { inlineData: { mimeType: 'image/png', data: 'QUJD' } });
    });

    it('parses text and skips thoughts', () => {
        const text = gemini.parseGenerateResponse({
            candidates: [{ content: { parts: [{ text: 'thinking', thought: true }, { text: 'A bird.' }] }, finishReason: 'STOP' }],
        });
        assert.equal(text, 'A bird.');
    });

    it('reports blocked content', () => {
        assert.throws(() => gemini.parseGenerateResponse({ promptFeedback: { blockReason: 'SAFETY' } }), { code: 'blocked' });
        assert.throws(() => gemini.parseGenerateResponse({ candidates: [{ finishReason: 'SAFETY' }] }), { code: 'blocked' });
        assert.throws(() => gemini.parseGenerateResponse({ candidates: [] }), { code: 'emptyResponse' });
    });

    it('lists generateContent models', () => {
        const models = gemini.parseModelsResponse({
            models: [
                { name: 'models/gemini-b', displayName: 'Gemini B', supportedGenerationMethods: ['generateContent'] },
                { name: 'models/text-embedding-004', supportedGenerationMethods: ['embedContent'] },
                { name: 'models/gemini-embedding-001', supportedGenerationMethods: ['generateContent'] },
                { name: 'models/gemini-a', supportedGenerationMethods: ['generateContent', 'countTokens'] },
            ],
        });
        assert.deepEqual(models, [{ id: 'gemini-a', name: 'gemini-a' }, { id: 'gemini-b', name: 'Gemini B' }]);
    });
});

describe('Errors', () => {
    it('extracts provider messages', () => {
        assert.equal(extractErrorMessage({ error: { message: 'Bad key' } }), 'Bad key');
        assert.equal(extractErrorMessage({ type: 'error', error: { type: 'x', message: 'Overloaded' } }), 'Overloaded');
        assert.equal(extractErrorMessage({ error: 'plain' }), 'plain');
        assert.equal(extractErrorMessage('<html>'), '<html>');
        assert.equal(extractErrorMessage(null), '');
    });

    it('maps HTTP status codes', () => {
        assert.equal(errorFromResponse(401, {}).code, 'auth');
        assert.equal(errorFromResponse(403, {}).code, 'auth');
        assert.equal(errorFromResponse(429, {}).code, 'rateLimit');
        const error = errorFromResponse(400, { error: { message: 'Invalid model' } });
        assert.equal(error.code, 'api');
        assert.equal(error.status, 400);
        assert.equal(error.detail, 'Invalid model');
    });

    it('requires an API key and a model, but does not validate the key format', async () => {
        await assert.rejects(openai.generate({ ...options, apiKey: '  ' }), { code: 'missingApiKey' });
        await assert.rejects(gemini.generate({ ...options, model: '' }), { code: 'missingModel' });
        await assert.rejects(anthropic.listModels({ apiKey: '' }), { code: 'missingApiKey' });
    });

    it('rejects unknown providers', () => {
        assert.throws(() => getProvider('nope'), { code: 'unknownProvider' });
        assert.equal(getProvider('gemini'), getProvider('gemini'));
    });
});

describe('sendRequest', () => {
    const originalFetch = globalThis.fetch;
    afterEach(() => {
        globalThis.fetch = originalFetch;
    });

    it('returns parsed JSON and sends the body as JSON', async () => {
        let seen;
        globalThis.fetch = async (url, init) => {
            seen = { url, init };
            return new Response('{"ok":1}', { status: 200 });
        };
        const json = await sendRequest({ url: 'https://x.test/a', method: 'POST', headers: { A: 'b' }, body: { q: 1 } });
        assert.deepEqual(json, { ok: 1 });
        assert.equal(seen.init.body, '{"q":1}');
        assert.equal(seen.init.credentials, 'omit');
    });

    it('turns HTTP errors into coded errors with the provider message', async () => {
        globalThis.fetch = async () => new Response('{"error":{"message":"API key not valid"}}', { status: 400 });
        await assert.rejects(sendRequest({ url: 'https://x.test' }), { code: 'api', status: 400, detail: 'API key not valid' });
    });

    it('reports network errors and timeouts', async () => {
        globalThis.fetch = async () => {
            throw new TypeError('NetworkError when attempting to fetch resource.');
        };
        await assert.rejects(sendRequest({ url: 'https://x.test' }), { code: 'network' });

        globalThis.fetch = (url, init) => new Promise((resolve, reject) => {
            init.signal.addEventListener('abort', () => reject(init.signal.reason));
        });
        // Same abort reason as AbortSignal.timeout(), whose timer Node does not
        // keep alive.
        const controller = new AbortController();
        setTimeout(() => controller.abort(new DOMException('The operation timed out.', 'TimeoutError')), 10);
        await assert.rejects(sendRequest({ url: 'https://x.test' }, { signal: controller.signal }), { code: 'timeout' });
    });
});

describe('usage', () => {
    it('reads OpenAI usage including reasoning tokens', () => {
        assert.deepEqual(openai.parseUsage({
            model: 'gpt-x',
            usage: { prompt_tokens: 1200, completion_tokens: 300, completion_tokens_details: { reasoning_tokens: 250 } },
        }), { model: 'gpt-x', inputTokens: 1200, outputTokens: 300, reasoningTokens: 250, cost: null, upstream: null });
    });

    it('reads OpenRouter cost and upstream provider', () => {
        const usage = openrouter.parseUsage({
            model: 'google/gemini-x', provider: 'Google',
            usage: { prompt_tokens: 900, completion_tokens: 60, cost: 0.00042 },
        });
        assert.equal(usage.cost, 0.00042);
        assert.equal(usage.upstream, 'Google');
        assert.equal(usage.inputTokens, 900);
        assert.equal(usage.reasoningTokens, null);
    });

    it('adds cached input tokens for Anthropic', () => {
        const usage = anthropic.parseUsage({ model: 'claude-x', usage: { input_tokens: 10, cache_read_input_tokens: 1500, output_tokens: 80 } });
        assert.equal(usage.inputTokens, 1510);
        assert.equal(usage.outputTokens, 80);
    });

    it('counts Gemini thinking tokens as output', () => {
        const usage = gemini.parseUsage({
            modelVersion: 'gemini-x-001',
            usageMetadata: { promptTokenCount: 300, candidatesTokenCount: 50, thoughtsTokenCount: 400 },
        });
        assert.deepEqual(usage, { model: 'gemini-x-001', inputTokens: 300, outputTokens: 450, reasoningTokens: 400, cost: null, upstream: null });
    });

    it('returns nulls when usage is missing', () => {
        assert.deepEqual(gemini.parseUsage({}), { model: null, inputTokens: null, outputTokens: null, reasoningTokens: null, cost: null, upstream: null });
        assert.equal(anthropic.parseUsage({}).inputTokens, null);
    });

    it('returns text and usage from generate()', async () => {
        const originalFetch = globalThis.fetch;
        globalThis.fetch = async () => new Response(JSON.stringify({
            choices: [{ message: { content: 'A dog.' }, finish_reason: 'stop' }],
            usage: { prompt_tokens: 5, completion_tokens: 3, cost: 0.1 },
        }), { status: 200 });
        try {
            const result = await openrouter.generate({
                apiKey: 'k', model: 'm', prompt: { system: 's', user: 'u' }, image: { mimeType: 'image/png', base64: 'AA==' },
            });
            assert.equal(result.text, 'A dog.');
            assert.equal(result.usage.cost, 0.1);
        } finally {
            globalThis.fetch = originalFetch;
        }
    });
});

