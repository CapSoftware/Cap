const capAppPathParameter = "$" + "{CAP_APP_PATH:-}";
const capCliInstallDirParameter = "$" + "{CAP_CLI_INSTALL_DIR:-}";
const capDesktopInstallDirParameter = "$" + "{CAP_DESKTOP_INSTALL_DIR:-}";
const capDesktopForceInstallParameter = "$" + "{CAP_DESKTOP_FORCE_INSTALL:-}";
const homeParameter = "$" + "{HOME:-}";
const capNoModifyPathParameter = "$" + "{CAP_NO_MODIFY_PATH:-}";
const shellParameter = "$" + "{SHELL:-/bin/sh}";
const tmpDirParameter = "$" + "{TMPDIR:-/tmp}";

const script = String.raw`#!/usr/bin/env sh
set -eu

APP_PATH="${capAppPathParameter}"
CLI_INSTALL_DIR_OVERRIDE="${capCliInstallDirParameter}"
DESKTOP_INSTALL_DIR_OVERRIDE="${capDesktopInstallDirParameter}"
DESKTOP_FORCE_INSTALL="${capDesktopForceInstallParameter}"
HOME_DIR="${homeParameter}"
TMP_BASE="${tmpDirParameter}"
TMP_ROOT=""
MOUNT_DIR=""
APP_TMP=""
MOUNTED=0

find_cap_app() {
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

install_cap_desktop() {
	if [ "$(uname -s)" != "Darwin" ]; then
		echo "Cap Desktop auto-install is only supported on macOS. Install Cap from https://cap.so/download, then run this script again." >&2
		exit 1
	fi

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

if [ -z "$HOME_DIR" ]; then
	echo "Could not determine home directory. Set HOME, then run this script again." >&2
	exit 1
fi

if [ -z "$APP_PATH" ]; then
	if ! find_cap_app; then
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

	if [ ! -x "$CLI_TARGET" ]; then
		echo "This Cap Desktop install does not include the CLI." >&2
		exit 1
	fi
fi

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
		"$CLI_TARGET"|*/Cap.app/Contents/MacOS/cap-cli)
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
