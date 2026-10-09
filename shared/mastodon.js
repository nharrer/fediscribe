// SPDX-License-Identifier: GPL-3.0-or-later
// Checking a Mastodon server and detecting its media server.

import { FediscribeError } from './errors.js';
import { createLogger } from './log.js';
import { normalizeDomain } from './settings.js';

const log = createLogger('mastodon');

const REQUEST_TIMEOUT_MS = 15_000;

// True if the instance info looks like Mastodon (or a compatible fork) with
// the web interface that Fediscribe works with.
export function isMastodonInstance(json) {
    return Boolean(json && typeof json === 'object' && typeof json.version === 'string'
        && (json.domain || json.uri) && json.configuration);
}

function hostOf(url) {
    try {
        const parsed = new URL(url);
        return parsed.protocol === 'https:' ? parsed.hostname.toLowerCase() : null;
    } catch {
        return null;
    }
}

// Collects the hosts that serve media for this server, from the instance
// thumbnail and the attachments of public posts. The server itself is not
// included.
export function extractMediaHosts(domain, instance, statuses) {
    const urls = [];
    if (instance?.thumbnail?.url) {
        urls.push(instance.thumbnail.url);
    }
    for (const status of Array.isArray(statuses) ? statuses : []) {
        for (const attachment of status?.media_attachments ?? []) {
            urls.push(attachment.url, attachment.preview_url);
        }
    }
    const hosts = new Set();
    for (const url of urls) {
        const host = url ? hostOf(url) : null;
        if (host && host !== domain) {
            hosts.add(host);
        }
    }
    return [...hosts].sort();
}

// Server directory of joinmastodon.org (sends CORS headers, so no host
// permission is needed).
const SERVER_DIRECTORY_URL = 'https://api.joinmastodon.org/servers';
export const POPULAR_SERVER_COUNT = 100;

// Servers shown at a fixed position in the list, whether or not they are in
// the directory. Position is the zero-based index.
const PINNED_SERVERS = [
    { domain: 'oldbytes.space', position: 1 },
];

// Picks the servers with the most active users from the directory response
// and inserts the pinned servers.
export function selectPopularServers(directory, limit = POPULAR_SERVER_COUNT) {
    const servers = (Array.isArray(directory) ? directory : [])
        .filter((server) => typeof server?.domain === 'string')
        .map((server) => ({ domain: normalizeDomain(server.domain), activeUsers: Number(server.last_week_users) || 0 }))
        .filter((server) => server.domain)
        .sort((a, b) => b.activeUsers - a.activeUsers || a.domain.localeCompare(b.domain));
    const pinned = new Set(PINNED_SERVERS.map((server) => server.domain));
    const domains = [...new Set(servers.map((server) => server.domain))].filter((domain) => !pinned.has(domain));
    for (const { domain, position } of PINNED_SERVERS) {
        domains.splice(Math.min(position, domains.length), 0, domain);
    }
    return domains.slice(0, limit);
}

export async function fetchPopularServers(limit = POPULAR_SERVER_COUNT) {
    return selectPopularServers(await getJson(SERVER_DIRECTORY_URL), limit);
}

const DIRECTORY_CACHE_KEY = 'serverDirectoryCache';
const DIRECTORY_CACHE_MAX_AGE_MS = 24 * 60 * 60 * 1000;

// Like fetchPopularServers(), but cached in browser.storage.local for a day,
// so the list is available immediately and the directory is not queried every
// time the settings page opens. An outdated cache is still used if the
// directory cannot be reached.
export async function loadPopularServers() {
    const { [DIRECTORY_CACHE_KEY]: cache } = await browser.storage.local.get(DIRECTORY_CACHE_KEY);
    const cached = Array.isArray(cache?.domains) ? cache.domains : null;
    if (cached && Date.now() - Number(cache.fetchedAt) < DIRECTORY_CACHE_MAX_AGE_MS) {
        return cached;
    }
    try {
        const domains = await fetchPopularServers();
        await browser.storage.local.set({ [DIRECTORY_CACHE_KEY]: { fetchedAt: Date.now(), domains } });
        return domains;
    } catch (error) {
        if (cached) {
            log.warn('Server directory not reachable; using the cached list:', error.message);
            return cached;
        }
        throw error;
    }
}

// Parses a user-entered list of hosts (separated by spaces, commas or new
// lines). Returns { hosts, invalid }.
export function parseHostList(text) {
    const hosts = [];
    const invalid = [];
    for (const item of String(text ?? '').split(/[\s,;]+/).filter(Boolean)) {
        const host = normalizeDomain(item);
        if (host) {
            if (!hosts.includes(host)) {
                hosts.push(host);
            }
        } else {
            invalid.push(item);
        }
    }
    return { hosts, invalid };
}

async function getJson(url) {
    let response;
    try {
        response = await fetch(url, {
            credentials: 'omit',
            headers: { Accept: 'application/json' },
            signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        });
    } catch (error) {
        throw new FediscribeError('network', `${url}: ${error.message}`);
    }
    if (!response.ok) {
        throw new FediscribeError('api', url, response.status);
    }
    try {
        return await response.json();
    } catch {
        throw new FediscribeError('notMastodon', url);
    }
}

// Checks that `domain` is a Mastodon server and detects its media hosts.
// Mastodon's API sends CORS headers, so no host permission is needed yet.
export async function inspectServer(domain) {
    let instance;
    try {
        instance = await getJson(`https://${domain}/api/v2/instance`);
    } catch (error) {
        if (error.code === 'network') {
            throw error;
        }
        throw new FediscribeError('notMastodon', error.detail || error.message, error.status);
    }
    if (!isMastodonInstance(instance)) {
        throw new FediscribeError('notMastodon', domain);
    }

    // The public timeline can be disabled for anonymous visitors; then only
    // the instance thumbnail is available for detection.
    let statuses = [];
    try {
        statuses = await getJson(`https://${domain}/api/v1/timelines/public?local=true&only_media=true&limit=20`);
    } catch (error) {
        log.info('Public timeline not available:', error.message);
    }
    return {
        domain,
        title: String(instance.title ?? domain),
        version: instance.version,
        mediaHosts: extractMediaHosts(domain, instance, statuses),
    };
}
