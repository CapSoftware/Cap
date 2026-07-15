"use client";

import { CardDescription, Label } from "@cap/ui";
import type { Organisation } from "@cap/web-domain";
import { Effect, Option } from "effect";
import { useRouter } from "next/navigation";
import { useId } from "react";
import { toast } from "sonner";
import { FileInput } from "@/components/FileInput";
import { useEffectMutation, useRpcClient } from "@/lib/EffectRuntime";
import { useDashboardContext } from "../../../Contexts";

export const OrganizationIcon = () => {
	const router = useRouter();
	const iconInputId = useId();
	const { activeOrganization } = useDashboardContext();
	const organizationId = activeOrganization?.organization.id;
	const existingIconUrl = activeOrganization?.organization.iconUrl ?? null;

	const rpc = useRpcClient();

	const uploadIcon = useEffectMutation({
		mutationFn: Effect.fn(function* ({
			file,
			organizationId,
		}: {
			organizationId: Organisation.OrganisationId;
			file: File;
		}) {
			const arrayBuffer = yield* Effect.promise(() => file.arrayBuffer());

			yield* rpc.OrganisationUpdate({
				id: organizationId,
				image: Option.some({
					contentType: file.type,
					fileName: file.name,
					data: new Uint8Array(arrayBuffer),
				}),
			});
		}),
		onSuccess: () => {
			toast.success("组织图标已更新");
			router.refresh();
		},
		onError: (error) => {
			toast.error(error instanceof Error ? error.message : "上传图标失败");
		},
	});

	const removeIcon = useEffectMutation({
		mutationFn: (organizationId: Organisation.OrganisationId) =>
			rpc.OrganisationUpdate({
				id: organizationId,
				image: Option.none(),
			}),
		onSuccess: () => {
			toast.success("组织图标已移除");
			router.refresh();
		},
		onError: (error) => {
			console.error("Error removing organization icon:", error);
			toast.error(error instanceof Error ? error.message : "移除图标失败");
		},
	});

	return (
		<div className="flex-1 space-y-4">
			<div className="space-y-1">
				<Label htmlFor="icon">组织图标</Label>
				<CardDescription className="w-full">
					为组织上传自定义徽标或图标。
				</CardDescription>
			</div>
			<FileInput
				height={44}
				previewIconSize={20}
				id={iconInputId}
				name="icon"
				onChange={(file) => {
					if (!file || !organizationId) return;
					uploadIcon.mutate({ organizationId, file });
				}}
				disabled={uploadIcon.isPending}
				isLoading={uploadIcon.isPending}
				initialPreviewUrl={existingIconUrl}
				onRemove={() => {
					if (!organizationId) return;
					removeIcon.mutate(organizationId);
				}}
				maxFileSizeBytes={1 * 1024 * 1024} // 1MB
			/>
		</div>
	);
};
