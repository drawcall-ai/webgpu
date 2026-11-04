#!/bin/sh
# Usage: deps/alpine.sh TARGET [build]. Without "build", package and test a restored dist/TARGET.
set -eu
apk add --no-cache python3 patchelf
if [ "${2:-}" = build ]; then
  apk add --no-cache build-base linux-headers python3-dev py3-pip cmake ninja git curl tar xz bison flex clang pkgconf go
  git config --global --add safe.directory /work
  export GOTOOLCHAIN=auto
  python3 -m venv /opt/build-tools
  . /opt/build-tools/bin/activate
  pip install meson==1.7.0 mako pyyaml packaging
  python native/build.py build "dist/$1"
  python deps/mesa.py "dist/$1" --work build/mesa --jobs 4
  python deps/bundle.py "dist/$1"
fi
node deps/package.js "dist/$1"
python3 deps/check.py "dist/$1"
npm run test:package -- "dist/$1"
