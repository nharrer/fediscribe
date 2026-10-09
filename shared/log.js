// SPDX-License-Identifier: GPL-3.0-or-later
// Console logging with a common prefix. Info, warnings and errors are always
// logged; debug messages only when debug logging is enabled in the settings.

const PREFIX = '[Fediscribe]';

let debugEnabled = false;

export function setDebug(enabled) {
    debugEnabled = Boolean(enabled);
}

export function createLogger(context) {
    const prefix = context ? `${PREFIX} [${context}]` : PREFIX;
    return {
        debug(...args) {
            if (debugEnabled) {
                console.debug(prefix, ...args);
            }
        },
        info(...args) {
            console.info(prefix, ...args);
        },
        warn(...args) {
            console.warn(prefix, ...args);
        },
        error(...args) {
            console.error(prefix, ...args);
        },
    };
}
