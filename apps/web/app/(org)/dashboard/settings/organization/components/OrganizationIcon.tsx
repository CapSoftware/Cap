"use client";

import { CardDescription, Label } from "@cap/ui";
import { Effect } from "effect";
import { useRouter } from "next/navigation";
import { useId, useState } from "react";
import { toast } from "sonner";
import { FileInput } from "@/components/FileInput";
import * as EffectRuntime from "@/lib/EffectRuntime";
import { withRpc } from "@/lib/Rpcs";
import { useDashboardContext } from "../../../Contexts";

export const OrganizationIcon = () => {
	const router = useRouter();
	const iconInputId = useId();
	const { activeOrganization } = useDashboardContext();
	const organizationId = activeOrganization?.organization.id;
	const existingIconUrl = activeOrganization?.organization.iconUrl ?? null;

	const [isUploading, setIsUploading] = useState(false);

	const handleFileChange = async (file: File | null) => {
		// If file is null, it means the user removed the file
		if (!file || !organizationId) return;

		// Upload the file to the server immediately
		try {
			setIsUploading(true);

			const arrayBuffer = await file.arrayBuffer();
			const data = new Uint8Array(arrayBuffer);

			await EffectRuntime.EffectRuntime.runPromise(
				withRpc((rpc) =>
					rpc.UploadImage({
						data,
						contentType: file.type,
						fileName: file.name,
						type: "organization" as const,
						entityId: organizationId,
						oldImageKey: existingIconUrl,
					}),
				).pipe(
					Effect.tap(() =>
						Effect.sync(() => {
							toast.success("Organization icon updated successfully");
							router.refresh();
						}),
					),
				),
			);
		} catch (error) {
			toast.error(
				error instanceof Error ? error.message : "Failed to upload icon",
			);
		} finally {
			setIsUploading(false);
		}
	};

	const handleRemoveIcon = async () => {
		if (!organizationId) return;

		try {
			await EffectRuntime.EffectRuntime.runPromise(
				withRpc((rpc) =>
					rpc.RemoveImage({
						imageKey: existingIconUrl || "",
						type: "organization" as const,
						entityId: organizationId,
					}),
				).pipe(
					Effect.tap(() =>
						Effect.sync(() => {
							toast.success("Organization icon removed successfully");
							router.refresh();
						}),
					),
				),
			);
		} catch (error) {
			console.error("Error removing organization icon:", error);
			toast.error(
				error instanceof Error ? error.message : "Failed to remove icon",
			);
		}
	};

	return (
		<div className="flex-1 space-y-4">
			<div className="space-y-1">
				<Label htmlFor="icon">Organization Icon</Label>
				<CardDescription className="w-full">
					Upload a custom logo or icon for your organization.
				</CardDescription>
			</div>
			<FileInput
				height={44}
				previewIconSize={20}
				id={iconInputId}
				name="icon"
				type="organization"
				onChange={handleFileChange}
				disabled={isUploading}
				isLoading={isUploading}
				initialPreviewUrl={existingIconUrl}
				onRemove={handleRemoveIcon}
				maxFileSizeBytes={1 * 1024 * 1024} // 1MB
			/>
		</div>
	);
};
