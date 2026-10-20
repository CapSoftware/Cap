"use client";

import { useStore } from "@tanstack/react-store";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef } from "react";
import { toast } from "sonner";
import { useDashboardContext } from "../Contexts";
import { useUploadingContext } from "../caps/UploadingContext";
import { importMediaFile, isSupportedMediaFile } from "../import/import-media";

function isFile(file: File | null): file is File {
	return file !== null;
}

function getClipboardFiles(data: DataTransfer) {
	const filesFromItems = Array.from(data.items)
		.filter((item) => item.kind === "file")
		.map((item) => item.getAsFile())
		.filter(isFile);
	const filesFromList = Array.from(data.files);
	const seen = new Set<string>();

	return [...filesFromItems, ...filesFromList].filter((file) => {
		const key = `${file.name}:${file.size}:${file.type}:${file.lastModified}`;
		if (seen.has(key)) return false;
		seen.add(key);
		return true;
	});
}

function shouldIgnorePasteTarget(target: EventTarget | null) {
	if (!(target instanceof Element)) return false;
	return (
		target.closest(
			"input, textarea, select, [role='textbox'], [contenteditable]:not([contenteditable='false'])",
		) !== null
	);
}

export function DashboardPasteImport() {
	const router = useRouter();
	const { activeOrganization, setUpgradeModalOpen, user } =
		useDashboardContext();
	const { uploadingStore, setUploadStatus } = useUploadingContext();
	const isUploading = useStore(uploadingStore, (s) => !!s.uploadStatus);
	const handlingPasteRef = useRef(false);

	const handlePaste = useCallback(
		(event: ClipboardEvent) => {
			if (shouldIgnorePasteTarget(event.target)) return;

			const data = event.clipboardData;
			if (!data) return;

			const file = getClipboardFiles(data).find(isSupportedMediaFile);
			if (!file) return;

			event.preventDefault();

			if (!user.isPro) {
				setUpgradeModalOpen(true);
				return;
			}

			if (!activeOrganization) {
				toast.error("Select an organization before importing media.");
				return;
			}

			if (isUploading || handlingPasteRef.current) {
				toast.error(
					"Wait for the current upload to finish before importing another file.",
				);
				return;
			}

			handlingPasteRef.current = true;
			void importMediaFile({
				file,
				orgId: activeOrganization.organization.id,
				setUploadStatus,
			})
				.then((ok) => {
					if (ok) router.push("/dashboard/caps");
				})
				.finally(() => {
					handlingPasteRef.current = false;
				});
		},
		[
			activeOrganization,
			isUploading,
			router,
			setUploadStatus,
			setUpgradeModalOpen,
			user.isPro,
		],
	);

	useEffect(() => {
		window.addEventListener("paste", handlePaste);
		return () => window.removeEventListener("paste", handlePaste);
	}, [handlePaste]);

	return null;
}
