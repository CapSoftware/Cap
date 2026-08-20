"use client";

import type { Organisation } from "@cap/web-domain";
import { Effect, Option } from "effect";
import { useRouter } from "next/navigation";
import { useId } from "react";
import { toast } from "sonner";
import { FileInput } from "@/components/FileInput";
import { useEffectMutation, useRpcClient } from "@/lib/EffectRuntime";
import { useDashboardContext } from "../../../Contexts";
import { SettingRow } from "./SettingsRows";

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
			toast.success("Organization icon updated successfully");
			router.refresh();
		},
		onError: (error) => {
			toast.error(
				error instanceof Error ? error.message : "Failed to upload icon",
			);
		},
	});

	const removeIcon = useEffectMutation({
		mutationFn: (organizationId: Organisation.OrganisationId) =>
			rpc.OrganisationUpdate({
				id: organizationId,
				image: Option.none(),
			}),
		onSuccess: () => {
			toast.success("Organization icon removed successfully");
			router.refresh();
		},
		onError: (error) => {
			console.error("Error removing organization icon:", error);
			toast.error(
				error instanceof Error ? error.message : "Failed to remove icon",
			);
		},
	});

	return (
		<SettingRow
			label="Icon"
			description="Upload a custom logo or icon for your organization."
			control={
				<FileInput
					className="w-[248px] max-w-full"
					height={36}
					previewIconSize={18}
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
					maxFileSizeBytes={1 * 1024 * 1024}
				/>
			}
		/>
	);
};
