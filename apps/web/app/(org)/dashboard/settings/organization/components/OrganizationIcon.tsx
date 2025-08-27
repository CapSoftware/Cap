"use client";

import { CardDescription, Label } from "@cap/ui";
import { useState } from "react";
import { toast } from "sonner";
import { removeOrganizationIcon } from "@/actions/organization/remove-icon";
import { uploadOrganizationIcon } from "@/actions/organization/upload-organization-icon";
import { FileInput } from "@/components/FileInput";
import { useDashboardContext } from "../../../Contexts";

export const OrganizationIcon = () => {
	const { activeOrganization } = useDashboardContext();
	const organizationId = activeOrganization?.organization.id;
	const existingIconUrl = activeOrganization?.organization.iconUrl;

	const [isUploading, setIsUploading] = useState(false);

	const handleFileChange = async (file: File | null) => {
		// If file is null, it means the user removed the file
		if (!file || !organizationId) return;

		// Upload the file to the server immediately
		try {
			setIsUploading(true);
			const formData = new FormData();
			formData.append("file", file);

			const result = await uploadOrganizationIcon(formData, organizationId);

			if (result.success) {
				toast.success("Organization icon updated successfully");
			}
		} catch (error) {
			console.error("Error uploading organization icon:", error);
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
			const result = await removeOrganizationIcon(organizationId);

			if (result.success) {
				toast.success("Organization icon removed successfully");
			}
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
				id="icon"
				name="icon"
				onChange={handleFileChange}
				disabled={isUploading}
				isLoading={isUploading}
				initialPreviewUrl={existingIconUrl || null}
				onRemove={handleRemoveIcon}
			/>
		</div>
	);
};
