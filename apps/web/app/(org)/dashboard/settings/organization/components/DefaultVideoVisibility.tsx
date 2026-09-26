"use client";

import { Card, CardDescription, CardHeader, CardTitle, Switch } from "@cap/ui";
import { useRouter } from "next/navigation";
import { useEffect, useId, useState } from "react";
import { toast } from "sonner";
import {
	updateDefaultVideoVisibility,
	updateOrganizationVideoSharing,
} from "@/actions/organization/default-video-visibility";
import { useDashboardContext } from "../../../Contexts";

export const DefaultVideoVisibility = () => {
	const router = useRouter();
	const restrictionId = useId();
	const descriptionId = useId();
	const privateId = useId();
	const { activeOrganization } = useDashboardContext();
	const savedPrivate =
		activeOrganization?.organization.defaultVideoVisibility === "private";
	const [privateByDefault, setPrivateByDefault] = useState(savedPrivate);
	const [saving, setSaving] = useState(false);
	const savedRestricted =
		activeOrganization?.organization.videoSharingRestrictedToOrg ?? false;
	const [restricted, setRestricted] = useState(savedRestricted);

	useEffect(() => {
		setRestricted(savedRestricted);
	}, [savedRestricted]);

	useEffect(() => {
		setPrivateByDefault(savedPrivate);
	}, [savedPrivate]);

	const handleChange = async (checked: boolean) => {
		setPrivateByDefault(checked);
		setSaving(true);
		try {
			await updateDefaultVideoVisibility(checked);
			router.refresh();
			toast.success(
				checked
					? "New recordings will start private"
					: "New recordings will use the current default",
			);
		} catch {
			setPrivateByDefault(!checked);
			toast.error("Failed to update the recording default");
		} finally {
			setSaving(false);
		}
	};

	const handleRestrictionChange = async (checked: boolean) => {
		setRestricted(checked);
		setSaving(true);
		try {
			if (!activeOrganization) throw new Error("No organization selected");
			await updateOrganizationVideoSharing(
				activeOrganization.organization.id,
				checked,
			);
			router.refresh();
			toast.success(
				checked
					? "All recordings are now organization-only"
					: "Individual sharing settings restored",
			);
		} catch {
			setRestricted(!checked);
			toast.error("Failed to update organization sharing");
		} finally {
			setSaving(false);
		}
	};

	return (
		<Card className="flex flex-col gap-4">
			<CardHeader>
				<CardTitle>Recording access</CardTitle>
				<CardDescription>
					Control who can view recordings in this organization.
				</CardDescription>
			</CardHeader>
			<div className="flex items-center justify-between gap-6 p-4 mx-4 rounded-xl border bg-gray-2 border-gray-3">
				<div className="space-y-1">
					<label htmlFor={restrictionId} className="text-sm text-gray-12">
						Only members of this organization
					</label>
					<p className="text-xs text-gray-10" id={descriptionId}>
						Applies to all existing and new recordings. Every member can view
						with a signed-in organization account. People outside the
						organization cannot view them.
					</p>
					<p className="text-xs text-gray-10">
						Overrides public links, invitations, passwords, and individual
						sharing settings. Only admins and owners can change this. Turning it
						off restores those settings.
					</p>
				</div>
				<Switch
					id={restrictionId}
					aria-describedby={descriptionId}
					checked={restricted}
					disabled={saving}
					onCheckedChange={handleRestrictionChange}
				/>
			</div>
			<div className="flex items-center justify-between gap-6 p-4 mx-4 mb-4 rounded-xl border bg-gray-2 border-gray-3">
				<div className="space-y-1">
					<label htmlFor={privateId} className="text-sm text-gray-12">
						Start new recordings private
					</label>
					<p className="text-xs text-gray-10">
						Only people given access can view them. When off, recordings follow
						the current server default.
					</p>
					<p className="text-xs text-gray-10">
						{restricted
							? "Organization-only access takes precedence while enabled."
							: "Existing recordings keep their current sharing setting."}
					</p>
				</div>
				<Switch
					id={privateId}
					checked={privateByDefault}
					disabled={saving || restricted}
					onCheckedChange={handleChange}
				/>
			</div>
		</Card>
	);
};
