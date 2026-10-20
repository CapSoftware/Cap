export function supportedLinuxBundles(version) {
	return version.includes("-")
		? ["deb", "appimage"]
		: ["deb", "rpm", "appimage"];
}

export const TAURI_RPM_DEPENDS = [
	"webkit2gtk4.1",
	"gtk3",
	"libayatana-appindicator-gtk3",
	"libva",
	"pulseaudio-utils",
	"pipewire-libs",
	"alsa-lib",
	"alsa-plugins-pulseaudio",
	"libxkbcommon",
	"libxkbcommon-x11",
	"openssl-libs",
];

export const GPUI_RPM_DEPENDS = [
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

export function createLinuxBundleConfig(
	libraryNames,
	commonFiles = {},
	debDependencies = [],
	{
		root = "../../..",
		rpmDependencies = TAURI_RPM_DEPENDS,
		mediaFramework = true,
	} = {},
) {
	const files = { ...commonFiles };
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
					depends: [...rpmDependencies],
					files: {
						...files,
						"/usr/lib/cap/package-format": `${root}/packaging/linux/rpm`,
					},
				},
				appimage: {
					bundleMediaFramework: mediaFramework,
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
