// SPDX-License-Identifier: GPL-3.0-or-later
// Shared helpers for the provider modules: errors and HTTP requests.

import { FediscribeError } from '../shared/errors.js';

export { FediscribeError };

// ---------------------------------------------------------------------------
// Defensive accessors. Provider responses are external data: every field may
// be missing or have an unexpected type. Parsers use these helpers instead of
// trusting the structure, so malformed responses end in a FediscribeError
// with a clear message instead of a TypeError.

export function asArray(value) {
    return Array.isArray(value) ? value : [];
}

export function asObject(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

export function asString(value) {
    return typeof value === 'string' ? value : '';
}

// A count or amount: a finite, non-negative number (numeric strings are
// accepted), otherwise null.
export function asCount(value) {
    if (typeof value !== 'number' && !(typeof value === 'string' && value.trim() !== '')) {
        return null;
    }
    const number = Number(value);
    return Number.isFinite(number) && number >= 0 ? number : null;
}

const MAX_ERROR_LENGTH = 500;

function shorten(text) {
    return text.length > MAX_ERROR_LENGTH ? `${text.slice(0, MAX_ERROR_LENGTH - 1)}…` : text;
}

// Extracts a readable error message from a provider error body. The providers
// use { error: { message } }, { error: "..." }, { message } or (Gemini, in
// some cases) an array containing such an object. Always returns a string.
export function extractErrorMessage(body) {
    if (typeof body === 'string') {
        return shorten(body.trim());
    }
    if (Array.isArray(body)) {
        return body.length ? extractErrorMessage(body[0]) : '';
    }
    const object = asObject(body);
    const error = object.error;
    if (typeof error === 'string') {
        return shorten(error);
    }
    const message = asString(asObject(error).message) || asString(object.message);
    return shorten(message);
}

// Some APIs (notably OpenRouter) can answer with HTTP 200 and an error object
// instead of a result. Throws if `json` is such an error body.
export function throwIfErrorBody(json) {
    const error = asObject(json).error;
    if (error !== undefined && error !== null && error !== false) {
        const status = asCount(asObject(error).code) ?? 0;
        throw new FediscribeError('api', extractErrorMessage(json) || 'The provider returned an error without a message.', status);
    }
}

export function errorFromResponse(status, body) {
    const message = extractErrorMessage(body) || `HTTP ${status}`;
    if (status === 401 || status === 403) {
        return new FediscribeError('auth', message, status);
    }
    if (status === 429) {
        return new FediscribeError('rateLimit', message, status);
    }
    return new FediscribeError('api', message, status);
}

// Performs a request built by a provider module and returns the parsed JSON.
// `signal` is used for timeouts and cancellation.
export async function sendRequest({ url, method = 'GET', headers = {}, body }, { signal } = {}) {
    let response;
    try {
        response = await fetch(url, {
            method,
            headers,
            body: body === undefined ? undefined : JSON.stringify(body),
            credentials: 'omit',
            signal,
        });
    } catch (error) {
        if (error.name === 'AbortError' || error.name === 'TimeoutError') {
            throw new FediscribeError('timeout', String(signal?.reason?.message ?? error.message));
        }
        throw new FediscribeError('network', String(error?.message ?? error));
    }

    let text = '';
    try {
        text = await response.text();
    } catch (error) {
        throw new FediscribeError('network', `Reading the response failed: ${error?.message ?? error}`, response.status);
    }
    let json = null;
    try {
        json = text ? JSON.parse(text) : null;
    } catch {
        json = null;
    }
    if (!response.ok) {
        throw errorFromResponse(response.status, json ?? text);
    }
    if (json === null) {
        throw new FediscribeError('api', 'The response is not valid JSON.', response.status);
    }
    return json;
}

export function requireCredentials({ apiKey, model }, { needModel = true } = {}) {
    if (!asString(apiKey).trim()) {
        throw new FediscribeError('missingApiKey');
    }
    if (needModel && !asString(model).trim()) {
        throw new FediscribeError('missingModel');
    }
}

// Joins the text parts of a response; throws if nothing usable came back.
export function requireText(parts, reasonIfEmpty = '') {
    const text = asArray(parts).filter((part) => typeof part === 'string').join('').trim();
    if (!text) {
        throw new FediscribeError('emptyResponse', asString(reasonIfEmpty));
    }
    return text;
}

// Normalized usage information, shown in the info popup of the content
// script. Fields the provider does not report (or reports in an unexpected
// form) are null.
export function makeUsage({ model, inputTokens, outputTokens, reasoningTokens, cost, upstream } = {}) {
    return {
        model: asString(model) || null,
        inputTokens: asCount(inputTokens),
        outputTokens: asCount(outputTokens),
        reasoningTokens: asCount(reasoningTokens),
        cost: asCount(cost),
        upstream: asString(upstream) || null,
    };
}

// Usage is optional information; a parsing problem must never cost the user
// the generated text.
export function safeUsage(parseUsage, json) {
    try {
        return parseUsage(json);
    } catch (error) {
        console.warn('[Fediscribe] Reading the usage data failed:', error);
        return makeUsage();
    }
}

// Builds a model list entry; returns null for entries without a usable ID.
export function modelEntry(id, name) {
    const modelId = asString(id).trim();
    if (!modelId) {
        return null;
    }
    return { id: modelId, name: asString(name).trim() || modelId };
}

// Drops invalid entries and duplicates, sorts by ID.
export function sortModels(models) {
    const unique = new Map();
    for (const model of models) {
        if (model && !unique.has(model.id)) {
            unique.set(model.id, model);
        }
    }
    return [...unique.values()].sort((a, b) => a.id.localeCompare(b.id));
}
