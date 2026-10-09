// SPDX-License-Identifier: GPL-3.0-or-later
// Search-as-you-type matching for the model list.

// Every whitespace-separated word of the query must occur somewhere in the
// model ID or name, in any order: "flash lite" matches
// "google/gemini-3.1-flash-lite". Case-insensitive.
export function filterModels(models, query) {
    const words = String(query ?? '').toLowerCase().split(/\s+/).filter(Boolean);
    if (!words.length) {
        return models.slice();
    }
    return models.filter((model) => {
        const haystack = `${model.id} ${model.name ?? ''}`.toLowerCase();
        return words.every((word) => haystack.includes(word));
    });
}
