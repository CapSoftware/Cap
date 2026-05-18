import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

type JsonValue =
	| boolean
	| number
	| string
	| null
	| JsonValue[]
	| { [key: string]: JsonValue };

type JsonObject = { [key: string]: JsonValue };

export type DeviceItem = {
	key: string;
	title: string;
	subtitle: string;
	url: string;
	section: "Microphones" | "Cameras";
	kind: "microphone" | "camera";
};

export async function loadDeviceItems(): Promise<DeviceItem[]> {
	const [microphones, cameras] = await Promise.all([
		loadMicrophones(),
		loadCameras(),
	]);

	return [
		{
			key: "microphone-off",
			title: "Disable Microphone",
			subtitle: "cap-desktop://device/microphone?off=true",
			url: "cap-desktop://device/microphone?off=true",
			section: "Microphones",
			kind: "microphone",
		},
		...microphones,
		{
			key: "camera-off",
			title: "Disable Camera",
			subtitle: "cap-desktop://device/camera?off=true",
			url: "cap-desktop://device/camera?off=true",
			section: "Cameras",
			kind: "camera",
		},
		...cameras,
	];
}

async function loadMicrophones(): Promise<DeviceItem[]> {
	const json = await readSystemProfilerJson("SPAudioDataType");
	const seen = new Set<string>();
	const items: DeviceItem[] = [];

	for (const object of collectObjects(json)) {
		const title = readName(object);
		if (!title) continue;
		if (hasChildObjects(object)) continue;
		if (!looksLikeMicrophone(object, title)) continue;
		if (seen.has(title)) continue;
		seen.add(title);

		items.push({
			key: `microphone:${title}`,
			title,
			subtitle: `cap-desktop://device/microphone?label=${encodeURIComponent(title)}`,
			url: `cap-desktop://device/microphone?label=${encodeURIComponent(title)}`,
			section: "Microphones",
			kind: "microphone",
		});
	}

	return items.sort((left, right) => left.title.localeCompare(right.title));
}

async function loadCameras(): Promise<DeviceItem[]> {
	const json = await readSystemProfilerJson("SPCameraDataType");
	const seen = new Set<string>();
	const items: DeviceItem[] = [];

	for (const object of collectObjects(json)) {
		const title = readName(object);
		if (!title) continue;
		if (hasChildObjects(object)) continue;

		const modelId = readModelId(object);
		const deviceId = readDeviceId(object);
		if (!looksLikeCamera(object, title, modelId, deviceId)) continue;

		const url = buildCameraUrl(title, modelId, deviceId);
		if (!url) continue;
		if (seen.has(url)) continue;
		seen.add(url);

		items.push({
			key: `camera:${url}`,
			title,
			subtitle: url,
			url,
			section: "Cameras",
			kind: "camera",
		});
	}

	return items.sort((left, right) => left.title.localeCompare(right.title));
}

async function readSystemProfilerJson(dataType: string): Promise<JsonValue> {
	const { stdout } = await execFileAsync(
		"system_profiler",
		["-json", dataType],
		{ maxBuffer: 16 * 1024 * 1024 },
	);

	return JSON.parse(stdout) as JsonValue;
}

function collectObjects(
	value: JsonValue,
	objects: JsonObject[] = [],
): JsonObject[] {
	if (Array.isArray(value)) {
		for (const item of value) collectObjects(item, objects);
		return objects;
	}

	if (!isObject(value)) return objects;

	objects.push(value);

	for (const child of Object.values(value)) {
		collectObjects(child, objects);
	}

	return objects;
}

function isObject(value: JsonValue): value is JsonObject {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasChildObjects(object: JsonObject): boolean {
	return Object.values(object).some(
		(value) =>
			isObject(value) ||
			(Array.isArray(value) && value.some((item) => isObject(item))),
	);
}

function readName(object: JsonObject): string | undefined {
	const name = readString(object, ["_name", "name", "display_name"]);
	if (!name) return undefined;
	const trimmed = name.trim();
	return trimmed.length > 0 ? trimmed : undefined;
}

function looksLikeMicrophone(object: JsonObject, title: string): boolean {
	const lowerTitle = title.toLowerCase();
	if (lowerTitle.includes("microphone")) return true;

	return Object.entries(object).some(
		([key, value]) =>
			key.toLowerCase().includes("input") &&
			typeof value === "string" &&
			isTruthyFlag(value),
	);
}

function looksLikeCamera(
	object: JsonObject,
	title: string,
	modelId: string | undefined,
	deviceId: string | undefined,
): boolean {
	if (modelId || deviceId) return true;
	if (title.toLowerCase().includes("camera")) return true;

	return Object.keys(object).some((key) =>
		key.toLowerCase().includes("camera"),
	);
}

function buildCameraUrl(
	title: string,
	modelId: string | undefined,
	deviceId: string | undefined,
): string | undefined {
	if (modelId) {
		return `cap-desktop://device/camera?model_id=${encodeURIComponent(modelId)}`;
	}

	if (deviceId) {
		return `cap-desktop://device/camera?device_id=${encodeURIComponent(deviceId)}`;
	}

	if (title.length > 0) {
		return `cap-desktop://device/camera?label=${encodeURIComponent(title)}`;
	}

	return undefined;
}

function readModelId(object: JsonObject): string | undefined {
	for (const value of Object.values(object)) {
		if (typeof value !== "string") continue;
		const directMatch = value.match(/\b[0-9a-fA-F]{4}:[0-9a-fA-F]{4}\b/);
		if (directMatch) return directMatch[0].toLowerCase();
	}

	const vendor = readHexId(object, ["vendor", "vid"]);
	const product = readHexId(object, ["product", "pid"]);
	if (vendor && product) {
		return `${vendor}:${product}`.toLowerCase();
	}

	return undefined;
}

function readDeviceId(object: JsonObject): string | undefined {
	for (const [key, value] of Object.entries(object)) {
		if (typeof value !== "string") continue;
		const lowerKey = key.toLowerCase();
		if (!lowerKey.includes("id")) continue;
		if (lowerKey.includes("model")) continue;
		if (lowerKey.includes("vendor")) continue;
		if (lowerKey.includes("product")) continue;
		if (!lowerKey.includes("unique") && !lowerKey.includes("device")) continue;
		const trimmed = value.trim();
		if (trimmed.length > 0) return trimmed;
	}

	return undefined;
}

function readHexId(
	object: JsonObject,
	fragments: string[],
): string | undefined {
	for (const [key, value] of Object.entries(object)) {
		if (typeof value !== "string") continue;
		const lowerKey = key.toLowerCase();
		if (!fragments.some((fragment) => lowerKey.includes(fragment))) continue;
		if (!lowerKey.includes("id")) continue;

		const match = value.match(/[0-9a-fA-F]{4}\b/g);
		if (match && match.length > 0) {
			return match[match.length - 1];
		}
	}

	return undefined;
}

function readString(object: JsonObject, keys: string[]): string | undefined {
	for (const key of keys) {
		const value = object[key];
		if (typeof value === "string") return value;
	}

	const loweredKeys = keys.map((key) => key.toLowerCase());
	for (const [key, value] of Object.entries(object)) {
		if (typeof value !== "string") continue;
		if (loweredKeys.includes(key.toLowerCase())) return value;
	}

	return undefined;
}

function isTruthyFlag(value: string): boolean {
	return ["true", "yes", "1", "spaudio_yes"].includes(value.toLowerCase());
}
