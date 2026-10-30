#!/usr/bin/env bash
set -euo pipefail

if [[ $# -lt 2 || $# -gt 3 ]]; then
	printf 'Usage: %s <Cap.deb> <output-directory> [<deb-download-url>]\n' "$0" >&2
	exit 1
fi

if [[ $(id -u) -eq 0 ]]; then
	printf 'Build the Arch package as an ordinary user, as required by makepkg.\n' >&2
	exit 1
fi

source_url="${3:-}"
if [[ -n "$source_url" && ! "$source_url" =~ ^https://[A-Za-z0-9._~%/:?=+-]+$ ]]; then
	printf 'Unsupported download URL: %s\n' "$source_url" >&2
	exit 1
fi

deb="$(realpath "$1")"
mkdir -p "$2"
output="$(realpath "$2")"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

control_member="$(bsdtar -tf "$deb" | awk '/^control\.tar(\.|$)/ { print; exit }')"
data_member="$(bsdtar -tf "$deb" | awk '/^data\.tar(\.|$)/ { print; exit }')"
if [[ ! "$control_member" =~ ^control\.tar(\.(gz|xz|zst|bz2|lzma))?$ || ! "$data_member" =~ ^data\.tar(\.(gz|xz|zst|bz2|lzma))?$ ]]; then
	printf 'The input is not a Debian package with control and data archives.\n' >&2
	exit 1
fi

mkdir "$work/control"
bsdtar -xOf "$deb" "$control_member" | bsdtar -xf - -C "$work/control"
version="$(awk '/^Version:/ { print $2 }' "$work/control/control")"
architecture="$(awk '/^Architecture:/ { print $2 }' "$work/control/control")"
if [[ ! "$version" =~ ^[0-9][0-9A-Za-z.+~_-]*$ ]]; then
	printf 'Unsupported package version: %s\n' "$version" >&2
	exit 1
fi

case "$architecture" in
	amd64) architecture=x86_64 ;;
	arm64) architecture=aarch64 ;;
	*) printf 'Unsupported package architecture: %s\n' "$architecture" >&2; exit 1 ;;
esac

deb_file="Cap_${version}_${architecture}.deb"
cp "$deb" "$work/$deb_file"
checksum="$(sha256sum "$work/$deb_file" | cut -d ' ' -f 1)"
cat > "$work/PKGBUILD" <<EOF
# Maintainer: Cap Software <hello at cap dot so>
pkgname=cap-bin
pkgver=${version//-/_}
pkgrel=1
pkgdesc="Screen recording with Studio, Instant, and screenshot modes"
arch=("$architecture")
url="https://cap.so"
license=("AGPL-3.0-only")
depends=("libva" "libpulse" "libpipewire" "alsa-lib" "alsa-plugins" "libxkbcommon" "libxkbcommon-x11" "libx11" "openssl" "wayland" "libglvnd" "vulkan-icd-loader" "xdg-desktop-portal" "xdg-utils")
optdepends=("xdg-desktop-portal-hyprland: screen capture on Hyprland and Omarchy" "vulkan-driver: hardware accelerated recording and editing")
provides=("cap=\$pkgver")
conflicts=("cap")
options=("!strip" "!debug")
source=("$deb_file${source_url:+::$source_url}")
noextract=("$deb_file")
sha256sums=("$checksum")

package() {
	bsdtar -xOf "\$srcdir/$deb_file" "$data_member" | bsdtar -xf - -C "\$pkgdir"
	for binary in Cap cap-cli cap-muxer; do
		test -x "\$pkgdir/usr/bin/\$binary"
	done
	printf 'arch\n' > "\$pkgdir/usr/lib/cap/package-format"
}
EOF

cd "$work"
if [[ -n "$source_url" ]]; then
	cp PKGBUILD "$output/PKGBUILD"
	makepkg --printsrcinfo > "$output/.SRCINFO"
fi
PKGDEST="$output" makepkg --nodeps --noconfirm
