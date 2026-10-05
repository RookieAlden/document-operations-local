#!/bin/sh
# Optional pinned PostgreSQL build; no system install, database creation, or cloud access.
set -eu
: "${DOP_PG_ROOT:?Set the dedicated cache directory for PostgreSQL binaries}"
case "$DOP_PG_ROOT" in /*) ;; *) exit 1;; esac
case "$DOP_PG_ROOT" in *[!a-zA-Z0-9_./-]*) echo "Use a cache path without spaces" >&2; exit 1;; esac
mkdir -p "$DOP_PG_ROOT"
DOP_PG_VERSION=17.10
DOP_PG_SHA=078a03516dcdbdb705fecaf415ea3d13a956c589e46f09fed68a06fb00598c90
DOP_PG_BIN="$DOP_PG_ROOT/runtime/bin"
mkdir -p "$DOP_PG_ROOT"
  if [ ! -x "$DOP_PG_BIN/postgres" ]; then
    DOP_PG_ARCHIVE="$DOP_PG_ROOT/postgresql-$DOP_PG_VERSION.tar.bz2"
    [ -f "$DOP_PG_ARCHIVE" ] || curl -fL --max-time 180 "https://ftp.postgresql.org/pub/source/v$DOP_PG_VERSION/postgresql-$DOP_PG_VERSION.tar.bz2" -o "$DOP_PG_ARCHIVE"
    DOP_PG_ACTUAL=$(shasum -a 256 "$DOP_PG_ARCHIVE" | cut -d ' ' -f 1)
    [ "$DOP_PG_ACTUAL" = "$DOP_PG_SHA" ] || { echo 'PostgreSQL source checksum mismatch' >&2; exit 1; }
    tar -xjf "$DOP_PG_ARCHIVE" -C "$DOP_PG_ROOT"
    mkdir -p "$DOP_PG_ROOT/build"
    cd "$DOP_PG_ROOT/build"
    if [ -n "${DOP_OPENSSL_ROOT:-}" ]; then
      "$DOP_PG_ROOT/postgresql-$DOP_PG_VERSION/configure" --prefix="$DOP_PG_ROOT/runtime" --without-icu --without-readline --with-ssl=openssl --with-includes="$DOP_OPENSSL_ROOT/include" --with-libraries="$DOP_OPENSSL_ROOT/lib" > configure.log 2>&1
    else
      "$DOP_PG_ROOT/postgresql-$DOP_PG_VERSION/configure" --prefix="$DOP_PG_ROOT/runtime" --without-icu --without-readline --with-ssl=openssl > configure.log 2>&1
    fi
    make -j "${DOP_BUILD_JOBS:-4}" > build.log 2>&1
    make install > install.log 2>&1
    make -C contrib/pgcrypto install > pgcrypto-install.log 2>&1
  fi
echo "PostgreSQL binaries ready: $DOP_PG_BIN"
