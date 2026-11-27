import { expect, test } from "@playwright/test";
import { launchExtensionBrowser } from "./browser";

const SETTINGS_KEY = "cap-extension-settings";

test("saving an options draft preserves changes saved in another tab", async () => {
	const extension = await launchExtensionBrowser({
		profilePrefix: "cap-options-e2e-",
		headless: true,
		args: [],
	});
	try {
		const worker =
			extension.context.serviceWorkers()[0] ??
			(await extension.context.waitForEvent("serviceworker"));
		const url = `chrome-extension://${new URL(worker.url()).host}/options.html`;
		const first = await extension.context.newPage();
		await first.goto(url);
		await first
			.getByText("Show countdown before recording", { exact: true })
			.click();
		await expect(
			first.getByLabel("Show countdown before recording"),
		).not.toBeChecked();

		const second = await extension.context.newPage();
		await second.goto(url);
		await second
			.getByText("Enable microphone by default", { exact: true })
			.click();
		await expect(
			second.getByLabel("Enable microphone by default"),
		).not.toBeChecked();
		await second.getByLabel("Camera size").fill("350");
		await second.getByRole("button", { name: "Save changes" }).click();
		await expect(second.getByText("Saved", { exact: true })).toBeVisible();

		await first.getByRole("button", { name: "Save changes" }).click();
		await expect(first.getByText("Saved", { exact: true })).toBeVisible();
		const saved = await worker.evaluate(async (key) => {
			const items = await chrome.storage.local.get(key);
			return items[key];
		}, SETTINGS_KEY);
		expect(saved).toMatchObject({
			microphone: { enabled: false },
			webcam: { size: 350 },
			countdown: { enabled: false },
		});
		await expect(
			first.getByLabel("Enable microphone by default"),
		).not.toBeChecked();
		await expect(first.getByLabel("Camera size")).toHaveValue("350");
	} finally {
		await extension.cleanup();
	}
});
