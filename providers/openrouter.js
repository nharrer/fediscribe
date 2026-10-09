// SPDX-License-Identifier: GPL-3.0-or-later
// OpenRouter: OpenAI-compatible Chat Completions API.

import {
    asArray, asObject, asString, makeUsage, modelEntry, requireCredentials, safeUsage, sendRequest, sortModels,
} from './common.js';
import { buildChatBody, parseChatResponse, parseChatUsage } from './openai.js';

export const id = 'openrouter';

const BASE_URL = 'https://openrouter.ai/api/v1';

// Optional attribution headers recognized by OpenRouter.
const APP_HEADERS = {
    'X-Title': 'Fediscribe',
};

export function buildGenerateRequest({ apiKey, model, prompt, image }) {
    return {
        url: `${BASE_URL}/chat/completions`,
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${apiKey.trim()}`,
            'Content-Type': 'application/json',
            ...APP_HEADERS,
        },
        body: buildChatBody({ model: model.trim(), prompt, image }),
    };
}

export const parseGenerateResponse = parseChatResponse;

// OpenRouter always includes the cost in USD and names the upstream provider
// that served the request.
export function parseUsage(json) {
    return makeUsage({
        ...parseChatUsage(json),
        cost: asObject(asObject(json).usage).cost,
        upstream: asObject(json).provider,
    });
}

export function buildModelsRequest({ apiKey }) {
    return {
        url: `${BASE_URL}/models`,
        headers: { 'Authorization': `Bearer ${apiKey.trim()}` },
    };
}

// Only models that accept image input are listed.
export function parseModelsResponse(json) {
    const models = asArray(asObject(json).data)
        .map(asObject)
        .filter((model) => {
            const architecture = asObject(model.architecture);
            if (Array.isArray(architecture.input_modalities)) {
                return architecture.input_modalities.includes('image');
            }
            // Older format: "text+image->text"
            return asString(architecture.modality).split('->')[0].includes('image');
        })
        .map((model) => modelEntry(model.id, model.name));
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
