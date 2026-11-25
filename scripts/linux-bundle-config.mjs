export function supportedLinuxBundles(version) {
	return version.includes("-")
		? ["deb", "appimage"]
		: ["deb", "rpm", "appimage"];
}

// Libraries are required by soname, which every rpm distribution provides
// under the same name (Fedora and openSUSE name the packages differently).
export const RPM_DEPENDS = [
	"libva.so.2()(64bit)",
	"libva-drm.so.2()(64bit)",
	"pulseaudio-utils",
	"libpipewire-0.3.so.0()(64bit)",
	"libasound.so.2()(64bit)",
	"libpulse.so.0()(64bit)",
	"libxkbcommon.so.0()(64bit)",
	"libxkbcommon-x11.so.0()(64bit)",
	"libX11.so.6()(64bit)",
	"libssl.so.3()(64bit)",
	"libcrypto.so.3()(64bit)",
	"libwayland-client.so.0()(64bit)",
	"libwayland-egl.so.1()(64bit)",
	"libEGL.so.1()(64bit)",
	"libvulkan.so.1()(64bit)",
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
						// Loaded only when the host has no ALSA pulse plugin of its own:
						// openSUSE's pipewire-alsa conflicts with alsa-plugins-pulse.
						"/usr/lib/cap/alsa-lib/libasound_module_pcm_pulse.so": `${root}/target/native-deps/cap-appimage-libs/libasound_module_pcm_pulse.so`,
						"/usr/lib/cap/alsa-pulse.conf": `${root}/packaging/linux/alsa-pulse-rpm.conf`,
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
						// Set alone as ALSA_CONFIG_PATH: openSUSE's alsa-lib ignores a list of files.
						"/usr/lib/cap/alsa-pulse-appimage.conf": `${root}/packaging/linux/alsa-pulse-appimage.conf`,
						"/usr/lib/cap/package-format": `${root}/packaging/linux/appimage`,
					},
				},
			},
		},
	};
}
