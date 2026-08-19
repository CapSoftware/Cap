# Cap GPUI staging

Place the `cap-gpui` binary (built from `apps/desktop-gpui`) in this folder to
bundle it into the Tauri app as the `gpui/` resource dir. When present, the
Experimental settings page offers launching it; when absent, the section is
hidden. This file exists so the `binaries/gpui/*` bundle glob always matches.
