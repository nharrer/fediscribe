// SPDX-License-Identifier: GPL-3.0-or-later
// Feeds every response parser with malformed responses. A parser must either
// return a well-formed result or throw a FediscribeError (which is shown to
// the user with its code), never a TypeError or similar.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import * as anthropic from '../providers/anthropic.js';
import { extractErrorMessage, FediscribeError } from '../providers/common.js';
import * as gemini from '../providers/gemini.js';
import * as openai from '../providers/openai.js';
import * as openrouter from '../providers/openrouter.js';

const PROVIDERS = { openai, anthropic, gemini, openrouter };

const SCALARS = [undefined, null, 0, 1, -1, NaN, true, false, '', 'text', '{}', [], [null], [1, 'a'], {}];

// Replaces each field of a valid response, one at a time and at every depth,
// with each scalar above.
function* mutations(value, path = []) {
    if (value === null || typeof value !== 'object') {
        return;
    }
    for (const key of Object.keys(value)) {
        for (const replacement of SCALARS) {
            yield { path: [...path, key], value: replaceAt(value, key, replacement) };
        }
        for (const nested of mutations(value[key], [...path, key])) {
            yield { path: nested.path, value: replaceAt(value, key, nested.value) };
        }
    }
}

function replaceAt(object, key, replacement) {
    const copy = Array.isArray(object) ? object.slice() : { ...object };
    copy[key] = replacement;
    return copy;
}

const VALID = {
    openai: {
        generate: {
            model: 'gpt-x',
            choices: [{ message: { role: 'assistant', content: 'A cat.', refusal: null }, finish_reason: 'stop' }],
            usage: { prompt_tokens: 10, completion_tokens: 5, completion_tokens_details: { reasoning_tokens: 2 } },
        },
        models: { data: [{ id: 'gpt-x', object: 'model' }] },
    },
    openrouter: {
        generate: {
            model: 'a/b', provider: 'Google',
            choices: [{ message: { content: [{ type: 'text', text: 'A cat.' }] }, finish_reason: 'stop' }],
            usage: { prompt_tokens: 10, completion_tokens: 5, cost: 0.001 },
        },
        models: { data: [{ id: 'a/b', name: 'B', architecture: { input_modalities: ['text', 'image'], modality: 'text+image->text' } }] },
    },
    anthropic: {
        generate: {
            model: 'claude-x', stop_reason: 'end_turn',
            content: [{ type: 'text', text: 'A cat.' }],
            usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 1 },
        },
        models: { data: [{ id: 'claude-x', display_name: 'Claude X' }] },
    },
    gemini: {
        generate: {
            modelVersion: 'gemini-x',
            candidates: [{ content: { parts: [{ text: 'A cat.' }, { text: 'Hidden', thought: true }] }, finishReason: 'STOP' }],
            usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5, thoughtsTokenCount: 3 },
        },
        models: { models: [{ name: 'models/gemini-x', displayName: 'Gemini X', supportedGenerationMethods: ['generateContent'] }] },
    },
};

function inputs(valid) {
    return [...SCALARS.map((value) => ({ path: ['(root)'], value })), ...mutations(valid)];
}

function assertSafe(fn, check, label) {
    let result;
    try {
        result = fn();
    } catch (error) {
        assert.ok(error instanceof FediscribeError, `${label}: threw ${error?.name}: ${error?.message}`);
        assert.equal(typeof error.code, 'string', label);
        assert.equal(typeof error.detail, 'string', `${label}: detail must be a string`);
        return;
    }
    check(result, label);
}

function checkText(text, label) {
    assert.equal(typeof text, 'string', label);
    assert.ok(text.trim().length > 0, `${label}: empty text must throw instead`);
}

function checkUsage(usage, label) {
    assert.deepEqual(Object.keys(usage).sort(), ['cost', 'inputTokens', 'model', 'outputTokens', 'reasoningTokens', 'upstream'], label);
    for (const key of ['inputTokens', 'outputTokens', 'reasoningTokens', 'cost']) {
        assert.ok(usage[key] === null || (Number.isFinite(usage[key]) && usage[key] >= 0), `${label}: ${key} = ${usage[key]}`);
    }
    for (const key of ['model', 'upstream']) {
        assert.ok(usage[key] === null || typeof usage[key] === 'string', `${label}: ${key}`);
    }
}

function checkModels(models, label) {
    assert.ok(Array.isArray(models), label);
    for (const model of models) {
        assert.equal(typeof model.id, 'string', label);
        assert.ok(model.id.length > 0, label);
        assert.equal(typeof model.name, 'string', label);
    }
}

describe('parsers survive malformed responses', () => {
    for (const [name, provider] of Object.entries(PROVIDERS)) {
        it(`${name}: generate response`, () => {
            for (const { path, value } of inputs(VALID[name].generate)) {
                const label = `${name} ${path.join('.')} = ${JSON.stringify(value)?.slice(0, 120)}`;
                assertSafe(() => provider.parseGenerateResponse(value), checkText, label);
                // Usage must never throw: it is optional information.
                checkUsage(provider.parseUsage(value), label);
            }
        });

        it(`${name}: model list`, () => {
            for (const { path, value } of inputs(VALID[name].models)) {
                const label = `${name} models ${path.join('.')}`;
                assertSafe(() => provider.parseModelsResponse(value), checkModels, label);
            }
        });

        it(`${name}: valid responses still work`, () => {
            checkText(provider.parseGenerateResponse(VALID[name].generate), name);
            assert.equal(provider.parseModelsResponse(VALID[name].models).length, 1);
        });
    }

    it('reports an error object sent with HTTP 200', () => {
        const body = { error: { message: 'Provider returned error', code: 502 } };
        for (const [name, provider] of Object.entries(PROVIDERS)) {
            assert.throws(() => provider.parseGenerateResponse(body),
                (error) => error.code === 'api' && error.detail.includes('Provider returned error'), name);
        }
        // OpenRouter: error inside a choice.
        assert.throws(() => openrouter.parseGenerateResponse({
            choices: [{ error: { message: 'Upstream timeout', code: 504 }, finish_reason: 'error', message: { content: '' } }],
        }), (error) => error.code === 'api' && error.detail.includes('Upstream timeout'));
    });

    it('extracts error messages from any body', () => {
        for (const body of SCALARS) {
            assert.equal(typeof extractErrorMessage(body), 'string');
        }
        assert.equal(extractErrorMessage({ error: { message: 42 } }), '');
        assert.ok(extractErrorMessage('x'.repeat(5000)).length <= 500);
        assert.ok(extractErrorMessage({ error: { message: 'y'.repeat(5000) } }).length <= 500);
        assert.equal(extractErrorMessage([{ error: { message: 'In array' } }]), 'In array');
    });
});
