// SPDX-License-Identifier: GPL-3.0-or-later
// Anthropic: Messages API.

import {
    asArray, asCount, asObject, asString, FediscribeError, makeUsage, modelEntry, requireCredentials, requireText,
    safeUsage, sendRequest, sortModels, throwIfErrorBody,
} from './common.js';

export const id = 'anthropic';

const BASE_URL = 'https://api.anthropic.com/v1';
const API_VERSION = '2023-06-01';
const MAX_TOKENS = 1024;

function headers(apiKey) {
    return {
        'x-api-key': apiKey.trim(),
        'anthropic-version': API_VERSION,
        // Required for requests from a browser context (the extension).
        'anthropic-dangerous-direct-browser-access': 'true',
    };
}

export function buildGenerateRequest({ apiKey, model, prompt, image }) {
    return {
        url: `${BASE_URL}/messages`,
        method: 'POST',
        headers: { ...headers(apiKey), 'Content-Type': 'application/json' },
        body: {
            model: model.trim(),
            max_tokens: MAX_TOKENS,
            system: prompt.system,
            messages: [
                {
                    role: 'user',
                    content: [
                        { type: 'image', source: { type: 'base64', media_type: image.mimeType, data: image.base64 } },
                        { type: 'text', text: prompt.user },
                    ],
                },
            ],
        },
    };
}

export function parseGenerateResponse(json) {
    throwIfErrorBody(json);
    const stopReason = asString(asObject(json).stop_reason);
    if (stopReason === 'refusal') {
        throw new FediscribeError('blocked', 'stop_reason: refusal');
    }
    const parts = asArray(asObject(json).content)
        .map(asObject)
        .filter((block) => block.type === 'text')
        .map((block) => block.text);
    return requireText(parts, stopReason ? `stop_reason: ${stopReason}` : '');
}

// Cached input tokens are reported separately and added to the input.
export function parseUsage(json) {
    const usage = asObject(asObject(json).usage);
    const parts = ['input_tokens', 'cache_creation_input_tokens', 'cache_read_input_tokens'].map((key) => asCount(usage[key]));
    return makeUsage({
        model: asObject(json).model,
        inputTokens: parts[0] === null ? null : parts.reduce((sum, value) => sum + (value ?? 0), 0),
        outputTokens: usage.output_tokens,
    });
}

export function buildModelsRequest({ apiKey }) {
    return {
        url: `${BASE_URL}/models?limit=1000`,
        headers: headers(apiKey),
    };
}

// All current Claude models accept images, so no filtering is needed.
export function parseModelsResponse(json) {
    const models = asArray(asObject(json).data)
        .map(asObject)
        .map((model) => modelEntry(model.id, model.display_name));
    return sortModels(models);
}

export async function generate(options, requestOptions) {
    requireCredentials(options);
    const json = await sendRequest(buildGenerateRequest(options), requestOptions);
    return { text: parseGenerateResponse(json), usage: safeUsage(parseUsage, json) };
}

export async function listModels(options, requestOptions) {
    requireCredentials(options, { needModel: false });
    const json = await sendRequest(buildModelsRequest(options), requestOptions);
    return parseModelsResponse(json);
}
