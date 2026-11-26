"use client";

import { Switch } from "@cap/ui";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { updateDefaultVideoVisibility } from "@/actions/organization/default-video-visibility";
import { useDashboardContext } from "../../../Contexts";
import {
	SettingsCard,
	SettingsRow,
	SettingsSection,
} from "../_components/settings-ui";

export const DefaultVideoVisibility = () => {
	const router = useRouter();
	const { activeOrganization } = useDashboardContext();
	const savedPrivate =
		activeOrganization?.organization.defaultVideoVisibility === "private";
	const [privateByDefault, setPrivateByDefault] = useState(savedPrivate);
	const [saving, setSaving] = useState(false);

	useEffect(() => {
		setPrivateByDefault(savedPrivate);
	}, [savedPrivate]);

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
			</SettingsCard>
		</SettingsSection>
	);
};
