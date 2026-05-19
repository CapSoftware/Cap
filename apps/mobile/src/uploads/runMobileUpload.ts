import { Folder, Organisation } from "@cap/web-domain";
import type { MobileApiClient, UploadFile } from "@/api/mobile";
import { uploadToTarget } from "@/api/mobile";

type RunMobileUploadInput = {
	client: MobileApiClient;
	file: UploadFile;
	organizationId?: string | null;
	folderId?: string | null;
	onCreated?: (capId: string, rawFileKey: string) => void;
	onProgress?: (progress: number) => void;
};

const nonNegativeFiniteNumber = (value: number | null | undefined) =>
	typeof value === "number" && Number.isFinite(value) ? Math.max(0, value) : 0;

const positiveFiniteNumber = (value: number | null | undefined) =>
	typeof value === "number" && Number.isFinite(value) && value > 0
		? value
		: null;

const clampProgress = (progress: number) => {
	const safeProgress = Number.isFinite(progress) ? progress : 0;
	return Math.min(1, Math.max(0, safeProgress));
};

export const runMobileUpload = async ({
	client,
	file,
	organizationId,
	folderId,
	onCreated,
	onProgress,
}: RunMobileUploadInput) => {
	const created = await client.createUpload({
		organizationId: organizationId
			? Organisation.OrganisationId.make(organizationId)
			: undefined,
		folderId: folderId ? Folder.FolderId.make(folderId) : undefined,
		fileName: file.name,
		contentType: file.type,
		contentLength: file.size,
		durationSeconds: file.durationSeconds,
		width: file.width,
		height: file.height,
	});
	onCreated?.(created.id, created.rawFileKey);

	await uploadToTarget(created.upload, file, ({ loaded, total }) => {
		const safeLoaded = nonNegativeFiniteNumber(loaded);
		const safeTotal =
			positiveFiniteNumber(total) ??
			positiveFiniteNumber(file.size) ??
			safeLoaded;
		const progress = safeTotal > 0 ? safeLoaded / safeTotal : 0;
		onProgress?.(clampProgress(progress));
		client
			.updateUploadProgress(created.id, {
				uploaded: safeLoaded,
				total: safeTotal,
			})
			.catch(() => {});
	});

	await client.completeUpload(created.id, {
		rawFileKey: created.rawFileKey,
		contentLength: file.size,
	});

	return created;
};
