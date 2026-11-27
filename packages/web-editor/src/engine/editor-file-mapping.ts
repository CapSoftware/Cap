const importedImages = new Map<string, string>();
const projectImagePath =
	/^content\/images\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(png|jpg|webp|gif|bmp|tiff)$/;

function asRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function registerEditorImportedImage(
	localPath: string,
	projectPath: string,
) {
	if (
		(!localPath.startsWith("cap-web-editor://app-data/") &&
			!projectImagePath.test(localPath)) ||
		!projectImagePath.test(projectPath)
	) {
		throw new Error("Invalid browser editor image mapping");
	}
	importedImages.set(localPath, projectPath);
}

export function clearEditorImportedImages() {
	importedImages.clear();
}

export function resolveEditorImportedImage(path: string) {
	return importedImages.get(path) ?? path;
}

function mapBackground(background: unknown) {
	if (!asRecord(background) || !asRecord(background.source)) return background;
	const source = background.source;
	if (source.type !== "image" || typeof source.path !== "string") {
		return background;
	}
	const path = resolveEditorImportedImage(source.path);
	return path === source.path
		? background
		: { ...background, source: { ...source, path } };
}

export function mapEditorImportedImages(config: unknown) {
	if (!asRecord(config)) return config;
	const background = mapBackground(config.background);
	let timeline = config.timeline;
	if (asRecord(timeline) && Array.isArray(timeline.styleSegments)) {
		const styleSegments = timeline.styleSegments.map((segment) => {
			if (!asRecord(segment) || !asRecord(segment.overrides)) return segment;
			const overrides = segment.overrides;
			const mapped = mapBackground(overrides.background);
			return mapped === overrides.background
				? segment
				: { ...segment, overrides: { ...overrides, background: mapped } };
		});
		timeline = { ...timeline, styleSegments };
	}
	return background === config.background && timeline === config.timeline
		? config
		: { ...config, background, timeline };
}

export function serializeEditorProjectSnapshot(serialized: string) {
	const config: unknown = JSON.parse(serialized);
	return JSON.stringify(mapEditorImportedImages(config));
}
