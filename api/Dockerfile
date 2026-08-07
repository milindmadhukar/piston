FROM buildpack-deps:buster AS isolate
# Buster is EOL and has moved to archive.debian.org, which still serves the
# packages but with an expired Release file. Staying on buster keeps the
# prebuilt language packages ABI-compatible.
RUN printf '%s\n' \
        'deb http://archive.debian.org/debian buster main' \
        'deb http://archive.debian.org/debian-security buster/updates main' \
        > /etc/apt/sources.list && \
    rm -f /etc/apt/sources.list.d/*.list && \
    echo 'Acquire::Check-Valid-Until "false";' \
        > /etc/apt/apt.conf.d/99no-check-valid-until
RUN apt-get update && \
    apt-get install -y --no-install-recommends git libcap-dev ca-certificates && \
    rm -rf /var/lib/apt/lists/* && \
    git clone https://github.com/envicutor/isolate.git /tmp/isolate/ && \
    cd /tmp/isolate && \
    git checkout af6db68042c3aa0ded80787fbb78bc0846ea2114 && \
    make -j$(nproc) install && \
    rm -rf /tmp/*

# Bun ships a near-static binary that runs on buster's glibc 2.28 (verified),
# so it can simply be lifted out of the official image. The runtime stage below
# stays on buster - a base bump would break every prebuilt language package.
# Pinned to 1.3: the manifest loader needs Bun.YAML, which landed in 1.2.21.
# A floating `1` tag would make that an unstated assumption.
FROM oven/bun:1.3-slim AS bun

# The default image. Named so builds can target it explicitly - the builder
# stage below is last in the file, and an untargeted build would produce that.
FROM debian:buster-slim AS runtime

ENV DEBIAN_FRONTEND=noninteractive

RUN printf '%s\n' \
        'deb http://archive.debian.org/debian buster main' \
        'deb http://archive.debian.org/debian-security buster/updates main' \
        > /etc/apt/sources.list && \
    rm -f /etc/apt/sources.list.d/*.list && \
    echo 'Acquire::Check-Valid-Until "false";' \
        > /etc/apt/apt.conf.d/99no-check-valid-until

RUN dpkg-reconfigure -p critical dash
RUN apt-get update && \
    apt-get install -y libxml2 gnupg tar coreutils util-linux libc6-dev \
    binutils build-essential locales libpcre3-dev libevent-dev libgmp3-dev \
    libncurses6 libncurses5 libedit-dev libseccomp-dev rename procps python3 \
    libreadline-dev libblas-dev liblapack-dev libpcre3-dev libarpack2-dev \
    libfftw3-dev libglpk-dev libqhull-dev libqrupdate-dev libsuitesparse-dev \
    libsundials-dev libpcre2-dev libcap-dev \
    unzip zstd ca-certificates && \
    rm -rf /var/lib/apt/lists/*
RUN useradd -M piston
COPY --from=bun /usr/local/bin/bun /usr/local/bin/bun
COPY --from=isolate /usr/local/bin/isolate /usr/local/bin
COPY --from=isolate /usr/local/etc/isolate /usr/local/etc/isolate

RUN sed -i '/en_US.UTF-8/s/^# //g' /etc/locale.gen && locale-gen

WORKDIR /piston_api
# Build context is the repository root, so the package manifests can be baked
# in: they are the whitelist of what this image is allowed to install.
COPY ["api/package.json", "api/bun.lock", "./"]
RUN bun install --frozen-lockfile --production
COPY ./api/src ./src
COPY ./packages ./packages

CMD ["/piston_api/src/docker-entrypoint.sh"]
EXPOSE 2000/tcp

# ---------------------------------------------------------------------------
# The builder variant: the same API plus the toolchain from repo/Dockerfile, so
# it can run a manifest's `build` script itself instead of fetching an archive
# CI produced. Opt in at runtime with PISTON_ALLOW_SOURCE_BUILDS=true.
#
# Kept as a separate target on purpose. It flips /bin/sh to bash, which every
# package build script assumes and which the default image deliberately does
# not do, and it roughly doubles the image.
FROM debian:buster-slim AS builder

ENV DEBIAN_FRONTEND=noninteractive

RUN printf '%s\n' \
        'deb http://archive.debian.org/debian buster main' \
        'deb http://archive.debian.org/debian-security buster/updates main' \
        > /etc/apt/sources.list && \
    rm -f /etc/apt/sources.list.d/*.list && \
    echo 'Acquire::Check-Valid-Until "false";' \
        > /etc/apt/apt.conf.d/99no-check-valid-until

RUN apt-get update && apt-get install -y unzip autoconf build-essential libssl-dev \
        pkg-config zlib1g-dev libargon2-dev libsodium-dev libcurl4-openssl-dev \
        sqlite3 libsqlite3-dev libonig-dev libxml2 libxml2-dev bc curl git \
        linux-headers-amd64 perl xz-utils python3 python3-pip gnupg jq zlib1g-dev \
        cmake extra-cmake-modules gcc binutils bash coreutils \
        util-linux findutils grep libncurses5-dev libncursesw5-dev \
        libgmp-dev libmpfr-dev libffi-dev gfortran rename procps locales \
        libreadline-dev libblas-dev liblapack-dev libpcre3-dev libarpack2-dev \
        libfftw3-dev libglpk-dev libqhull-dev libqrupdate-dev libsuitesparse-dev \
        libsundials-dev libbz2-dev liblzma-dev libpcre2-dev gperf bison flex \
        g++ gawk zip libzstd-dev zstd libcap-dev libseccomp-dev ca-certificates && \
        ln -sf /bin/bash /bin/sh && \
        rm -rf /var/lib/apt/lists/*

RUN useradd -M piston
COPY --from=bun /usr/local/bin/bun /usr/local/bin/bun
COPY --from=isolate /usr/local/bin/isolate /usr/local/bin
COPY --from=isolate /usr/local/etc/isolate /usr/local/etc/isolate

RUN sed -i '/en_US.UTF-8/s/^# //g' /etc/locale.gen && locale-gen

WORKDIR /piston_api
COPY ["api/package.json", "api/bun.lock", "./"]
RUN bun install --frozen-lockfile --production
COPY ./api/src ./src
COPY ./packages ./packages

ENV PISTON_ALLOW_SOURCE_BUILDS=true

CMD ["/piston_api/src/docker-entrypoint.sh"]
EXPOSE 2000/tcp
