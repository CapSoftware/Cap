const sharedConfig = require("@cap/ui/tailwind")("chrome-extension");

module.exports = {
	...sharedConfig,
	content: [
		"./popup.html",
		"./options.html",
		"./camera-preview.html",
		"./camera-permission.html",
		"./src/**/*.{ts,tsx}",
	],
};
