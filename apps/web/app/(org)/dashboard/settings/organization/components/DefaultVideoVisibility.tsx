"use client";

import { Card, CardDescription, CardHeader, CardTitle, Switch } from "@cap/ui";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { updateDefaultVideoVisibility } from "@/actions/organization/default-video-visibility";
import { useDashboardContext } from "../../../Contexts";

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

	return (
		<Card className="flex flex-col gap-4">
			<CardHeader>
				<CardTitle>Sharing default</CardTitle>
				<CardDescription>
					Choose how new recordings in this organization start. Owners can
					change access on each recording later.
				</CardDescription>
			</CardHeader>
			<div className="flex items-center justify-between gap-6 p-4 mx-4 mb-4 rounded-xl border bg-gray-2 border-gray-3">
				<div className="space-y-1">
					<p className="text-sm text-gray-12">Start new recordings private</p>
					<p className="text-xs text-gray-10">
						Only people given access can view them. When off, recordings follow
						the current server default.
					</p>
					<p className="text-xs text-gray-10">
						Existing recordings keep their current sharing setting.
					</p>
				</div>
				<Switch
					checked={privateByDefault}
					disabled={saving}
					onCheckedChange={handleChange}
				/>
			</div>
		</Card>
	);
};
