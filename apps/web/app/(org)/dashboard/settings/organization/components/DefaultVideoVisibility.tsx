"use client";

import { Card, CardDescription, CardHeader, CardTitle, Switch } from "@cap/ui";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import {
	type OrganizationVideoVisibility,
	updateDefaultVideoVisibility,
} from "@/actions/organization/default-video-visibility";
import { useDashboardContext } from "../../../Contexts";

const successMessage = (visibility: OrganizationVideoVisibility) => {
	if (visibility === "members")
		return "Recordings are now limited to organization members";
	if (visibility === "private") return "New recordings will start private";
	return "New recordings will use the current default";
};

export const DefaultVideoVisibility = () => {
	const router = useRouter();
	const { activeOrganization } = useDashboardContext();
	const savedVisibility =
		activeOrganization?.organization.defaultVideoVisibility ?? null;
	const [visibility, setVisibility] =
		useState<OrganizationVideoVisibility>(savedVisibility);
	const [saving, setSaving] = useState(false);

	useEffect(() => {
		setVisibility(savedVisibility);
	}, [savedVisibility]);

	const membersOnly = visibility === "members";
	const privateByDefault = visibility === "private" || membersOnly;

	const save = async (next: OrganizationVideoVisibility) => {
		const previous = visibility;
		setVisibility(next);
		setSaving(true);
		try {
			await updateDefaultVideoVisibility(next);
			router.refresh();
			toast.success(successMessage(next));
		} catch {
			setVisibility(previous);
			toast.error("Failed to update the sharing default");
		} finally {
			setSaving(false);
		}
	};

	return (
		<Card className="flex flex-col gap-4">
			<CardHeader>
				<CardTitle>Sharing default</CardTitle>
				<CardDescription>
					Choose who can view recordings in this organization.
				</CardDescription>
			</CardHeader>
			<div className="flex flex-col gap-3 mx-4 mb-4">
				<div className="flex items-center justify-between gap-6 p-4 rounded-xl border bg-gray-2 border-gray-3">
					<div className="space-y-1">
						<p className="text-sm text-gray-12">Organization members only</p>
						<p className="text-xs text-gray-10">
							Every recording, old and new, can only be viewed by signed-in
							members of this organization. This overrides public links, invited
							viewers and each recording's own sharing setting.
						</p>
						<p className="text-xs text-gray-10">
							Turn it off to restore each recording's own setting.
						</p>
					</div>
					<Switch
						aria-label="Organization members only"
						checked={membersOnly}
						disabled={saving}
						onCheckedChange={(checked) => save(checked ? "members" : "private")}
					/>
				</div>
				<div className="flex items-center justify-between gap-6 p-4 rounded-xl border bg-gray-2 border-gray-3">
					<div className="space-y-1">
						<p className="text-sm text-gray-12">Start new recordings private</p>
						<p className="text-xs text-gray-10">
							{membersOnly
								? "On while access is limited to organization members."
								: "Only people given access can view them. When off, recordings follow the current server default. Existing recordings keep their current sharing setting."}
						</p>
					</div>
					<Switch
						aria-label="Start new recordings private"
						checked={privateByDefault}
						disabled={saving || membersOnly}
						onCheckedChange={(checked) => save(checked ? "private" : null)}
					/>
				</div>
			</div>
		</Card>
	);
};
