#!/usr/bin/env bun
import path from 'node:path';
import { existsSync, mkdirSync } from 'node:fs';
import fs from 'node:fs/promises';

import config from './config.ts';
import globals from './globals.ts';
import { create } from './logger.ts';
import { error_message } from './errors.ts';
import { load_package } from './runtime.ts';
import { load_all_manifests } from './package.ts';
import { get_operation } from './operations.ts';
import {
    empty_response,
    json_response,
    handle_execute,
    handle_runtimes,
    handle_list_packages,
    handle_install_package,
    handle_uninstall_package,
    handle_start_operation,
    handle_list_operations,
    handle_get_operation,
    handle_operation_log,
    new_connection_data,
    new_operation_connection_data,
    websocket_handlers,
    type ConnectionData,
} from './api/v2.ts';

const logger = create('index');

const V2_PREFIX = '/api/v2';

const not_found = () => json_response(404, { message: 'Not Found' });

// ------------------------------------------------------------- bootstrap

logger.info('Setting loglevel to', config.log_level);
logger.debug('Ensuring data directories exist');

Object.values(globals.data_directories).forEach(dir => {
    const data_path = path.join(config.data_directory, dir);

    logger.debug(`Ensuring ${data_path} exists`);

    if (!existsSync(data_path)) {
        logger.info(`${data_path} does not exist.. Creating..`);

        try {
            mkdirSync(data_path);
        } catch (e) {
            logger.error(`Failed to create ${data_path}: `, error_message(e));
        }
    }
});

// Manifests are baked into the image and are the whitelist of what can be
// installed at all, so a broken one is fatal at boot rather than at request
// time.
logger.info('Loading package manifests');
try {
    const count = await load_all_manifests();
    logger.info(`Loaded ${count} package manifests`);
} catch (e) {
    logger.error('Failed to load package manifests:', error_message(e));
    process.exit(1);
}

logger.info('Loading packages');
const pkgdir = path.join(
    config.data_directory,
    globals.data_directories.packages
);

const pkglist = await fs.readdir(pkgdir);

const languages = await Promise.all(
    pkglist.map(lang =>
        fs
            .readdir(path.join(pkgdir, lang))
            .then(versions => versions.map(v => path.join(pkgdir, lang, v)))
    )
);

const installed_languages = languages
    .flat()
    .filter(pkg => existsSync(path.join(pkg, globals.pkg_installed_file)));

installed_languages.forEach(pkg => load_package(pkg));

// ------------------------------------------------------------- body gate

/** A decoded json request body. Every field is re-validated downstream. */
type JsonBody = Record<string, unknown>;

type BodyOutcome =
    { ok: true; body: JsonBody } | { ok: false; response: Response };

/**
 * Decodes the body of a request to /api/v2, applying the two rules v2 has
 * always applied, in this order:
 *
 *   1. when the content-type says json, parse it - a parse failure is a 400
 *      carrying the stack, and is reported even for paths that match no route
 *   2. any other content-type is a 415
 *
 * The order matters and is pinned by tests: malformed json is a 400, not a 415.
 */
async function read_json_body(req: Request): Promise<BodyOutcome> {
    const content_type = req.headers.get('content-type');
    const is_json = content_type?.startsWith('application/json') ?? false;

    if (is_json) {
        const text = await req.text();
        if (text.length === 0) return { ok: true, body: {} };

        let parsed: unknown;
        try {
            parsed = JSON.parse(text);
        } catch (e) {
            return {
                ok: false,
                response: json_response(400, {
                    stack: e instanceof Error ? e.stack : String(e),
                }),
            };
        }

        // A valid but non-object body (a scalar or an array) carries none of the
        // fields the validators look for, so it falls through to their normal
        // "language is required as a string" rejection.
        if (typeof parsed !== 'object' || parsed === null) {
            return { ok: true, body: {} };
        }
        return { ok: true, body: { ...parsed } };
    }

    return {
        ok: false,
        response: json_response(415, {
            message: 'requests must be of type application/json',
        }),
    };
}

/** Wraps a handler that needs a decoded json body. */
function with_json_body(
    handler: (body: JsonBody) => Response | Promise<Response>
): (req: Request) => Promise<Response> {
    return async req => {
        const outcome = await read_json_body(req);
        return outcome.ok ? handler(outcome.body) : outcome.response;
    };
}

// ---------------------------------------------------------------- serving

const [address, port] = config.bind_address.split(':');

const server = Bun.serve<ConnectionData>({
    hostname: address,
    port: Number(port),
    // Long-running jobs must not be cut off by the request timeout; the job's
    // own wall-time limit is what bounds them.
    idleTimeout: 0,

    routes: {
        // HEAD is declared explicitly: Bun does not fall back to GET for it.
        // It does strip the body itself, so the same handler serves both.
        '/': {
            GET: () =>
                json_response(200, {
                    message: `Piston v${globals.version}`,
                }),
            HEAD: () =>
                json_response(200, {
                    message: `Piston v${globals.version}`,
                }),
        },

        '/api/v2/runtimes': {
            GET: () => handle_runtimes(),
            HEAD: () => handle_runtimes(),
        },

        '/api/v2/execute': {
            POST: with_json_body(handle_execute),
        },

        '/api/v2/packages': {
            GET: () => handle_list_packages(),
            HEAD: () => handle_list_packages(),
            POST: with_json_body(handle_install_package),
            DELETE: with_json_body(handle_uninstall_package),
        },

        // Async install/uninstall. Additive: POST /api/v2/packages keeps its
        // synchronous behaviour untouched. Mounted at /api/v2/operations rather
        // than under /api/v2/packages so it cannot shadow that frozen route.
        '/api/v2/operations': {
            GET: () => handle_list_operations(),
            HEAD: () => handle_list_operations(),
            POST: with_json_body(handle_start_operation),
        },

        '/api/v2/operations/:id': {
            GET: (req: Bun.BunRequest<'/api/v2/operations/:id'>) =>
                handle_get_operation(req.params.id),
            HEAD: (req: Bun.BunRequest<'/api/v2/operations/:id'>) =>
                handle_get_operation(req.params.id),
        },

        '/api/v2/operations/:id/log': {
            GET: (req: Bun.BunRequest<'/api/v2/operations/:id/log'>) =>
                handle_operation_log(req.params.id),
            HEAD: (req: Bun.BunRequest<'/api/v2/operations/:id/log'>) =>
                handle_operation_log(req.params.id),
        },

        '/api/v2/operations/:id/connect': (
            req: Bun.BunRequest<'/api/v2/operations/:id/connect'>,
            server: Bun.Server<ConnectionData>
        ) => {
            const operation = get_operation(req.params.id);
            if (!operation) {
                return json_response(404, {
                    message: `Unknown operation ${req.params.id}`,
                });
            }
            const data: ConnectionData =
                new_operation_connection_data(operation);
            if (server.upgrade(req, { data })) {
                return new Response(null, { status: 101 });
            }
            return not_found();
        },

        '/api/v2/connect': (
            req: Request,
            server: Bun.Server<ConnectionData>
        ) => {
            const data: ConnectionData = new_connection_data();
            if (server.upgrade(req, { data })) {
                // Upgraded - Bun owns the socket from here.
                return new Response(null, { status: 101 });
            }
            // A plain request to the websocket path is a 404, as it always was.
            return not_found();
        },
    },

    /**
     * Reached only when no route matched, including a path that exists under a
     * different method. The content-type gate is mounted on the whole /api/v2
     * prefix, so it still applies here - an unmatched v2 path is a 415 before it
     * is a 404.
     */
    async fetch(req) {
        try {
            const url = new URL(req.url);
            if (
                url.pathname.startsWith(V2_PREFIX) &&
                req.method !== 'GET' &&
                req.method !== 'HEAD' &&
                req.method !== 'OPTIONS'
            ) {
                const outcome = await read_json_body(req);
                if (!outcome.ok) return outcome.response;
            }
            return not_found();
        } catch (e) {
            // Nothing may reach the top level and take the process down.
            logger.error('Unhandled error while serving request:', e);
            return empty_response(500);
        }
    },

    error(e) {
        // A throw inside a route handler lands here rather than in fetch.
        logger.error('Unhandled error while serving request:', e);
        return empty_response(500);
    },

    websocket: websocket_handlers,
});

logger.info('API server started on', config.bind_address);

process.on('SIGTERM', () => {
    server.stop();
    process.exit(0);
});
