const capAppPathParameter = "$" + "{CAP_APP_PATH:-}";
const capCliInstallDirParameter = "$" + "{CAP_CLI_INSTALL_DIR:-}";
const homeParameter = "$" + "{HOME:-}";
const capNoModifyPathParameter = "$" + "{CAP_NO_MODIFY_PATH:-}";
const shellParameter = "$" + "{SHELL:-/bin/sh}";

const script = String.raw`#!/usr/bin/env sh
set -eu

APP_PATH="${capAppPathParameter}"
CLI_INSTALL_DIR_OVERRIDE="${capCliInstallDirParameter}"
HOME_DIR="${homeParameter}"

if [ -z "$APP_PATH" ]; then
	for candidate in "/Applications/Cap.app" "$HOME/Applications/Cap.app"; do
		if [ -d "$candidate" ]; then
			APP_PATH="$candidate"
			break
		fi
	done
fi

if [ -z "$APP_PATH" ]; then
	echo "Cap Desktop was not found. Install Cap from https://cap.so/download, then run this script again." >&2
	exit 1
fi

if [ -z "$HOME_DIR" ]; then
	echo "Could not determine home directory. Set CAP_CLI_INSTALL_DIR, then run this script again." >&2
	exit 1
fi

CLI_TARGET="$APP_PATH/Contents/MacOS/cap-cli"

if [ ! -x "$CLI_TARGET" ]; then
	echo "This Cap Desktop install does not include the CLI. Update Cap, then run this script again." >&2
	exit 1
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
