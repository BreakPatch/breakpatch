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

# The machine licence is kept here unless BREAKPATCH_LICENCE_FILE says where: point that at a
# folder your CI caches between jobs.
ENV BP_HOME=/var/lib/breakpatch
RUN mkdir -p /var/lib/breakpatch && chmod 1777 /var/lib/breakpatch

LABEL org.opencontainers.image.title="breakpatch-ci" \
      org.opencontainers.image.description="Breakpatch's command line for CI, with its Chromium" \
      org.opencontainers.image.source="https://github.com/BreakPatch/breakpatch" \
      org.opencontainers.image.url="https://breakpatch.dev/docs/#breakpatch-ci-in-a-container" \
      org.opencontainers.image.version="${BREAKPATCH_VERSION}"

WORKDIR /work
CMD ["breakpatch-ci", "--help"]
