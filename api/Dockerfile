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
FROM oven/bun:1-slim AS bun

FROM debian:buster-slim

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
    libsundials-dev libpcre2-dev libcap-dev && \
    rm -rf /var/lib/apt/lists/*
RUN useradd -M piston
COPY --from=bun /usr/local/bin/bun /usr/local/bin/bun
COPY --from=isolate /usr/local/bin/isolate /usr/local/bin
COPY --from=isolate /usr/local/etc/isolate /usr/local/etc/isolate

RUN sed -i '/en_US.UTF-8/s/^# //g' /etc/locale.gen && locale-gen

WORKDIR /piston_api
COPY ["package.json", "bun.lock", "./"]
RUN bun install --frozen-lockfile --production
COPY ./src ./src

CMD ["/piston_api/src/docker-entrypoint.sh"]
EXPOSE 2000/tcp
