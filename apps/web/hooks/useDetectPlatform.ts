import { useEffect, useState } from "react";

export interface PlatformInfo {
	platform: string | null;
	isIntel: boolean;
}

export const useDetectPlatform = (): PlatformInfo => {
	const [platform, setPlatform] = useState<string | null>(null);
	const [isIntel, setIsIntel] = useState(false);

	useEffect(() => {
		let isMounted = true;
		const detect = async () => {
			// First try to use the newer navigator.userAgentData API (Chrome, Edge)
			if (
				typeof navigator !== "undefined" &&
				"userAgentData" in navigator &&
				"getHighEntropyValues" in (navigator as any).userAgentData
			) {
				try {
					const uaData = await (
						navigator as any
					).userAgentData.getHighEntropyValues(["architecture", "platform"]);
					if (!isMounted) return;
					if (uaData.platform === "macOS") {
						setPlatform("macos");
						setIsIntel(
							uaData.architecture !== "arm" && uaData.architecture !== "arm64",
						);
						return;
					} else if (uaData.platform === "Windows") {
						setPlatform("windows");
						setIsIntel(false);
						return;
					}
				} catch (e) {
					console.log("Error getting high entropy values:", e);
				}
			}

			// Fallback to user agent detection
			if (typeof navigator !== "undefined") {
				const userAgent = navigator.userAgent;

				if (userAgent.includes("Windows")) {
					setPlatform("windows");
					setIsIntel(false);
					return;
				} else if (userAgent.includes("Mac")) {
					setPlatform("macos");

					// For Macs, we need to do additional detection for Apple Silicon vs Intel
					try {
						// Try WebGL renderer detection (works in Chrome, Firefox)
						const canvas = document.createElement("canvas");
						const gl = canvas.getContext("webgl");

						if (gl) {
							const debugInfo = gl.getExtension("WEBGL_debug_renderer_info");
							if (debugInfo) {
								const renderer = gl.getParameter(
									debugInfo.UNMASKED_RENDERER_WEBGL,
								);

								// Apple Silicon Macs typically show "Apple GPU" in renderer
								if (renderer.match(/Apple/) && !renderer.match(/Apple GPU/)) {
									setIsIntel(true); // Likely Intel
									return;
								}

								// For Safari which hides GPU info, check for specific extensions
								if (renderer.match(/Apple GPU/)) {
									// Check for specific WebGL extensions that might differ between architectures
									const extensions = gl.getSupportedExtensions() || [];
									// This is a heuristic and may need adjustment over time
									if (
										extensions.indexOf("WEBGL_compressed_texture_s3tc_srgb") ===
										-1
									) {
										setIsIntel(false); // Likely Apple Silicon
										return;
									}
								}
							}
						}
						// If we get here and it's a Mac, default to Intel for older Macs
						setIsIntel(true);
					} catch (e) {
						console.log("Error detecting Mac architecture:", e);
						setIsIntel(true);
					}
				} else if (userAgent.includes("Linux")) {
					setPlatform("linux");
					setIsIntel(false);
					return;
				} else {
					// Default to macOS if we can't detect
					setPlatform("macos");
					setIsIntel(false);
				}
			}
		};
		detect();
		return () => {
			isMounted = false;
		};
	}, []);

	return { platform, isIntel };
};
