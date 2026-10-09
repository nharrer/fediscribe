// SPDX-License-Identifier: GPL-3.0-or-later
// Prompt for the image description. The prompt itself is sent to the AI
// provider and is not a UI text, so it is written here in English.

export const DEFAULT_MAX_CHARS = 1500;

// Returns the English name of a language code ("de" -> "German"), which is
// what the model gets told. Falls back to the code itself.
export function languageName(code) {
    try {
        const name = new Intl.DisplayNames(['en'], { type: 'language' }).of(code);
        if (name) {
            return name;
        }
    } catch {
        // Invalid code; fall through.
    }
    return code;
}

// Resolves the language setting. "auto" uses the language detected on the
// page (see content.js), falling back to English.
export function resolveLanguage(setting, detectedLanguage) {
    if (setting && setting !== 'auto') {
        return setting;
    }
    const code = String(detectedLanguage || '').trim();
    return code || 'en';
}

export function buildPrompt({ language = 'en', maxChars = DEFAULT_MAX_CHARS } = {}) {
    const name = languageName(language);
    const system = [
        'You write alt texts (image descriptions) for people who use screen readers.',
        'The alt text accompanies a post on Mastodon, a social network.',
        'Rules:',
        '- Describe the most important content first, then relevant details.',
        '- If the image contains readable text, include it (quoted, or summarized if it is long).',
        '- Usually 1 to 3 sentences. Use more only if the image contains a lot of essential text or information.',
        `- Never exceed ${maxChars} characters.`,
        '- Do not start with "Image of", "Picture of", "Photo of" or similar; mention the medium only if it matters (e.g. screenshot, drawing, chart).',
        '- Describe only what is visible. Do not speculate about intentions, identities or context that is not visible.',
        '- Output only the alt text itself, without quotes, headings, explanations or formatting.',
        `- Write in ${name}.`,
    ].join('\n');
    const user = `Write the alt text for this image in ${name}.`;
    return { system, user };
}

// Shortens a text to maxChars, preferably at the end of a sentence.
export function truncateText(text, maxChars = DEFAULT_MAX_CHARS) {
    const trimmed = String(text ?? '').trim();
    if (trimmed.length <= maxChars) {
        return trimmed;
    }
    const cut = trimmed.slice(0, maxChars);
    const sentenceEnd = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('! '), cut.lastIndexOf('? '));
    if (sentenceEnd >= maxChars / 2) {
        return cut.slice(0, sentenceEnd + 1);
    }
    const wordEnd = cut.lastIndexOf(' ');
    const base = wordEnd >= maxChars / 2 ? cut.slice(0, wordEnd) : cut.slice(0, maxChars - 1);
    return `${base.replace(/[\s,;:]+$/, '')}…`;
}

// Removes typical wrapping that models sometimes add despite the instructions.
export function cleanResponseText(text) {
    let result = String(text ?? '').trim();
    result = result.replace(/^(alt[- ]?text|description)\s*:\s*/i, '');
    if (/^["“„«].*["”“»]$/s.test(result)) {
        result = result.slice(1, -1).trim();
    }
    return result;
}
