// SPDX-License-Identifier: GPL-3.0-or-later
// Registry of all provider modules, keyed by provider ID.

import * as anthropic from './anthropic.js';
import * as gemini from './gemini.js';
import * as openai from './openai.js';
import * as openrouter from './openrouter.js';
import { FediscribeError } from './common.js';

const PROVIDERS = { openai, anthropic, gemini, openrouter };

export function getProvider(providerId) {
    const provider = PROVIDERS[providerId];
    if (!provider) {
        throw new FediscribeError('unknownProvider', String(providerId));
    }
    return provider;
}
