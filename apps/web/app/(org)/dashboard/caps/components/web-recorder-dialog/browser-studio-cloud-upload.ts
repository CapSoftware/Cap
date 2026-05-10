"use client";

import {
	BROWSER_STUDIO_MANIFEST_SUBPATH,
	type BrowserStudioCloudManifest,
	type BrowserStudioManifestAsset,
	createDefaultBrowserStudioEdit,
} from "@/lib/browser-studio";
import { contentTypeForSubpath } from "@/lib/upload-content-type";
import { uploadWithTarget } from "@/utils/upload-target";
import type {
	BrowserStudioVaultAsset,
	BrowserStudioVaultSession,
} from "./browser-studio-vault";

type UploadTargetInput = Parameters<typeof uploadWithTarget>[0]["target"];

export type BrowserStudioCloudManifestAsset = BrowserStudioVaultAsset &
	BrowserStudioManifestAsset & {
		sourceSubpath: string;
	};

export type BrowserStudioSourceAssetUpload = {
	subpath: string;
	blob: Blob;
	fileName: string;
};

type SignedUploadBatchResponse = {
	uploads: Record<string, UploadTargetInput>;
};

const uploadBlobThroughServer = async ({
	videoId,
	subpath,
	blob,
	contentType,
}: {
	videoId: string;
	subpath: string;
	blob: Blob;
	contentType: string;
}) => {
	const response = await fetch(
		`/api/upload/signed/proxy?videoId=${encodeURIComponent(
			videoId,
		)}&subpath=${encodeURIComponent(subpath)}`,
		{
			method: "POST",
			headers: {
				"Content-Type": contentType,
			},
			credentials: "same-origin",
			body: blob,
		},
	);

	if (!response.ok) {
		throw new Error(`Studio proxy upload failed with ${response.status}`);
	}
};

export const getBrowserStudioManifestSubpath = () =>
	BROWSER_STUDIO_MANIFEST_SUBPATH;

export const buildBrowserStudioCloudManifest = ({
	videoId,
	session,
	sourceSubpath,
	assetSourceSubpaths,
}: {
	videoId: string;
	session: BrowserStudioVaultSession;
	sourceSubpath: string;
	assetSourceSubpaths?: Record<string, string>;
}): BrowserStudioCloudManifest => ({
	schemaVersion: 1,
	videoId,
	sessionId: session.sessionId,
	source: "browser-studio-vault",
	createdAt: session.createdAt,
	updatedAt: session.updatedAt,
	browser: session.browser,
	project: session.project,
	assets: session.assets.map((asset) => ({
		...asset,
		sourceSubpath: assetSourceSubpaths?.[asset.assetId] ?? sourceSubpath,
	})),
	totalBytes: session.totalBytes,
	chunkCount: session.chunkCount,
	edit: createDefaultBrowserStudioEdit(session.project.timeline.durationMs),
});

const requestSignedUploads = async (videoId: string, subpaths: string[]) => {
	const response = await fetch("/api/upload/signed/batch", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		credentials: "same-origin",
		body: JSON.stringify({ videoId, subpaths }),
	});

	if (!response.ok) {
		throw new Error(`Studio manifest signing failed with ${response.status}`);
	}

	const payload = (await response.json()) as SignedUploadBatchResponse;
	return payload.uploads;
};

export const getBrowserStudioAssetSourceSubpath = ({
	assetId,
	fileExtension,
}: {
	assetId: string;
	fileExtension: string;
}) => `studio/assets/${assetId}.${fileExtension}`;

export const uploadBrowserStudioSourceAssets = async ({
	videoId,
	assets,
	upload = uploadWithTarget,
	useServerProxy,
}: {
	videoId: string;
	assets: BrowserStudioSourceAssetUpload[];
	upload?: typeof uploadWithTarget;
	useServerProxy?: boolean;
}) => {
	if (assets.length === 0) return;

	if (useServerProxy) {
		await Promise.all(
			assets.map((asset) =>
				uploadBlobThroughServer({
					videoId,
					subpath: asset.subpath,
					blob: asset.blob,
					contentType: asset.blob.type || contentTypeForSubpath(asset.subpath),
				}),
			),
		);
		return;
	}

	const uploads = await requestSignedUploads(
		videoId,
		assets.map((asset) => asset.subpath),
	);

	await Promise.all(
		assets.map((asset) => {
			const target = uploads[asset.subpath];
			if (!target) {
				throw new Error(
					`Studio source upload target missing: ${asset.subpath}`,
				);
			}

			return upload({
				target,
				body: asset.blob,
				fileName: asset.fileName,
			});
		}),
	);
};

export const uploadBrowserStudioManifest = async ({
	videoId,
	session,
	sourceSubpath,
	assetSourceSubpaths,
	upload = uploadWithTarget,
	useServerProxy,
}: {
	videoId: string;
	session: BrowserStudioVaultSession;
	sourceSubpath: string;
	assetSourceSubpaths?: Record<string, string>;
	upload?: typeof uploadWithTarget;
	useServerProxy?: boolean;
}) => {
	const manifest = buildBrowserStudioCloudManifest({
		videoId,
		session,
		sourceSubpath,
		assetSourceSubpaths,
	});
	const blob = new Blob([JSON.stringify(manifest)], {
		type: "application/json",
	});

	if (useServerProxy) {
		await uploadBlobThroughServer({
			videoId,
			subpath: BROWSER_STUDIO_MANIFEST_SUBPATH,
			blob,
			contentType: "application/json",
		});
		return manifest;
	}

	const uploads = await requestSignedUploads(videoId, [
		BROWSER_STUDIO_MANIFEST_SUBPATH,
	]);
	const target = uploads[BROWSER_STUDIO_MANIFEST_SUBPATH];
	if (!target) {
		throw new Error("Studio manifest upload target missing");
	}

	await upload({
		target,
		body: blob,
		fileName: "manifest.json",
	});

	return manifest;
};
