"use client";

import { CardDescription, Label, Switch } from "@cap/ui";
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
			toast.success("分享链接图标已更新");
			router.refresh();
		},
		onError: (error) => {
			toast.error(
				error instanceof Error ? error.message : "上传分享链接图标失败",
			);
		},
	});

	const removeIcon = useMutation({
		mutationFn: (organizationId: Organisation.OrganisationId) =>
			removeShareableLinkIcon(organizationId),
		onSuccess: () => {
			toast.success("分享链接图标已移除");
			router.refresh();
		},
		onError: (error) => {
			toast.error(
				error instanceof Error ? error.message : "移除分享链接图标失败",
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
			toast.success("分享链接图标偏好已更新");
			router.refresh();
		},
		onError: (error) => {
			setUseOrganizationIcon(
				Boolean(organization?.settings?.shareableLinkUseOrganizationIcon),
			);
			toast.error(
				error instanceof Error ? error.message : "更新分享链接图标偏好失败",
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
			<div className="flex-1 space-y-4">
				<div className="space-y-1">
					<div className="flex gap-1.5 items-center">
						<Label htmlFor={iconInputId}>分享链接图标</Label>
						<p className="py-1 px-1.5 text-[10px] leading-none font-medium rounded-full text-white bg-blue-11">
							Pro
						</p>
					</div>
					<CardDescription className="w-full">
						在分享链接页面使用自定义徽标或图标。
					</CardDescription>
				</div>
				<div className="flex items-center justify-between gap-4 rounded-xl border border-gray-3 bg-gray-2 p-4">
					<div className="space-y-1">
						<p className="text-sm text-gray-12">使用组织图标</p>
						<p className="text-xs text-gray-10">组织图标可用时使用该图标。</p>
					</div>
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
				</div>
				<FileInput
					height={44}
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
			</div>
			<UpgradeModal
				open={showUpgradeModal}
				onOpenChange={setShowUpgradeModal}
			/>
		</>
	);
};
