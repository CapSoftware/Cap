import { readdir, readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import * as icons from "@hugeicons/core-free-icons";

const directory = fileURLToPath(new URL("../assets/icons/", import.meta.url));
const preserved = new Set([
	"logo-full.svg",
	"logo-full-dark.svg",
	"google-drive.svg",
	"caption-close-windows.svg",
	"caption-maximize-windows.svg",
	"caption-minimize-windows.svg",
	"caption-restore-windows.svg",
	"traffic-close.svg",
]);

const aliases: Record<string, string> = {
	"align-center": "TextAlignCenterIcon",
	"align-left": "TextAlignLeftIcon",
	"align-right": "TextAlignRightIcon",
	"app-window-mac": "AppWindowMacIcon",
	"app-window": "AppWindowIcon",
	area: "CursorRectangleSelection01Icon",
	"arrow-left-right": "ArrowLeftRightIcon",
	"arrow-left-to-line": "ArrowLeftToLineIcon",
	"arrow-right-to-line": "ArrowRightToLineIcon",
	arrows: "FlipHorizontalIcon",
	"audio-on": "VolumeHighIcon",
	"bg-blur": "BlurIcon",
	"box-select": "CursorRectangleSelection01Icon",
	captions: "SubtitleIcon",
	"caret-down": "ArrowDown01Icon",
	"circle-check": "CheckmarkCircle01Icon",
	"circle-help": "HelpCircleIcon",
	"circle-plus": "AddCircleIcon",
	"circle-x": "CancelCircleIcon",
	clapperboard: "ClapperboardIcon",
	"columns-2": "LayoutTwoColumnIcon",
	corners: "SquareRoundCornerIcon",
	cursor: "Cursor01Icon",
	"ease-curve": "EaseCurveControlPointsIcon",
	enlarge: "ArrowExpandIcon",
	"eye-off": "ViewOffIcon",
	"fast-forward": "Forward01Icon",
	"film-cut": "ClapperboardIcon",
	"flip-horizontal-2": "FlipHorizontalIcon",
	"flip-vertical-2": "FlipVerticalIcon",
	"folder-down": "FolderDownloadIcon",
	"folder-open": "FolderOpenIcon",
	gear: "Settings01Icon",
	"grip-vertical": "DragDropVerticalIcon",
	hotkeys: "KeyboardIcon",
	"image-off": "ImageNotFound01Icon",
	instant: "ZapIcon",
	layout: "Layout01Icon",
	"message-bubble": "BubbleChatIcon",
	"message-square-plus": "MessageAdd01Icon",
	"mic-off": "MicOff01Icon",
	microphone: "Mic01Icon",
	"monitor-outline": "MonitorIcon",
	"more-horizontal": "MoreHorizontalIcon",
	"more-vertical": "MoreVerticalIcon",
	"mouse-pointer-2": "Cursor02Icon",
	"mouse-pointer-ban": "CursorDisabled01Icon",
	"mouse-pointer-click": "MousePointerClickIcon",
	next: "NextIcon",
	"panel-right": "SidebarRightIcon",
	padding: "SquareSquareIcon",
	"pause-circle": "PauseCircleIcon",
	"person-standing": "PersonStandingIcon",
	"play-circle": "PlayCircleIcon",
	presets: "WandSparklesIcon",
	prev: "PreviousIcon",
	"record-fill": "RecordIcon",
	"rectangle-horizontal": "RectangleHorizontalIcon",
	"refresh-cw": "RefreshIcon",
	restart: "RefreshIcon",
	"rotate-3d": "Rotate360Icon",
	"rotate-ccw": "RotateLeft01Icon",
	"rotate-cw": "RotateRight01Icon",
	"scan-text": "ScanTextIcon",
	screen: "MonitorIcon",
	screenshot: "ScissorRectangleIcon",
	"settings-2": "Settings02Icon",
	shadow: "SquareStackIcon",
	"sliders-horizontal": "Settings03Icon",
	"square-play": "PlaySquareIcon",
	"stop-circle": "StopCircleIcon",
	"triangle-alert": "Alert02Icon",
	"upload-arrow": "Upload01Icon",
	"user-round": "UserRoundIcon",
	"volume-2": "VolumeHighIcon",
	"volume-x": "VolumeOffIcon",
	"warning-bold": "Alert01Icon",
	window: "AppWindowIcon",
	"x-mark": "Cancel01Icon",
	x: "Cancel01Icon",
	"zoom-in": "ZoomInIcon",
	"zoom-out": "ZoomOutIcon",
};

type IconNode = [string, Record<string, string>, ...IconNode[][]];

function xml(node: IconNode): string {
	const [tag, attributes, children] = node;
	const props = Object.entries(attributes)
		.filter(([name]) => name !== "key")
		.map(([name, value]) => {
			const attribute = name.replace(
				/[A-Z]/g,
				(letter) => `-${letter.toLowerCase()}`,
			);
			return ` ${attribute}="${value.replaceAll("&", "&amp;").replaceAll('"', "&quot;")}"`;
		})
		.join("");
	return children?.length
		? `<${tag}${props}>${children.map(xml).join("")}</${tag}>`
		: `<${tag}${props}/>`;
}

const filenames = (await readdir(directory))
	.filter((name) => name.endsWith(".svg") && !preserved.has(name))
	.sort();
const resolved = filenames.map((filename) => {
	const stem = filename.slice(0, -4);
	const guessed = `${stem.replace(/(^|-)([a-z0-9])/g, (_, _separator, letter: string) => letter.toUpperCase())}Icon`;
	const name = aliases[stem] ?? guessed;
	const icon = (icons as Record<string, IconNode[]>)[name];
	return { filename, name, icon };
});
const missing = resolved.filter(({ icon }) => !Array.isArray(icon));
if (missing.length) {
	throw new Error(
		`Unmapped Hugeicons: ${missing.map(({ filename, name }) => `${filename} -> ${name}`).join(", ")}`,
	);
}

const check = process.argv.includes("--check");
const dryRun = process.argv.includes("--dry-run");
const mismatches: string[] = [];
for (const { filename, icon } of resolved) {
	const content = `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">${icon.map(xml).join("")}</svg>\n`;
	const path = fileURLToPath(
		new URL(`../assets/icons/${filename}`, import.meta.url),
	);
	if (check) {
		if ((await readFile(path, "utf8")) !== content) mismatches.push(filename);
	} else if (!dryRun) {
		await writeFile(path, content);
	}
}
if (mismatches.length)
	throw new Error(`Outdated Hugeicons: ${mismatches.join(", ")}`);
console.log(
	`${resolved.length} official free Stroke Rounded icons ${check ? "verified" : dryRun ? "mapped" : "generated"}`,
);
