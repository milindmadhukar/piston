import chalk from 'chalk';
import semver from 'semver';

import type { PistonApi } from '../api.ts';
import { ApiError } from '../api.ts';
import type { PackageEntry, PackageResult } from '../protocol.ts';

export const usage = `
piston ppman <subcommand>
  aliases: pkg

  list                        List all available packages
  install <packages...>       Install the named packages   (lang or lang=version)
  uninstall <packages...>     Uninstall the named packages
  spec <specfile>             Install the packages described in a spec file,
                              uninstalling packages which aren't in the list
`.trimEnd();

/** Splits `python=3.10` into its language and version. */
function split_package(pkg: string): { language: string; version: string } {
    const [language, language_version] = pkg.split('=');
    return {
        language: language ?? pkg,
        version: language_version || '*',
    };
}

function error_text(e: unknown): string {
    if (e instanceof ApiError) return e.message;
    if (e instanceof Error) return e.message;
    return String(e);
}

export async function list(api: PistonApi): Promise<void> {
    const packages = await api.get<PackageEntry[]>('/api/v2/packages');

    console.log(
        packages
            .map(
                p =>
                    `${chalk[p.installed ? 'green' : 'red']('•')} ${
                        p.language
                    } ${p.language_version}`
            )
            .join('\n')
    );
}

export async function install(
    api: PistonApi,
    packages: string[]
): Promise<void> {
    for (const spec of packages) {
        const request = split_package(spec);
        try {
            const result = await api.post<PackageResult>(
                '/api/v2/packages',
                request
            );
            console.log(
                `${chalk.green.bold('✓')} Installation succeeded: ${
                    result.language
                } ${result.version}`
            );
        } catch (e) {
            console.error(
                `${chalk.red.bold('❌')} Installation failed: ${error_text(e)}`
            );
        }
    }
}

export async function uninstall(
    api: PistonApi,
    packages: string[]
): Promise<void> {
    for (const spec of packages) {
        const request = split_package(spec);
        try {
            const result = await api.delete<PackageResult>(
                '/api/v2/packages',
                request
            );
            console.log(
                `${chalk.green.bold('✓')} Uninstallation succeeded: ${
                    result.language
                } ${result.version}`
            );
        } catch (e) {
            console.error(
                `${chalk.red.bold('❌')} Uninstallation failed: ${error_text(
                    e
                )}`
            );
        }
    }
}

interface SpecRule {
    raw: string;
    comment: boolean;
    package_selector: string;
    version_selector: string;
    negate: boolean;
}

function does_match(pkg: PackageEntry, rule: SpecRule): boolean {
    // Bun.Glob replaces minimatch
    const name_match = new Bun.Glob(rule.package_selector).match(pkg.language);
    const version_match = semver.satisfies(
        pkg.language_version,
        rule.version_selector
    );

    return name_match && version_match;
}

export async function spec(api: PistonApi, specfile: string): Promise<void> {
    const spec_contents = await Bun.file(specfile).text();
    const spec_lines = spec_contents.split('\n');

    const rules: SpecRule[] = [];

    for (const line of spec_lines) {
        const rule: SpecRule = {
            raw: line.trim(),
            comment: false,
            package_selector: '',
            version_selector: '',
            negate: false,
        };

        if (line.startsWith('#')) {
            rule.comment = true;
        } else {
            let l = line.trim();
            if (line.startsWith('!')) {
                rule.negate = true;
                l = line.slice(1).trim();
            }

            const [pkg, ver] = l.split(' ', 2);
            rule.package_selector = pkg ?? '';
            rule.version_selector = ver ?? '';
        }

        if (rule.raw.length != 0) rules.push(rule);
    }

    const packages = await api.get<PackageEntry[]>('/api/v2/packages');
    const installed = packages.filter(pkg => pkg.installed);

    let ensure_packages: PackageEntry[] = [];

    for (const rule of rules) {
        if (rule.comment) continue;

        if (!rule.negate) {
            const matches = packages.filter(pkg => does_match(pkg, rule));

            const latest_matches = matches.filter(pkg => {
                const versions = matches
                    .filter(x => x.language == pkg.language)
                    .map(x => x.language_version)
                    .sort(semver.rcompare);
                return versions[0] == pkg.language_version;
            });

            for (const match of latest_matches) {
                if (
                    !ensure_packages.find(
                        pkg =>
                            pkg.language == match.language &&
                            pkg.language_version == match.language_version
                    )
                )
                    ensure_packages.push(match);
            }
        } else {
            ensure_packages = ensure_packages.filter(
                pkg => !does_match(pkg, rule)
            );
        }
    }

    interface Operation {
        type: 'install' | 'uninstall';
        package: string;
        version: string;
    }

    const operations: Operation[] = [];

    for (const candidate of ensure_packages) {
        if (!candidate.installed)
            operations.push({
                type: 'install',
                package: candidate.language,
                version: candidate.language_version,
            });
    }

    for (const installed_package of installed) {
        if (
            !ensure_packages.find(
                pkg =>
                    pkg.language == installed_package.language &&
                    pkg.language_version == installed_package.language_version
            )
        )
            operations.push({
                type: 'uninstall',
                package: installed_package.language,
                version: installed_package.language_version,
            });
    }

    console.log(chalk.bold.yellow('Actions'));
    for (const op of operations) {
        console.log(
            (op.type == 'install'
                ? chalk.green('Install')
                : chalk.red('Uninstall')) + ` ${op.package} ${op.version}`
        );
    }

    if (operations.length == 0) {
        console.log(chalk.gray('None'));
    }

    for (const op of operations) {
        const path = '/api/v2/packages';
        const body = { language: op.package, version: op.version };
        try {
            if (op.type == 'install') {
                await api.post<PackageResult>(path, body);
                console.log(
                    chalk.bold.green('Installed'),
                    op.package,
                    op.version
                );
            } else {
                await api.delete<PackageResult>(path, body);
                console.log(
                    chalk.bold.green('Uninstalled'),
                    op.package,
                    op.version
                );
            }
        } catch (e) {
            const verb = op.type == 'install' ? 'install' : 'uninstall';
            console.log(
                chalk.bold.red(`Failed to ${verb}`) +
                    ` ${op.package} ${op.version}:`,
                error_text(e)
            );
        }
    }
}
