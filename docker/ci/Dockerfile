# syntax=docker/dockerfile:1.10
# ghcr.io/breakpatch/ci: breakpatch-ci with its Chromium and Chromium's system libraries, for CI
# jobs that run in a container (GitLab CI, GitHub Actions `container:`, Jenkins, Buildkite).
# linux/amd64 and linux/arm64; release.yml builds it on a tag, on a machine of each kind (no
# emulation), from the release's own files.
#
#   docker build -f docker/ci/Dockerfile --build-arg BREAKPATCH_VERSION=1.2.3 -t breakpatch-ci .
#
# Built from the repository's root: only site/install-ci is sent (Dockerfile.dockerignore). It is
# installed the way a customer installs it: site/install-ci downloads the release's wheels and
# requirements file, checks each against the release's SHA256SUMS, installs them with
# pip --require-hashes --only-binary=:all:, fetches the pinned, checksum-checked Python 3.11 (the
# base has none) and Chromium. Playwright's install-deps then adds Chromium's libraries, and
# breakpatch-ci setup checks nothing is missing, or the build fails.
#
# Build arguments:
#   BREAKPATCH_VERSION  the release to install (1.2.3 or 0.1.0-beta.1). Required.
#   BASE                the base image; a release passes it pinned by digest (ubuntu:24.04@sha256:…)
# Build secret (while BreakPatch/breakpatch is private): github_token, a token that can read its
# releases, read by install-ci as BREAKPATCH_GITHUB_TOKEN. It's never in a layer.
ARG BASE=ubuntu:24.04
FROM ${BASE}

ARG BREAKPATCH_VERSION
ENV DEBIAN_FRONTEND=noninteractive \
    BREAKPATCH_CI_HOME=/opt/breakpatch-ci \
    BREAKPATCH_CI_BIN=/usr/local/bin \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    PIP_NO_CACHE_DIR=1

RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl \
 && rm -rf /var/lib/apt/lists/*

COPY site/install-ci /usr/local/share/breakpatch/install-ci

# One layer: breakpatch-ci, Chromium, its libraries, and the check that it can start.
RUN --mount=type=secret,id=github_token,env=BREAKPATCH_GITHUB_TOKEN \
    test -n "${BREAKPATCH_VERSION}" || { echo "Set --build-arg BREAKPATCH_VERSION=…" >&2; exit 1; }; \
    sh /usr/local/share/breakpatch/install-ci \
 && apt-get update \
 && /opt/breakpatch-ci/current/bin/python -m playwright install-deps chromium \
 && rm -rf /var/lib/apt/lists/* /root/.cache \
 && breakpatch-ci setup >/dev/null \
 && test "$(breakpatch-ci --version)" = "${BREAKPATCH_VERSION#v}"

# Runs as `breakpatch` (uid 1000, gid 1000), not root. Ubuntu's own uid-1000 user (`ubuntu`) makes
# way for it. It owns the machine licence's folder and the working folder; breakpatch-ci and
# Chromium in /opt/breakpatch-ci stay root's, read-only to it. The folder stays writable by any
# user (sticky, like /tmp), so `--user` with another uid works too. Where the CI checks out as
# another user (GitHub Actions `container:` jobs), run as root instead: `options: --user root`
# there, `docker run --user root` elsewhere (docs/manual.md, breakpatch-ci in a container).
RUN if getent passwd 1000 >/dev/null; then userdel --remove "$(getent passwd 1000 | cut -d: -f1)" 2>/dev/null || true; fi \
 && if getent group 1000 >/dev/null; then groupdel "$(getent group 1000 | cut -d: -f1)"; fi \
 && groupadd --gid 1000 breakpatch \
 && useradd --uid 1000 --gid 1000 --create-home --shell /bin/bash breakpatch

# The machine licence is kept here unless BREAKPATCH_LICENCE_FILE says where: point that at a
# folder your CI caches between jobs.
ENV BP_HOME=/var/lib/breakpatch
RUN mkdir -p /var/lib/breakpatch /work \
 && chown breakpatch:breakpatch /var/lib/breakpatch /work \
 && chmod 1777 /var/lib/breakpatch

LABEL org.opencontainers.image.title="breakpatch-ci" \
      org.opencontainers.image.description="Breakpatch's command line for CI, with its Chromium" \
      org.opencontainers.image.source="https://github.com/BreakPatch/breakpatch" \
      org.opencontainers.image.url="https://breakpatch.dev/docs/#breakpatch-ci-in-a-container" \
      org.opencontainers.image.version="${BREAKPATCH_VERSION}"

USER breakpatch
WORKDIR /work
CMD ["breakpatch-ci", "--help"]
