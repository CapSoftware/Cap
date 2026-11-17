// Browser pages (New Tab, settings, the Web Store) cannot run content
// scripts, so the in-page recorder cannot open there. Cap's own pages (the
// ones with the Cap page nav) load the same overlay a website gets, so the
// recorder always has somewhere to open, including the welcome page a new
// user lands on after installing.
const RECORDER_HOST_PATHS = new Set([
	"/welcome.html",
	"/how-it-works.html",
	"/camera-permission.html",
	"/options.html",
]);

export const RECORDER_OPEN_PARAM = "recorder";

export const isRecorderHostPage = (url: string | undefined) => {
	if (!url) return false;
	try {
		const parsed = new URL(url);
		return (
			parsed.origin === new URL(chrome.runtime.getURL("")).origin &&
			RECORDER_HOST_PATHS.has(parsed.pathname)
		);
	} catch {
		return false;
	}
};
