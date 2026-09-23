# Dev container (build & test)

This repository ships a `Dockerfile` that builds an Ubuntu 26.04 container
with everything needed to compile, test, and package the Lemonade VS Code
extension. The container has **no hard-coded repo mount** — the convention is
to mount the current directory at `/work`, and the entrypoint expects the
repository to be there.

## 1. Build the image

From the repository root:

```sh
docker build -t lemonade-vscode-dev:latest .
```

## 2. Run it

The default command is `all`: install dependencies (if missing), build, run
the tests, and package a `.vsix` — then the container exits. Mount the
current directory at `/work` (override the source path if your checkout
lives somewhere else):

```sh
docker run --rm -v "$PWD":/work -w /work lemonade-vscode-dev:latest
```

> The `--rm` flag removes the container when the one-shot run finishes.

### Other targets

Pass a target as the first argument to run a single step:

```sh
docker run --rm -v "$PWD":/work -w /work lemonade-vscode-dev:latest <target>
```

| Target          | What it does                                                          |
| --------------- | --------------------------------------------------------------------- |
| `all` (default) | deps (if missing) → build → test → vsix, then exit                    |
| `deps`          | force-reinstall dependencies (`npm ci`)                               |
| `clean`         | remove `node_modules`, `out`, `.vscode-test`, `vscode.d.ts`, `*.vsix` |
| `build`         | compile the extension (`tsc`)                                         |
| `test`          | run the test suite under xvfb                                         |
| `vsix`          | compile and package a `.vsix`                                         |
| `run-container` | keep the container alive for interactive use (see below)              |

The entrypoint fails with a hint if no `package.json` is found in the mount.
Set the `WORK_DIR` environment variable to use a different in-container
path than `/work`.

### run-container (interactive)

`run-container` runs an infinite sleep, leaving the container available for
`docker exec`, e.g. to iterate on a single step or debug:

```sh
docker run -d --name lemonade-vscode-dev \
  -v "$PWD":/work -w /work \
  lemonade-vscode-dev:latest run-container

docker exec lemonade-vscode-dev sh -c "cd /work && npm ci"
docker exec lemonade-vscode-dev sh -c \
  "cd /work && pnpm run compile"
docker exec lemonade-vscode-dev sh -c \
  "cd /work && xvfb-run -a pnpm run test"
docker exec lemonade-vscode-dev sh -c \
  "cd /work && vsce package --allow-missing-repository --skip-license --no-dependencies"

docker rm -f lemonade-vscode-dev
```

> If a container from a previous session is still around, stop and remove it
> first: `docker rm -f lemonade-vscode-dev`.

## Notes

- Dependencies are installed with `npm ci` (the repo's `package-lock.json`);
  `pnpm` is only used to run the package scripts (`pnpm run compile`,
  `pnpm run test`). The first run's `postinstall` downloads the VS Code API
  type definitions via `dts dev`.
- The tests are `@vscode/test-electron` integration tests that launch a real
  VS Code instance, so they run under a virtual display (`xvfb-run`). The
  first test run downloads the VS Code runtime into `./.vscode-test/`
  (~330 MB); subsequent runs reuse it.
- The `all` target packages `lemonade-sdk-<version>.vsix` in the repo root.
  For per-commit artifacts, rename it to include the commit sha:

  ```sh
  mv lemonade-sdk-0.0.8.vsix \
     lemonade-sdk-0.0.8.$(git rev-parse --short=7 HEAD).vsix
  ```

- The VS Code test runtime needs a few shared libraries (GTK, NSS, X11, …).
  The Dockerfile installs them; if you upgrade the base image, keep that
  block in sync.
- `node_modules` and the VS Code test runtime live inside the mounted repo,
  so they are shared with the host checkout. Don't run host-side
  `npm install` with a different Node major version at the same time.
