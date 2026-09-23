# Dev/test container for the Lemonade VS Code extension.
#
# Ubuntu 26.04 base with Node.js, pnpm, @vscode/vsce, and the shared
# libraries required to run the `@vscode/test-electron` suite headlessly
# (VS Code downloads its own runtime into ./.vscode-test on first test run).
#
# Build:
#   docker build -t lemonade-vscode-dev:latest .
#
# Run (the current directory is the default repo mount at /work; override the
# source path if your checkout lives somewhere else):
#   docker run --rm -v "$PWD":/work -w /work lemonade-vscode-dev:latest
#
# The default CMD is `all` (install deps, build, test, package a .vsix, then
# exit). The entrypoint also accepts `deps`, `clean`, `build`, `test`, `vsix`,
# and `run-container`. See docs/dev-container.md for full usage.

FROM ubuntu:26.04

ENV DEBIAN_FRONTEND=noninteractive

# Base tooling + shared libraries needed by the VS Code (Electron) test runner.
RUN apt-get update && apt-get install -y --no-install-recommends \
        ca-certificates \
        curl \
        git \
        gnupg \
        procps \
        xvfb \
        libasound2t64 \
        libatk-bridge2.0-0 \
        libatk1.0-0t64 \
        libcairo2 \
        libdbus-1-3 \
        libgbm1 \
        libglib2.0-0t64 \
        libgtk-3-0t64 \
        libnss3 \
        libsecret-1-0 \
        libx11-6 \
        libx11-xcb1 \
        libxcb1 \
        libxcomposite1 \
        libxcursor1 \
        libxdamage1 \
        libxext6 \
        libxfixes3 \
        libxi6 \
        libxrandr2 \
        libxrender1 \
        libxss1 \
        libxtst6 \
        nodejs \
        npm \
    && rm -rf /var/lib/apt/lists/*

# pnpm (used to run the package scripts) + @vscode/vsce (extension
# packager). Dependencies are installed with npm ci (package-lock.json)
# by the entrypoint.
RUN npm install -g pnpm @vscode/vsce

# Default working directory; the repo is bind-mounted over it at run time.
WORKDIR /work

# The repository is mounted at runtime (default: the current directory at
# /work). Dependencies are installed by the entrypoint on first run — see
# docs/dev-container.md.

# Self-contained entrypoint: takes a target argument and runs the matching
# step. `all` (the default) runs deps -> build -> test -> vsix and exits.
# `run-container` keeps the container alive for interactive use.
RUN cat > /entrypoint.sh <<'ENTRYPOINT'
#!/bin/sh
set -eu
cd "${WORK_DIR:-/work}"
if [ ! -f package.json ]; then
    echo "error: no package.json in $PWD" >&2
    echo 'mount the repo: docker run --rm -v "$PWD":/work -w /work lemonade-vscode-dev:latest' >&2
    exit 1
fi

case "${1:-all}" in
    all)
        [ -f node_modules/.package-lock.json ] || { echo "installing dependencies (npm ci)"; npm ci; }
        pnpm run compile
        xvfb-run -a pnpm run test
        pnpm run compile
        vsce package --allow-missing-repository --skip-license --no-dependencies
        ;;
    deps)  # force a reinstall
        npm ci
        ;;
    clean)
        rm -rf node_modules out .vscode-test vscode.d.ts *.vsix
        echo "cleaned node_modules, out, .vscode-test, vscode.d.ts, *.vsix"
        ;;
    build)
        pnpm run compile
        ;;
    test)
        xvfb-run -a pnpm run test
        ;;
    vsix)
        pnpm run compile
        vsce package --allow-missing-repository --skip-license --no-dependencies
        ;;
    run-container)
        exec sleep infinity
        ;;
    *)
        echo "usage: docker run ... lemonade-vscode-dev:latest <all | deps | clean | build | test | vsix | run-container>" >&2
        exit 1
        ;;
esac
ENTRYPOINT
RUN chmod +x /entrypoint.sh

ENTRYPOINT ["/entrypoint.sh"]
CMD ["all"]
