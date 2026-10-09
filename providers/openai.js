// SPDX-License-Identifier: GPL-3.0-or-later
// OpenAI: Chat Completions API. The request/response helpers are also used by
// OpenRouter, which offers an OpenAI-compatible API.

import {
    asArray, asObject, asString, FediscribeError, makeUsage, modelEntry, requireCredentials, requireText,
    safeUsage, sendRequest, sortModels, throwIfErrorBody,
} from './common.js';

export const id = 'openai';

const BASE_URL = 'https://api.openai.com/v1';

// The model list contains no capability information, so models that clearly
// cannot describe images (embeddings, speech, image generation, ...) are hidden.
const NON_CHAT_MODEL = /(embedding|tts|whisper|dall-e|davinci|babbage|moderation|transcribe|realtime|audio|search|image|sora|codex)/i;

export function buildChatBody({ model, prompt, image }) {
    return {
        model,
        messages: [
            { role: 'system', content: prompt.system },
            {
                role: 'user',
                content: [
                    { type: 'text', text: prompt.user },
                    { type: 'image_url', image_url: { url: `data:${image.mimeType};base64,${image.base64}` } },
                ],
            },
        ],
    };
}

export function parseChatResponse(json) {
    throwIfErrorBody(json);
    const choice = asObject(asArray(asObject(json).choices)[0]);
    if (!Object.keys(choice).length) {
        throw new FediscribeError('emptyResponse', 'The response contains no choices.');
    }
    // OpenRouter reports upstream errors inside the choice.
    if (choice.error) {
        throw new FediscribeError('api', asString(asObject(choice.error).message) || asString(choice.error)
            || 'The provider returned an error without a message.');
    }
    const message = asObject(choice.message);
    const finishReason = asString(choice.finish_reason);
    if (message.refusal) {
        throw new FediscribeError('blocked', asString(message.refusal) || 'refusal');
    }
    if (finishReason === 'content_filter') {
        throw new FediscribeError('blocked', 'finish_reason: content_filter');
    }
    const content = Array.isArray(message.content)
        ? message.content.map((part) => (typeof part === 'string' ? part : asObject(part).text))
        : [message.content];
    return requireText(content, finishReason ? `finish_reason: ${finishReason}` : '');
}

// Chat Completions usage; reasoning tokens are part of completion_tokens.
export function parseChatUsage(json) {
    const usage = asObject(asObject(json).usage);
    return makeUsage({
        model: asObject(json).model,
        inputTokens: usage.prompt_tokens,
        outputTokens: usage.completion_tokens,
        reasoningTokens: asObject(usage.completion_tokens_details).reasoning_tokens,
    });
}

export function buildGenerateRequest({ apiKey, model, prompt, image }) {
    return {
        url: `${BASE_URL}/chat/completions`,
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${apiKey.trim()}`,
            'Content-Type': 'application/json',
        },
        body: buildChatBody({ model: model.trim(), prompt, image }),
    };
}

export const parseGenerateResponse = parseChatResponse;
export const parseUsage = parseChatUsage;

export function buildModelsRequest({ apiKey }) {
    return {
        url: `${BASE_URL}/models`,
        headers: { 'Authorization': `Bearer ${apiKey.trim()}` },
    };
}

export function parseModelsResponse(json) {
    const models = asArray(asObject(json).data)
        .map((model) => modelEntry(asObject(model).id))
        .filter((model) => model && !NON_CHAT_MODEL.test(model.id));
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
