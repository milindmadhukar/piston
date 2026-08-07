/**
 * Typed HTTP client for the piston API, replacing axios with native fetch.
 */

export class ApiError extends Error {
    status: number;

    constructor(status: number, message: string) {
        super(message);
        this.name = 'ApiError';
        this.status = status;
    }
}

export class PistonApi {
    readonly base_url: string;

    constructor(base_url: string) {
        this.base_url = base_url.replace(/\/+$/, '');
    }

    get ws_url(): string {
        return this.base_url.replace(/^http/, 'ws') + '/api/v2/connect';
    }

    async request<T>(method: string, path: string, body?: unknown): Promise<T> {
        const res = await fetch(this.base_url + path, {
            method,
            headers: { 'Content-Type': 'application/json' },
            ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        });

        const text = await res.text();
        let parsed: unknown = text;
        if (text.length > 0) {
            try {
                parsed = JSON.parse(text);
            } catch {
                /* leave as text */
            }
        }

        if (!res.ok) {
            const message =
                parsed &&
                typeof parsed === 'object' &&
                'message' in parsed &&
                typeof (parsed as { message: unknown }).message === 'string'
                    ? (parsed as { message: string }).message
                    : `HTTP ${res.status}`;
            throw new ApiError(res.status, message);
        }

        return parsed as T;
    }

    get<T>(path: string): Promise<T> {
        return this.request<T>('GET', path);
    }

    post<T>(path: string, body: unknown): Promise<T> {
        return this.request<T>('POST', path, body);
    }

    delete<T>(path: string, body: unknown): Promise<T> {
        return this.request<T>('DELETE', path, body);
    }
}
