export function supportedLinuxBundles(version) {
	return version.includes("-")
		? ["deb", "appimage"]
		: ["deb", "rpm", "appimage"];
}

export function createLinuxBundleConfig(
	libraryNames,
	commonFiles = {},
	debDependencies = [],
) {
	const files = { ...commonFiles };
	for (const name of [...new Set(libraryNames)].toSorted()) {
		files[`/usr/lib/cap/${name}`] =
			`../../../target/native-deps/cap-deb-libs/${name}`;
	}

	return {
		bundle: {
			linux: {
				deb: {
					depends: [...new Set([...debDependencies, "libasound2-plugins"])],
					files: {
						...files,
						"/usr/lib/cap/package-format": "../../../packaging/linux/deb",
					},
				},
				rpm: {
					compression: { type: "zstd", level: 9 },
					depends: [
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
					],
					files: {
						...files,
						"/usr/lib/cap/package-format": "../../../packaging/linux/rpm",
					},
				},
				appimage: {
					bundleMediaFramework: true,
					files: {
						...files,
						"/usr/bin/pactl": "/usr/bin/pactl",
						"/usr/lib/alsa-lib/libasound_module_pcm_pulse.so":
							"../../../target/native-deps/cap-appimage-libs/libasound_module_pcm_pulse.so",
						"/usr/lib/cap/alsa-pulse.conf":
							"../../../packaging/linux/alsa-pulse.conf",
						"/usr/lib/cap/package-format": "../../../packaging/linux/appimage",
					},
				},
			},
		},
	};
}
