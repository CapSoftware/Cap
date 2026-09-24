import { rm } from "node:fs/promises";
import { join } from "node:path";
import {
	CAP_BUNDLE_CONTENT_TYPE,
	MAX_CAP_BUNDLE_BYTES,
} from "@cap/editor-cap-bundle";
import { extractEditorCapBundle } from "./editor-cap-bundle";
import {
	type SignedEditorAsset,
	stageSignedEditorAsset,
} from "./editor-signed-assets";

const CAP_BUNDLE_PATH =
	/^content\/imports\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.capbundle$/;
const CAP_BUNDLE_DOWNLOAD_TIMEOUT_MS = 30 * 60 * 1000;

export type EditorCapAsset = SignedEditorAsset;

export function validateEditorCapAsset(asset: EditorCapAsset) {
	const url = new URL(asset.url);
	if (
		!CAP_BUNDLE_PATH.test(asset.path) ||
		asset.contentType !== CAP_BUNDLE_CONTENT_TYPE ||
		!Number.isSafeInteger(asset.size) ||
		asset.size <= 0 ||
		asset.size > MAX_CAP_BUNDLE_BYTES ||
		asset.name.length < 1 ||
		asset.name.length > 100 ||
		asset.name.split("").some((character) => {
			const code = character.charCodeAt(0);
			return (
				code < 32 || code === 127 || character === "/" || character === "\\"
			);
		}) ||
		(url.protocol !== "https:" &&
			!(
				url.protocol === "http:" &&
				process.env.CAP_WEB_EDITOR_ALLOW_HTTP_MEDIA === "1"
			)) ||
		url.username ||
		url.password ||
		(asset.objectIdentity != null &&
			(asset.objectIdentity.length < 1 || asset.objectIdentity.length > 256))
	) {
		throw new Error("Invalid editor Cap project asset");
	}
}

export async function stageSignedEditorCapAsset(
	projectPath: string,
	asset: EditorCapAsset,
	abortSignal?: AbortSignal,
) {
	validateEditorCapAsset(asset);
	const bundlePath = join(projectPath, asset.path);
	await stageSignedEditorAsset(
		projectPath,
		asset,
		async () => ({}),
		abortSignal,
		CAP_BUNDLE_DOWNLOAD_TIMEOUT_MS,
	);
	try {
		const extracted = await extractEditorCapBundle(bundlePath, abortSignal);
		return {
			path: extracted.path,
			cleanup: async () => {
				await extracted.cleanup();
				await rm(bundlePath, { force: true });
			},
		};
	} catch (error) {
		await rm(bundlePath, { force: true });
		throw error;
	}
}
