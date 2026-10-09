// SPDX-License-Identifier: GPL-3.0-or-later
// Error with a machine-readable code (mapped to a UI text by the caller) and
// the original detail message from the provider or the network layer.
export class FediscribeError extends Error {
    constructor(code, detail = '', status = 0) {
        detail = typeof detail === 'string' ? detail : String(detail ?? '');
        super(detail ? `${code}: ${detail}` : code);
        this.name = 'FediscribeError';
        this.code = code;
        this.detail = detail;
        this.status = Number.isFinite(status) ? status : 0;
    }

    toJSON() {
        return { code: this.code, detail: this.detail, status: this.status };
    }
}
