import { useCallback, useEffect, useState } from "react";
import {
	CAP_CHROME_EXTENSION_INSTALLED_ATTRIBUTE,
	CAP_CHROME_EXTENSION_OPEN_EVENT,
	CAP_CHROME_EXTENSION_READY_EVENT,
	isGoogleChromeBrowser,
} from "@/lib/chrome-extension";

const isCapChromeExtensionInstalled = () =>
	document.documentElement.getAttribute(
		CAP_CHROME_EXTENSION_INSTALLED_ATTRIBUTE,
	) === "true";

export const useCapChromeExtension = () => {
	const [isInstalled, setIsInstalled] = useState(false);
	const [isChromeBrowser, setIsChromeBrowser] = useState(false);

	useEffect(() => {
		setIsChromeBrowser(isGoogleChromeBrowser());

		const detect = () => setIsInstalled(isCapChromeExtensionInstalled());

		detect();
		window.addEventListener(CAP_CHROME_EXTENSION_READY_EVENT, detect);

		return () => {
			window.removeEventListener(CAP_CHROME_EXTENSION_READY_EVENT, detect);
		};
	}, []);

	const openRecorder = useCallback(() => {
		window.dispatchEvent(new CustomEvent(CAP_CHROME_EXTENSION_OPEN_EVENT));
	}, []);

	return { isChromeBrowser, isInstalled, openRecorder };
};
