export function supportedLinuxBundles(version) {
	return version.includes("-")
		? ["deb", "appimage"]
		: ["deb", "rpm", "appimage"];
}

export const RPM_DEPENDS = [
	"libva",
	"pulseaudio-utils",
	"pipewire-libs",
	"alsa-lib",
	"alsa-plugins-pulseaudio",
	"libxkbcommon",
	"libxkbcommon-x11",
	"libX11",
	"openssl-libs",
	"libwayland-client",
	"libwayland-egl",
	"libglvnd-egl",
	"vulkan-loader",
];

// Paths are relative to apps/desktop-gpui, where the config is written.
const root = "../..";

export function createLinuxBundleConfig(libraryNames, debDependencies = []) {
	const files = {};
	for (const name of [...new Set(libraryNames)].toSorted()) {
		files[`/usr/lib/cap/${name}`] =
			`${root}/target/native-deps/cap-deb-libs/${name}`;
	}

	return {
		bundle: {
			linux: {
				deb: {
					depends: [...new Set([...debDependencies, "libasound2-plugins"])],
					files: {
						...files,
						"/usr/lib/cap/package-format": `${root}/packaging/linux/deb`,
					},
				},
				rpm: {
					compression: { type: "zstd", level: 9 },
					depends: [...RPM_DEPENDS],
					files: {
						...files,
						"/usr/lib/cap/package-format": `${root}/packaging/linux/rpm`,
					},
				},
				appimage: {
					bundleMediaFramework: false,
					files: {
						...files,
						"/usr/bin/pactl": "/usr/bin/pactl",
						"/usr/lib/alsa-lib/libasound_module_pcm_pulse.so": `${root}/target/native-deps/cap-appimage-libs/libasound_module_pcm_pulse.so`,
						"/usr/lib/cap/alsa-pulse.conf": `${root}/packaging/linux/alsa-pulse.conf`,
						"/usr/lib/cap/package-format": `${root}/packaging/linux/appimage`,
					},
				},
			},
		},
	};
}
