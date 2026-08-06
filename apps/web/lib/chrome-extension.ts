export const CAP_CHROME_EXTENSION_URL =
	"https://chromewebstore.google.com/detail/cap-screen-recorder-scree/fefjaffcodfiogbbngmjkcjpbpclbdcp";

export const CHROME_EXTENSION_BUTTON_CLASS =
	"border-gray-6 bg-white text-gray-12 shadow-[0_1px_2px_rgba(0,0,0,0.08)] hover:border-gray-7 hover:bg-gray-2";

export const CAP_CHROME_EXTENSION_INSTALLED_ATTRIBUTE =
	"data-cap-chrome-extension-installed";
export const CAP_CHROME_EXTENSION_READY_EVENT = "cap-chrome-extension-ready";
export const CAP_CHROME_EXTENSION_OPEN_EVENT = "cap-chrome-extension-open";

type NavigatorUABrand = { brand: string; version: string };
type NavigatorWithUAData = Navigator & {
	userAgentData?: { brands?: NavigatorUABrand[] };
};

export const isGoogleChromeBrowser = () => {
	if (typeof navigator === "undefined") return false;

	const brands = (navigator as NavigatorWithUAData).userAgentData?.brands;
	if (brands) {
		return brands.some(({ brand }) => brand === "Google Chrome");
	}

	// Older Chrome versions without userAgentData: UA sniff, excluding
	// Chromium derivatives that also report "Chrome/".
	const ua = navigator.userAgent;
	return (
		/Chrome\//.test(ua) &&
		!/Edg\/|OPR\/|SamsungBrowser|Brave|YaBrowser/.test(ua)
	);
};
