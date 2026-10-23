const capAppPathParameter = "$" + "{CAP_APP_PATH:-}";
const capCliInstallDirParameter = "$" + "{CAP_CLI_INSTALL_DIR:-}";
const capDesktopInstallDirParameter = "$" + "{CAP_DESKTOP_INSTALL_DIR:-}";
const capDesktopInstallFormatParameter = "$" + "{CAP_DESKTOP_INSTALL_FORMAT:-}";
const capDesktopForceInstallParameter = "$" + "{CAP_DESKTOP_FORCE_INSTALL:-}";
const homeParameter = "$" + "{HOME:-}";
const xdgDataHomeParameter = "$" + "{XDG_DATA_HOME:-}";
const capNoModifyPathParameter = "$" + "{CAP_NO_MODIFY_PATH:-}";
const shellParameter = "$" + "{SHELL:-/bin/sh}";
const tmpDirParameter = "$" + "{TMPDIR:-/tmp}";

const script = String.raw`#!/usr/bin/env sh
set -eu

APP_PATH="${capAppPathParameter}"
CLI_INSTALL_DIR_OVERRIDE="${capCliInstallDirParameter}"
DESKTOP_INSTALL_DIR_OVERRIDE="${capDesktopInstallDirParameter}"
DESKTOP_INSTALL_FORMAT="${capDesktopInstallFormatParameter}"
DESKTOP_FORCE_INSTALL="${capDesktopForceInstallParameter}"
HOME_DIR="${homeParameter}"
XDG_DATA_HOME_DIR="${xdgDataHomeParameter}"
TMP_BASE="${tmpDirParameter}"
TMP_ROOT=""
MOUNT_DIR=""
APP_TMP=""
CLI_TARGET=""
MOUNTED=0
OS_NAME="$(uname -s)"

find_cap_app_macos() {
	for candidate in "/Applications/Cap.app" "$HOME_DIR/Applications/Cap.app"; do
		if [ -d "$candidate" ]; then
			APP_PATH="$candidate"
			return 0
		fi
	done

	return 1
}

cleanup_desktop_install() {
	if [ "$MOUNTED" = "1" ]; then
		hdiutil detach "$MOUNT_DIR" -quiet >/dev/null 2>&1 || true
	fi

	if [ -n "$TMP_ROOT" ]; then
		rm -rf "$TMP_ROOT"
	fi

	if [ -n "$APP_TMP" ]; then
		rm -rf "$APP_TMP"
	fi
}

linux_require_supported_arch() {
	case "$(uname -m)" in
		x86_64|amd64)
			;;
		*)
			echo "Cap for Linux currently ships x86_64 desktop builds. Unsupported architecture: $(uname -m)" >&2
			exit 1
			;;
	esac
}

run_as_root() {
	if [ "$(id -u)" = "0" ]; then
		"$@"
	elif command -v sudo >/dev/null 2>&1; then
		sudo "$@"
	else
		echo "Installing this package requires root. Re-run with sudo installed." >&2
		exit 1
	fi
}

find_cli_in_dir() {
	root="$1"
	if [ ! -d "$root" ]; then
		return 1
	fi

	for dir in "$root" "$root/usr/bin" "$root/usr/lib/cap" "$root/usr/lib/Cap" "$root/usr/lib64/cap" "$root/opt/Cap" "$root/resources" "$root/Contents/MacOS"; do
		for name in cap-cli cap-cli-x86_64-unknown-linux-gnu cap-cli-aarch64-unknown-linux-gnu; do
			candidate="$dir/$name"
			if [ -x "$candidate" ]; then
				CLI_TARGET="$candidate"
				return 0
			fi
		done
	done

	candidate="$(find "$root" -type f \( -name "cap-cli" -o -name "cap-cli-*linux*" \) -perm -111 2>/dev/null | head -n 1 || true)"
	if [ -n "$candidate" ]; then
		CLI_TARGET="$candidate"
		return 0
	fi

	return 1
}

find_linux_system_cli() {
	for root in /usr/bin /usr/local/bin /usr/lib/cap /usr/lib/Cap /usr/lib64/cap /opt/Cap /opt/cap /usr/share/cap /usr/share/Cap; do
		if find_cli_in_dir "$root"; then
			return 0
		fi
	done

	candidate="$(find /usr/lib /usr/lib64 /opt -type f \( -name "cap-cli" -o -name "cap-cli-*linux*" \) -perm -111 2>/dev/null | head -n 1 || true)"
	if [ -n "$candidate" ]; then
		CLI_TARGET="$candidate"
		return 0
	fi

	return 1
}

find_linux_cli_target() {
	if [ -n "$APP_PATH" ]; then
		if [ -d "$APP_PATH" ]; then
			if find_cli_in_dir "$APP_PATH"; then
				return 0
			fi
		elif [ -f "$APP_PATH" ]; then
			if [ -x "$APP_PATH" ]; then
				case "$(basename "$APP_PATH")" in
					cap-cli|cap-cli-*linux*)
						CLI_TARGET="$APP_PATH"
						return 0
						;;
				esac
			fi

			if find_cli_in_dir "$(dirname "$APP_PATH")"; then
				return 0
			fi
		fi
	fi

	if find_linux_system_cli; then
		return 0
	fi

	return 1
}

install_cap_desktop_macos() {
	case "$(uname -m)" in
		arm64|aarch64) DOWNLOAD_URL="https://cap.so/download/apple-silicon" ;;
		x86_64|amd64) DOWNLOAD_URL="https://cap.so/download/apple-intel" ;;
		*)
			echo "Unsupported Mac architecture: $(uname -m)" >&2
			exit 1
			;;
	esac

	if [ -n "$DESKTOP_INSTALL_DIR_OVERRIDE" ]; then
		APP_DIR="$DESKTOP_INSTALL_DIR_OVERRIDE"
	elif [ -n "$APP_PATH" ] && [ -w "$(dirname "$APP_PATH")" ]; then
		APP_DIR="$(dirname "$APP_PATH")"
	elif [ -w "/Applications" ]; then
		APP_DIR="/Applications"
	else
		APP_DIR="$HOME_DIR/Applications"
	fi

	APP_PATH="$APP_DIR/Cap.app"
	APP_TMP="$APP_DIR/.Cap.app.installing"
	TMP_ROOT="$(mktemp -d "$TMP_BASE/cap-cli-install.XXXXXX")"
	DMG_PATH="$TMP_ROOT/Cap.dmg"
	MOUNT_DIR="$TMP_ROOT/mount"
	mkdir -p "$APP_DIR" "$MOUNT_DIR"

	trap cleanup_desktop_install EXIT HUP INT TERM

	echo "Downloading Cap Desktop..."
	curl -fL "$DOWNLOAD_URL" -o "$DMG_PATH"
	hdiutil attach "$DMG_PATH" -nobrowse -quiet -mountpoint "$MOUNT_DIR"
	MOUNTED=1

	SOURCE_APP=""
	for candidate in "$MOUNT_DIR"/Cap.app "$MOUNT_DIR"/*.app; do
		if [ -d "$candidate" ] && [ "$(basename "$candidate")" = "Cap.app" ]; then
			SOURCE_APP="$candidate"
			break
		fi
	done

	if [ -z "$SOURCE_APP" ]; then
		echo "Downloaded Cap Desktop image did not contain Cap.app." >&2
		exit 1
	fi

	echo "Installing Cap Desktop to $APP_PATH..."
	rm -rf "$APP_TMP"
	ditto "$SOURCE_APP" "$APP_TMP"
	rm -rf "$APP_PATH"
	mv "$APP_TMP" "$APP_PATH"
	APP_TMP=""
	hdiutil detach "$MOUNT_DIR" -quiet
	MOUNTED=0
	rm -rf "$TMP_ROOT"
	TMP_ROOT=""
	trap - EXIT HUP INT TERM
}

install_cap_desktop_linux_deb() {
	linux_require_supported_arch
	TMP_ROOT="$(mktemp -d "$TMP_BASE/cap-cli-install.XXXXXX")"
	DEB_PATH="$TMP_ROOT/Cap.deb"
	trap cleanup_desktop_install EXIT HUP INT TERM

	echo "Downloading Cap Desktop Debian package..."
	curl --proto '=https' --tlsv1.2 --retry 3 --retry-delay 1 -fL "https://cap.so/download/linux-deb" -o "$DEB_PATH"

	if command -v apt-get >/dev/null 2>&1; then
		run_as_root apt-get install -y "$DEB_PATH"
	elif command -v dpkg >/dev/null 2>&1; then
		run_as_root dpkg -i "$DEB_PATH"
	else
		echo "Could not find apt-get or dpkg. Cap for Linux currently ships as a Debian package." >&2
		exit 1
	fi

	rm -rf "$TMP_ROOT"
	TMP_ROOT=""
	trap - EXIT HUP INT TERM

	if ! find_linux_cli_target; then
		echo "This Cap Desktop package does not include the CLI." >&2
		exit 1
	fi
}

install_cap_desktop_linux() {
	FORMAT="$(printf '%s' "$DESKTOP_INSTALL_FORMAT" | tr '[:upper:]' '[:lower:]')"
	if [ -z "$FORMAT" ]; then
		FORMAT="deb"
	fi

	case "$FORMAT" in
		deb|debian|ubuntu|linux)
			install_cap_desktop_linux_deb
			;;
		*)
			echo "Unsupported Linux install format: $DESKTOP_INSTALL_FORMAT. Use deb, debian, or ubuntu." >&2
			exit 1
			;;
	esac
}

install_cap_desktop() {
	case "$OS_NAME" in
		Darwin)
			install_cap_desktop_macos
			;;
		Linux)
			install_cap_desktop_linux
			;;
		*)
			echo "Cap Desktop auto-install is only supported on macOS and Linux. Install Cap from https://cap.so/download, then run this script again." >&2
			exit 1
			;;
	esac
}

resolve_cli_target() {
	case "$OS_NAME" in
		Darwin)
			if [ -z "$APP_PATH" ]; then
				if ! find_cap_app_macos; then
					install_cap_desktop
				fi
			elif [ ! -d "$APP_PATH" ]; then
				echo "Cap Desktop was not found at $APP_PATH." >&2
				exit 1
			fi

			if [ -n "$DESKTOP_FORCE_INSTALL" ]; then
				install_cap_desktop
			fi

			CLI_TARGET="$APP_PATH/Contents/MacOS/cap-cli"

			if [ ! -x "$CLI_TARGET" ]; then
				echo "This Cap Desktop install does not include the CLI. Reinstalling Cap Desktop..."
				install_cap_desktop
				CLI_TARGET="$APP_PATH/Contents/MacOS/cap-cli"
			fi
			;;
		Linux)
			if [ -n "$DESKTOP_FORCE_INSTALL" ]; then
				install_cap_desktop
			elif ! find_linux_cli_target; then
				install_cap_desktop
			fi
			;;
		*)
			echo "Unsupported operating system: $OS_NAME" >&2
			exit 1
			;;
	esac

	if [ ! -x "$CLI_TARGET" ]; then
		echo "This Cap Desktop install does not include the CLI." >&2
		exit 1
	fi
}

if [ -z "$HOME_DIR" ]; then
	echo "Could not determine home directory. Set HOME, then run this script again." >&2
	exit 1
fi

resolve_cli_target

if [ -n "$CLI_INSTALL_DIR_OVERRIDE" ]; then
	INSTALL_DIR="$CLI_INSTALL_DIR_OVERRIDE"
elif case ":$PATH:" in *:"$HOME_DIR/.local/bin":*) true ;; *) false ;; esac; then
	INSTALL_DIR="$HOME_DIR/.local/bin"
else
	INSTALL_DIR="$HOME_DIR/.cap/bin"
fi
SHIM_PATH="$INSTALL_DIR/cap"

mkdir -p "$INSTALL_DIR"

if [ -e "$SHIM_PATH" ] || [ -L "$SHIM_PATH" ]; then
	if [ ! -L "$SHIM_PATH" ]; then
		echo "$SHIM_PATH already exists and is not managed by Cap. Remove it or set CAP_CLI_INSTALL_DIR, then run this script again." >&2
		exit 1
	fi

	EXISTING_TARGET="$(readlink "$SHIM_PATH" || true)"

	case "$EXISTING_TARGET" in
		"$CLI_TARGET"|*/Cap.app/Contents/MacOS/cap-cli|*/cap-cli|*/cap-cli-*linux*)
			;;
		*)
			echo "$SHIM_PATH already exists and is not managed by Cap. Remove it or set CAP_CLI_INSTALL_DIR, then run this script again." >&2
			exit 1
			;;
	esac
fi

ln -sfn "$CLI_TARGET" "$SHIM_PATH"

"$SHIM_PATH" --help >/dev/null

echo "Installed cap at $SHIM_PATH"

EXPORT_LINE="export PATH=\"$INSTALL_DIR:\$PATH\""

case ":$PATH:" in
	*:"$INSTALL_DIR":*)
		echo "cap is ready to use."
		;;
	*)
		if [ -n "${capNoModifyPathParameter}" ]; then
			echo "Add this to your shell profile, then open a new terminal:"
			echo "  $EXPORT_LINE"
		else
			case "$(basename "${shellParameter}")" in
				zsh) PROFILE="$HOME_DIR/.zshrc" ;;
				bash) PROFILE="$HOME_DIR/.bashrc" ;;
				*) PROFILE="$HOME_DIR/.profile" ;;
			esac

			if [ -f "$PROFILE" ] && grep -qsF "$INSTALL_DIR" "$PROFILE"; then
				echo "cap is on your PATH via $PROFILE; restart your terminal to use it."
			elif printf '\n# Added by the Cap CLI installer\n%s\n' "$EXPORT_LINE" >> "$PROFILE" 2>/dev/null; then
				echo "Added cap to your PATH in $PROFILE."
				echo "Restart your terminal, or run: $EXPORT_LINE"
			else
				echo "Add this to your shell profile, then open a new terminal:"
				echo "  $EXPORT_LINE"
			fi
		fi
		;;
esac
`;

export async function GET() {
	return new Response(script, {
		headers: {
			"Content-Type": "text/x-shellscript; charset=utf-8",
			"Cache-Control": "public, max-age=3600",
		},
	});
}
