import { spawnSync } from "node:child_process";

const actions = [
	{
		name: "open-main",
		payload: "open_main",
		expected: "Opens or focuses the main Cap window.",
	},
	{
		name: "screenshot-area",
		payload: { take_screenshot: { target: "area" } },
		expected:
			"Opens the target selector in screenshot area mode. After selection, opens the screenshot editor without starting camera or mic preview.",
	},
	{
		name: "screenshot-current-display",
		payload: { take_screenshot: { target: "current_display" } },
		expected:
			"Captures the display under the cursor and opens the screenshot editor.",
	},
	{
		name: "screenshot-current-window",
		payload: { take_screenshot: { target: "current_window" } },
		expected:
			"Captures the window under the cursor and opens the screenshot editor. If no window is found, the app logs an error and no editor opens.",
	},
	{
		name: "hotkey-screenshot-area",
		payload: { run_hotkey_action: { action: "screenshotArea" } },
		expected:
			"Runs the same path as the Screenshot Area hotkey and opens the screenshot area selector.",
	},
	{
		name: "open-screenshots",
		payload: "open_screenshots",
		expected: "Opens Settings to the screenshots page.",
	},
	{
		name: "open-recordings",
		payload: "open_recordings",
		expected: "Opens Settings to the recordings page.",
	},
	{
		name: "recording-picker",
		payload: { open_recording_picker: { target_mode: null } },
		expected: "Opens or focuses the main Cap window.",
	},
	{
		name: "recording-picker-display",
		payload: { open_recording_picker: { target_mode: "display" } },
		expected: "Opens the target selector in display mode.",
	},
	{
		name: "recording-picker-window",
		payload: { open_recording_picker: { target_mode: "window" } },
		expected: "Opens the target selector in window mode.",
	},
	{
		name: "recording-picker-area",
		payload: { open_recording_picker: { target_mode: "area" } },
		expected: "Opens the target selector in area mode.",
	},
	{
		name: "start-studio-current-settings",
		payload: { start_recording_with_current_settings: { mode: "studio" } },
		expected:
			"Starts a Studio recording using saved target, mic, camera, system-audio, and organization settings.",
	},
	{
		name: "start-instant-current-settings",
		payload: { start_recording_with_current_settings: { mode: "instant" } },
		expected:
			"Starts an Instant recording using saved target, mic, camera, system-audio, and organization settings.",
	},
	{
		name: "stop-recording",
		payload: "stop_recording",
		expected: "Stops the active recording.",
	},
	{
		name: "toggle-pause-recording",
		payload: "toggle_pause_recording",
		expected: "Pauses or resumes the active recording.",
	},
	{
		name: "restart-recording",
		payload: "restart_recording",
		expected: "Restarts the active recording.",
	},
	{
		name: "cycle-recording-mode",
		payload: "cycle_recording_mode",
		expected:
			"Cycles saved mode through Studio, Instant, and Screenshot, and updates the tray icon.",
	},
	{
		name: "set-screenshot-mode",
		payload: { set_recording_mode: { mode: "screenshot" } },
		expected: "Saves Screenshot as the current mode and updates the tray icon.",
	},
	{
		name: "open-settings-screenshots",
		payload: { open_settings: { page: "screenshots" } },
		expected: "Opens Settings to the screenshots page.",
	},
];

const args = process.argv.slice(2);
const flags = new Set(args.filter((arg) => arg.startsWith("--")));
const actionName = args.find((arg) => !arg.startsWith("--"));

function urlFor(payload) {
	return `cap-desktop://action?value=${encodeURIComponent(JSON.stringify(payload))}`;
}

function printAction(action) {
	const url = urlFor(action.payload);
	console.log(action.name);
	console.log(`  payload: ${JSON.stringify(action.payload)}`);
	console.log(`  url: ${url}`);
	console.log(`  command: open '${url}'`);
	console.log(`  expected: ${action.expected}`);
}

function printHelp() {
	console.log(
		"Usage: node scripts/cap-desktop-action-deeplinks.js [name] [--open]",
	);
	console.log("");
	console.log("With no name, prints every test command.");
	console.log("With --open, opens the selected deeplink on macOS.");
	console.log("");
	console.log("Names:");
	for (const action of actions) {
		console.log(`  ${action.name}`);
	}
}

if (flags.has("--help")) {
	printHelp();
} else if (!actionName) {
	for (const action of actions) {
		printAction(action);
		console.log("");
	}
} else {
	const action = actions.find((candidate) => candidate.name === actionName);

	if (!action) {
		console.error(`Unknown deeplink action: ${actionName}`);
		console.error(
			"Run `node scripts/cap-desktop-action-deeplinks.js --help` for valid names.",
		);
		process.exitCode = 1;
	} else {
		printAction(action);

		if (flags.has("--open")) {
			if (process.platform !== "darwin") {
				console.error("--open currently uses the macOS `open` command.");
				process.exitCode = 1;
			} else {
				const result = spawnSync("open", [urlFor(action.payload)], {
					stdio: "inherit",
				});
				process.exitCode = result.status ?? 1;
			}
		}
	}
}
