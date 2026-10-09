// SPDX-License-Identifier: GPL-3.0-or-later
// Google Gemini: generateContent API. The key is sent in the x-goog-api-key
// header (not as ?key= parameter), which works for all key formats.

import {
    asArray, asCount, asObject, asString, FediscribeError, makeUsage, modelEntry, requireCredentials, requireText,
    safeUsage, sendRequest, sortModels, throwIfErrorBody,
} from './common.js';

export const id = 'gemini';

const BASE_URL = 'https://generativelanguage.googleapis.com/v1beta';

// The API expects "gemini-…"; accept "models/gemini-…" as well.
export function normalizeModelId(model) {
    return asString(model).trim().replace(/^models\//, '');
}

export function buildGenerateRequest({ apiKey, model, prompt, image }) {
    return {
        url: `${BASE_URL}/models/${encodeURIComponent(normalizeModelId(model))}:generateContent`,
        method: 'POST',
        headers: {
            'x-goog-api-key': apiKey.trim(),
            'Content-Type': 'application/json',
        },
        body: {
            systemInstruction: { parts: [{ text: prompt.system }] },
            contents: [
                {
                    role: 'user',
                    parts: [
                        { inlineData: { mimeType: image.mimeType, data: image.base64 } },
                        { text: prompt.user },
                    ],
                },
            ],
        },
    };
}

const BLOCKING_FINISH_REASONS = new Set([
    'SAFETY', 'RECITATION', 'BLOCKLIST', 'PROHIBITED_CONTENT', 'SPII', 'IMAGE_SAFETY',
]);

export function parseGenerateResponse(json) {
    throwIfErrorBody(json);
    const blockReason = asString(asObject(asObject(json).promptFeedback).blockReason);
    if (blockReason) {
        throw new FediscribeError('blocked', `blockReason: ${blockReason}`);
    }
    const candidate = asObject(asArray(asObject(json).candidates)[0]);
    if (!Object.keys(candidate).length) {
        throw new FediscribeError('emptyResponse', 'The response contains no candidates.');
    }
    const finishReason = asString(candidate.finishReason);
    if (BLOCKING_FINISH_REASONS.has(finishReason)) {
        throw new FediscribeError('blocked', `finishReason: ${finishReason}`);
    }
    // Skip "thought" parts of thinking models.
    const parts = asArray(asObject(candidate.content).parts)
        .map(asObject)
        .filter((part) => !part.thought)
        .map((part) => part.text);
    return requireText(parts, finishReason ? `finishReason: ${finishReason}` : '');
}

// Thinking tokens (thoughtsTokenCount) are billed as output, but reported
// separately from candidatesTokenCount; they are added to the output here.
export function parseUsage(json) {
    const usage = asObject(asObject(json).usageMetadata);
    const candidates = asCount(usage.candidatesTokenCount);
    const thoughts = asCount(usage.thoughtsTokenCount);
    return makeUsage({
        model: asObject(json).modelVersion,
        inputTokens: usage.promptTokenCount,
        outputTokens: candidates === null ? null : candidates + (thoughts ?? 0),
        reasoningTokens: thoughts,
    });
}

export function buildModelsRequest({ apiKey }) {
    return {
        url: `${BASE_URL}/models?pageSize=1000`,
        headers: { 'x-goog-api-key': apiKey.trim() },
    };
}

// The list has no image capability flag; models that support generateContent
// are listed, minus obvious non-vision variants (embeddings, speech, ...).
const NON_VISION_MODEL = /(embedding|aqa|tts|imagen|veo|-image-generation)/i;

export function parseModelsResponse(json) {
    const models = asArray(asObject(json).models)
        .map(asObject)
        .filter((model) => asArray(model.supportedGenerationMethods).includes('generateContent'))
        .map((model) => modelEntry(normalizeModelId(model.name), model.displayName))
        .filter((model) => model && !NON_VISION_MODEL.test(model.id));
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
