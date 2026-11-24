"use client";

import { Switch } from "@cap/ui";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { updateDefaultVideoVisibility } from "@/actions/organization/default-video-visibility";
import { updateShareNewVideosWithOrganization } from "@/actions/organization/share-new-videos";
import { useDashboardContext } from "../../../Contexts";
import {
	SettingsCard,
	SettingsRow,
	SettingsSection,
} from "../_components/settings-ui";

export const DefaultVideoVisibility = () => {
	const router = useRouter();
	const { activeOrganization, organizationSettings } = useDashboardContext();
	const savedPrivate =
		activeOrganization?.organization.defaultVideoVisibility === "private";
	const [privateByDefault, setPrivateByDefault] = useState(savedPrivate);
	const [saving, setSaving] = useState(false);
	const savedShareWithOrganization =
		organizationSettings?.shareNewVideosWithOrganization === true;
	const [shareWithOrganization, setShareWithOrganization] = useState(
		savedShareWithOrganization,
	);
	const [savingShare, setSavingShare] = useState(false);

	useEffect(() => {
		setPrivateByDefault(savedPrivate);
	}, [savedPrivate]);

	useEffect(() => {
		setShareWithOrganization(savedShareWithOrganization);
	}, [savedShareWithOrganization]);

	const handleChange = async (checked: boolean) => {
		if (!activeOrganization) return;
		setPrivateByDefault(checked);
		setSaving(true);
		try {
			await updateDefaultVideoVisibility(
				checked,
				activeOrganization.organization.id,
			);
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

	const handleShareChange = async (checked: boolean) => {
		if (!activeOrganization) return;
		setShareWithOrganization(checked);
		setSavingShare(true);
		try {
			await updateShareNewVideosWithOrganization(
				checked,
				activeOrganization.organization.id,
			);
			router.refresh();
			toast.success(
				checked
					? "New recordings will be shared with the organization"
					: "New recordings will no longer be added to the organization library",
			);
		} catch {
			setShareWithOrganization(!checked);
			toast.error("Failed to update the recording default");
		} finally {
			setSavingShare(false);
		}
	};

	return (
		<SettingsSection title="Sharing default">
			<SettingsCard>
				<SettingsRow
					title="Start new recordings private"
					description="Only people given access can view them. When off, recordings follow the current server default. Existing recordings keep their current sharing setting."
					control={
						<Switch
							checked={privateByDefault}
							disabled={saving}
							onCheckedChange={handleChange}
						/>
					}
				/>
				<SettingsRow
					title="Share new recordings with the organization"
					description="New recordings and uploads are added to the organization library, so every member can find and view them. Link access is not changed. Owners can remove a recording from the organization in its share settings."
					control={
						<Switch
							checked={shareWithOrganization}
							disabled={savingShare}
							onCheckedChange={handleShareChange}
						/>
					}
				/>
			</SettingsCard>
		</SettingsSection>
	);
};
