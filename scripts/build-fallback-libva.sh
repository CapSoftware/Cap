#!/usr/bin/env bash
# Builds the AppImage's fallback libva (used only on hosts without one) from
# Ubuntu's own libva 2.23.0-1ubuntu1 source package on the build host, so it
# keeps Ubuntu's version and build options but needs no newer glibc than the
# host's. Prints the directory holding libva.so.2 and libva-drm.so.2.
# Usage: build-fallback-libva.sh <work dir>
set -euo pipefail
work=$(realpath -m "${1:?work dir}")
base=http://archive.ubuntu.com/ubuntu/pool/main/libv/libva
files=(
	"libva_2.23.0-1ubuntu1.dsc 4ea6a794cef9425f242ce7c5ad4ad220e5c9792bd264402fe5ce9f33ba1e5f56"
	"libva_2.23.0.orig.tar.gz b10aceb30e93ddf13b2030eb70079574ba437be9b3b76065caf28a72c07e23e7"
	"libva_2.23.0-1ubuntu1.debian.tar.xz 157843dc8f3431da82b59d4851141145137bcd16cff181ddd3ef8e48eb5be1ff"
)
mkdir -p "$work"
cd "$work"
for entry in "${files[@]}"; do
	read -r name sha <<<"$entry"
	curl --fail --location --retry 3 --silent --show-error -o "$name" "$base/$name"
	echo "$sha  $name" | sha256sum --check --quiet
done
dpkg-source --no-check -x libva_2.23.0-1ubuntu1.dsc source >&2
cd source
# Ubuntu 22.04 names pkgconf's predecessor pkg-config; either one builds libva.
sed -i 's/^\( *\)pkgconf,$/\1pkgconf | pkg-config,/' debian/control
# Fails if the host lacks a build dependency, instead of building differently.
dpkg-checkbuilddeps >&2
DEB_BUILD_OPTIONS="nocheck nodoc" dpkg-buildpackage -b -uc -us >&2
cd "$work"
mkdir -p root
for deb in libva2_2.23.0-1ubuntu1_*.deb libva-drm2_2.23.0-1ubuntu1_*.deb; do
	dpkg-deb -x "$deb" root
done
echo "$work/root/usr/lib/$(dpkg-architecture -qDEB_HOST_MULTIARCH)"
