import { defineConfig, devices } from "@playwright/test";

const channel = process.env.FEEDBACK_BROWSER_CHANNEL ?? "chrome";
const media = {
	permissions: ["microphone"],
	launchOptions: {
		args: [
			"--use-fake-ui-for-media-stream",
			"--use-fake-device-for-media-stream",
		],
	},
};

export default defineConfig({
	testDir: "e2e",
	timeout: 60_000,
	reporter: "list",
	projects: [
		{
			name: "desktop",
			use: {
				...devices["Desktop Chrome"],
				channel,
				viewport: { width: 1280, height: 800 },
				...media,
			},
		},
		{
			name: "phone",
			use: { ...devices["Pixel 7"], channel, ...media },
		},
	],
});
