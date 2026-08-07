# Piston language packages

One manifest per language version: `packages/<language>/<version>.yaml`.

Most declare a prebuilt upstream archive and are installed directly by the engine — no
build, no publishing step. The rest carry a `build:` script that CI runs once, publishing
the result as an archive the engine then installs the same way.

See [CONTRIBUTING.MD](CONTRIBUTING.MD) for the format and the workflow.

```sh
./piston validate-pkgs     # parse and check every manifest
./piston list-pkgs         # every package
```
