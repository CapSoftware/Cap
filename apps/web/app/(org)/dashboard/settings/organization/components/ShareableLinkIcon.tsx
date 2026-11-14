"use client";

import { Switch } from "@cap/ui";
import type { Organisation } from "@cap/web-domain";
import { useMutation } from "@tanstack/react-query";
import { useRouter } from "next/navigation";
import { useEffect, useId, useState } from "react";
import { toast } from "sonner";
import {
	removeShareableLinkIcon,
	updateShareableLinkIconPreference,
	uploadShareableLinkIcon,
} from "@/actions/organization/shareable-link-icon";
import { FileInput } from "@/components/FileInput";
import { UpgradeModal } from "@/components/UpgradeModal";
import { useDashboardContext } from "../../../Contexts";
import { ProChip, SettingsRow } from "../_components/settings-ui";

export const ShareableLinkIcon = () => {
	const router = useRouter();
	const iconInputId = useId();
	const { activeOrganization, user } = useDashboardContext();
	const [showUpgradeModal, setShowUpgradeModal] = useState(false);
	const organization = activeOrganization?.organization;
	const organizationId = organization?.id;
	const hasOrganizationIcon = Boolean(organization?.iconUrl);
	const existingIconUrl = organization?.shareableLinkIconUrl ?? null;
	const [useOrganizationIcon, setUseOrganizationIcon] = useState(
		Boolean(organization?.settings?.shareableLinkUseOrganizationIcon),
	);

	useEffect(() => {
		setUseOrganizationIcon(
			Boolean(organization?.settings?.shareableLinkUseOrganizationIcon),
		);
	}, [organization?.settings?.shareableLinkUseOrganizationIcon]);

	const uploadIcon = useMutation({
		mutationFn: async ({
			file,
			organizationId,
		}: {
			organizationId: Organisation.OrganisationId;
			file: File;
		}) => {
			const formData = new FormData();
			formData.append("organizationId", organizationId);
			formData.append("icon", file);
			return uploadShareableLinkIcon(formData);
		},
		onSuccess: () => {
			toast.success("Shareable link icon updated successfully");
			router.refresh();
		},
		onError: (error) => {
			toast.error(
				error instanceof Error
					? error.message
					: "Failed to upload shareable link icon",
			);
		},
	});

	const removeIcon = useMutation({
		mutationFn: (organizationId: Organisation.OrganisationId) =>
			removeShareableLinkIcon(organizationId),
		onSuccess: () => {
			toast.success("Shareable link icon removed successfully");
			router.refresh();
		},
		onError: (error) => {
			toast.error(
				error instanceof Error
					? error.message
					: "Failed to remove shareable link icon",
			);
		},
	});

	const updateIconPreference = useMutation({
		mutationFn: ({
			organizationId,
			useOrganizationIcon,
		}: {
			organizationId: Organisation.OrganisationId;
			useOrganizationIcon: boolean;
		}) =>
			updateShareableLinkIconPreference({
				organizationId,
				useOrganizationIcon,
			}),
		onSuccess: () => {
			toast.success("Shareable link icon preference updated");
			router.refresh();
		},
		onError: (error) => {
			setUseOrganizationIcon(
				Boolean(organization?.settings?.shareableLinkUseOrganizationIcon),
			);
			toast.error(
				error instanceof Error
					? error.message
					: "Failed to update shareable link icon preference",
			);
		},
	});

	const isMutating =
		uploadIcon.isPending ||
		removeIcon.isPending ||
		updateIconPreference.isPending;
	const useOrganizationIconChecked = useOrganizationIcon && hasOrganizationIcon;

	return (
		<>
			<SettingsRow
				title={<label htmlFor={iconInputId}>Shareable link icon</label>}
				meta={<ProChip />}
				description="Use a custom logo or icon on your shareable link pages."
				control={
					<FileInput
						className="w-full sm:w-60"
						height={36}
						previewIconSize={20}
						id={iconInputId}
						name="shareable-link-icon"
						onChange={(file) => {
							if (!file || !organizationId) return;
							if (!user.isPro) {
								setShowUpgradeModal(true);
								return;
							}
							uploadIcon.mutate({ organizationId, file });
						}}
						disabled={!user.isPro || useOrganizationIconChecked || isMutating}
						isLoading={uploadIcon.isPending}
						initialPreviewUrl={
							useOrganizationIconChecked
								? (organization?.iconUrl ?? null)
								: existingIconUrl
						}
						onRemove={() => {
							if (!organizationId) return;
							if (!user.isPro) {
								setShowUpgradeModal(true);
								return;
							}
							removeIcon.mutate(organizationId);
						}}
						maxFileSizeBytes={1024 * 1024}
					/>
				}
			/>
			<SettingsRow
				title="Use organization icon"
				description="Use the organization icon on shareable links when one is available."
				control={
					<Switch
						disabled={!user.isPro || !hasOrganizationIcon || isMutating}
						checked={useOrganizationIconChecked}
						onCheckedChange={(checked) => {
							if (!organizationId) return;
							if (!user.isPro) {
								setShowUpgradeModal(true);
								return;
							}

							setUseOrganizationIcon(checked);
							updateIconPreference.mutate({
								organizationId,
								useOrganizationIcon: checked,
							});
						}}
					/>
				}
			/>
			<UpgradeModal
				open={showUpgradeModal}
				onOpenChange={setShowUpgradeModal}
			/>
		</>
	);
};
