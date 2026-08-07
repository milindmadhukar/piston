/**
 * A small YAML emitter for manifests.
 *
 * `Bun.YAML.stringify` writes flow style (`{a: 1, b: [2,3]}`) and escapes
 * newlines into `"\n"`, which makes a shell script unreadable and unmergeable.
 * Manifests are hand-edited, so they get block scalars and block mappings.
 * This only has to handle the manifest shape, not YAML in general.
 */

/** Scalars that must be quoted or YAML would read them back as another type. */
const AMBIGUOUS =
    /^(|~|null|Null|NULL|true|True|TRUE|false|False|FALSE|yes|Yes|YES|no|No|NO|on|On|ON|off|Off|OFF|[-+]?[0-9.]+([eE][-+]?[0-9]+)?)$/;

function needs_quotes(value: string): boolean {
    return (
        AMBIGUOUS.test(value) ||
        value !== value.trim() ||
        /^[-?:,[\]{}#&*!|>'"%@`]/.test(value) ||
        value.includes(': ') ||
        value.includes(' #') ||
        value.includes('\n')
    );
}

export function scalar(value: string): string {
    if (!needs_quotes(value)) return value;
    // Double quotes so escapes work; single quotes cannot express a newline.
    return JSON.stringify(value);
}

/**
 * A literal block scalar (`|`), which preserves the body byte for byte.
 *
 * `|-` strips the final newline, plain `|` keeps exactly one. Shell bodies
 * always end in a newline, so plain `|` round-trips them.
 */
function block(key: string, body: string, indent: string): string {
    const text = body.endsWith('\n') ? body : body + '\n';
    const lines = text.slice(0, -1).split('\n');

    // A body whose first line is indented needs an explicit indentation
    // indicator, or YAML cannot tell content indentation from the block's.
    const first = lines[0] ?? '';
    const indicator =
        first.startsWith(' ') || first.startsWith('\t') ? '4' : '';

    const inner = indent + '    ';
    return [
        `${indent}${key}: |${indicator}`,
        ...lines.map(line => (line.length ? inner + line : '')),
    ].join('\n');
}

export type YamlValue =
    | string
    | number
    | boolean
    | string[]
    | YamlValue[]
    | { [key: string]: YamlValue | undefined };

function is_record(value: YamlValue): value is { [key: string]: YamlValue } {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function emit_value(value: YamlValue, indent: string): string {
    if (typeof value === 'string') return scalar(value);
    if (typeof value === 'number' || typeof value === 'boolean') {
        return String(value);
    }
    if (Array.isArray(value)) {
        if (value.every(v => typeof v === 'string')) {
            return `[${value.map(v => scalar(v as string)).join(', ')}]`;
        }
        return (
            '\n' +
            value
                .map(entry => {
                    const body = emit_block(
                        entry as { [key: string]: YamlValue },
                        indent + '      '
                    );
                    return `${indent}    - ${body.slice(indent.length + 6)}`;
                })
                .join('\n')
        );
    }
    return '\n' + emit_block(value, indent + '    ');
}

function emit_block(
    obj: { [key: string]: YamlValue | undefined },
    indent: string
): string {
    const lines: string[] = [];

    for (const [key, value] of Object.entries(obj)) {
        if (value === undefined) continue;

        if (typeof value === 'string' && value.includes('\n')) {
            lines.push(block(key, value, indent));
            continue;
        }

        const rendered = emit_value(value, indent);
        lines.push(
            rendered.startsWith('\n')
                ? `${indent}${key}:${rendered}`
                : `${indent}${key}: ${rendered}`
        );
    }

    return lines.join('\n');
}

/** Renders a manifest-shaped object. Keys are emitted in insertion order. */
export function emit_yaml(obj: {
    [key: string]: YamlValue | undefined;
}): string {
    return emit_block(obj, '') + '\n';
}

export { is_record };
