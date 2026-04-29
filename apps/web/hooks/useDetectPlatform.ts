import { useEffect, useState } from "react";

export interface PlatformInfo {
	platform: string | null;
	isIntel: boolean;
}

function detectArchFromWebGL(): boolean | null {
	try {
		const canvas = document.createElement("canvas");
		const gl = canvas.getContext("webgl2") || canvas.getContext("webgl");

		if (!gl) return null;

		const debugInfo = gl.getExtension("WEBGL_debug_renderer_info");
		if (!debugInfo) return null;

		const renderer = (
			gl.getParameter(debugInfo.UNMASKED_RENDERER_WEBGL) as string
		).toLowerCase();

		if (/apple m\d/i.test(renderer)) return false;

		if (/intel|amd|radeon/i.test(renderer)) return true;

		return null;
	} catch {
		return null;
	}
}

export const useDetectPlatform = (): PlatformInfo => {
	const [platform, setPlatform] = useState<string | null>(null);
	const [isIntel, setIsIntel] = useState(false);

	useEffect(() => {
		let isMounted = true;
		const detect = async () => {
			if (typeof navigator === "undefined") return;

			const userAgent = navigator.userAgent;

			if (userAgent.includes("Windows")) {
				if (isMounted) setPlatform("windows");
				return;
			}

			if (userAgent.includes("Linux")) {
				if (isMounted) setPlatform("linux");
				return;
			}

			if (isMounted) setPlatform("macos");

			if (!userAgent.includes("Mac")) {
				return;
			}

			if (
				"userAgentData" in navigator &&
				(navigator as any).userAgentData?.getHighEntropyValues
			) {
				try {
					const uaData = await (
						navigator as any
					).userAgentData.getHighEntropyValues(["architecture"]);
					if (!isMounted) return;
					const arch = (uaData.architecture ?? "").toLowerCase();
					if (isMounted) setIsIntel(arch !== "arm" && arch !== "arm64");
					return;
				} catch {}
			}

			const webGLResult = detectArchFromWebGL();
			if (webGLResult !== null) {
				if (isMounted) setIsIntel(webGLResult);
				return;
			}

			if (isMounted) setIsIntel(false);
		};
		detect();
		return () => {
			isMounted = false;
		};
	}, []);

	return { platform, isIntel };
};
