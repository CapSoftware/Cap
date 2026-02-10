import type { ProjectConfiguration } from "../types/project-config";
import { resolveBackgroundAssetPath } from "./backgrounds";

export function normalizeProjectForSave(
	project: ProjectConfiguration,
): ProjectConfiguration {
	const source = project.background.source;
	if (
		(source.type !== "wallpaper" && source.type !== "image") ||
		!source.path
	) {
		return project;
	}

	const normalizedPath = resolveBackgroundAssetPath(source.path);
	if (
		normalizedPath.startsWith("http://") ||
		normalizedPath.startsWith("https://") ||
		normalizedPath.startsWith("data:")
	) {
		return project;
	}

	const absolutePath =
		typeof window === "undefined"
			? normalizedPath
			: new URL(normalizedPath, window.location.origin).toString();

	return {
		...project,
		background: {
			...project.background,
			source: {
				...source,
				path: absolutePath,
			},
		},
	};
}
