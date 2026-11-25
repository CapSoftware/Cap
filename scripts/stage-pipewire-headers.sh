#!/usr/bin/env bash
# Stages the PipeWire 1.0.5 development headers of Ubuntu 24.04 and prints a
# pkg-config directory that compiles against them while linking the build
# host's own libpipewire-0.3.so.0. The Rust PipeWire bindings need these
# headers; Ubuntu 22.04's are too old for them. Every libpipewire symbol Cap
# imports exists in 22.04's library, and the link step fails if one does not.
# Usage: stage-pipewire-headers.sh <work dir>
set -euo pipefail
work=$(realpath -m "${1:?work dir}")
base=https://launchpad.net/ubuntu/+archive/primary/+files
packages=(
	"libpipewire-0.3-dev_1.0.5-1ubuntu3.3_amd64.deb 1a0267989f02a8729cdb4df36d9acf3a5ac1a525200d428baffe8961ccb0e0ba"
	"libspa-0.2-dev_1.0.5-1ubuntu3.3_amd64.deb 93a60e7656fb35c97a78159fd0556842c62c2d8b9aff096009f9a20c64c1f272"
)
multiarch=$(dpkg-architecture -qDEB_HOST_MULTIARCH)
system_libdir=/usr/lib/$multiarch
test -e "$system_libdir/libpipewire-0.3.so"
mkdir -p "$work/root" "$work/pkgconfig"
for entry in "${packages[@]}"; do
	read -r name sha <<<"$entry"
	curl --fail --location --retry 3 --silent --show-error -o "$work/$name" "$base/$name"
	echo "$sha  $work/$name" | sha256sum --check --quiet
	dpkg-deb -x "$work/$name" "$work/root"
done
for pc in libpipewire-0.3 libspa-0.2; do
	sed -e "s|^includedir=.*|includedir=$work/root/usr/include|" \
		-e "s|^libdir=.*|libdir=$system_libdir|" \
		"$work/root/usr/lib/$multiarch/pkgconfig/$pc.pc" >"$work/pkgconfig/$pc.pc"
done
echo "$work/pkgconfig"
