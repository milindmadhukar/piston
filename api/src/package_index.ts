import { create } from './logger.ts';
import { error_message } from './errors.ts';

const logger = create('package_index');

const INDEX_FETCH_ATTEMPTS = 5;
const INDEX_RETRY_BASE_MS = 1000;

/**
 * Fetches the index of prebuilt archives, retrying while it looks temporarily
 * absent.
 *
 * The index is a release asset, and CI republishes it with
 * `gh release upload --clobber`, which deletes the old asset before uploading
 * the new one. For that window the URL answers 404 - `Not Found`, or
 * `The specified blob does not exist` once the asset is back but its content
 * is not - and every install of a source-built package failed outright,
 * blaming a package index that is fine again a second later. Back-to-back
 * package builds widen the window enough to hit by hand.
 *
 * Retried on anything that is not a clean answer: a genuinely misconfigured
 * repo_url fails identically either way and is only reported a little later.
 * Installs are already background operations, so seconds here cost nothing
 * against a build measured in minutes.
 *
 * Deliberately free of any config import, so it stays usable from the
 * standalone unit suite - see tests/unit.test.ts.
 */
export async function fetch_index(
    url: string,
    // Overridden only by the tests, which cannot afford the real backoff.
    attempts = INDEX_FETCH_ATTEMPTS,
    base_ms = INDEX_RETRY_BASE_MS
): Promise<string> {
    let last = '';

    for (let attempt = 1; attempt <= attempts; attempt++) {
        try {
            const response = await fetch(url);
            if (response.ok) return await response.text();
            last = `${response.status} ${response.statusText}`;
        } catch (error) {
            last = error_message(error);
        }

        if (attempt < attempts) {
            const wait = base_ms * 2 ** (attempt - 1);
            logger.warn(
                `package index unavailable (${last}), retrying in ${wait}ms`
            );
            await Bun.sleep(wait);
        }
    }

    throw new Error(`Failed to fetch the package index: ${last}`);
}
