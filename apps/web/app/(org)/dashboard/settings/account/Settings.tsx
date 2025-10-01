"use client";

import type { users } from "@cap/database/schema";
import {
	Button,
	Card,
	CardDescription,
	CardTitle,
	Input,
	Select,
} from "@cap/ui";
import { useMutation } from "@tanstack/react-query";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { useDashboardContext } from "../../Contexts";
import { patchAccountSettings } from "./server";

export const Settings = ({
	user,
}: {
	user?: typeof users.$inferSelect | null;
}) => {
	const router = useRouter();
	const { organizationData } = useDashboardContext();
	const [firstName, setFirstName] = useState(user?.name || "");
	const [lastName, setLastName] = useState(user?.lastName || "");
	const [defaultOrgId, setDefaultOrgId] = useState<string | undefined>(
		user?.defaultOrgId || undefined,
	);

	// Track if form has unsaved changes
	const hasChanges =
		firstName !== (user?.name || "") ||
		lastName !== (user?.lastName || "") ||
		(defaultOrgId ?? null) !== (user?.defaultOrgId ?? null);

	const { mutate: updateName, isPending: updateNamePending } = useMutation({
		mutationFn: async () => {
			await patchAccountSettings(
				firstName.trim(),
				lastName.trim() ? lastName.trim() : undefined,
				defaultOrgId,
			);
		},
		onSuccess: () => {
			toast.success("Name updated successfully");
			router.refresh();
		},
		onError: () => {
			toast.error("Failed to update name");
		},
	});

	// Prevent navigation when there are unsaved changes
	useEffect(() => {
		const handleBeforeUnload = (e: BeforeUnloadEvent) => {
			if (hasChanges) {
				e.preventDefault();
				e.returnValue = "";
			}
		};

		window.addEventListener("beforeunload", handleBeforeUnload);
		return () => window.removeEventListener("beforeunload", handleBeforeUnload);
	}, [hasChanges]);

	return (
		<form
			onSubmit={(e) => {
				e.preventDefault();
				updateName();
			}}
		>
			<div className="flex flex-col flex-wrap gap-6 w-full md:flex-row">
				<Card className="flex-1 space-y-1">
					<CardTitle>Your name</CardTitle>
					<CardDescription>
						Changing your name below will update how your name appears when
						sharing a Cap, and in your profile.
					</CardDescription>
					<div className="flex flex-col flex-wrap gap-5 pt-4 w-full md:flex-row">
						<div className="flex-1 space-y-2">
							<Input
								type="text"
								placeholder="First name"
								onChange={(e) => setFirstName(e.target.value)}
								defaultValue={firstName as string}
								id="firstName"
								name="firstName"
							/>
						</div>
						<div className="flex-1 space-y-2">
							<Input
								type="text"
								placeholder="Last name"
								onChange={(e) => setLastName(e.target.value)}
								defaultValue={lastName as string}
								id="lastName"
								name="lastName"
							/>
						</div>
					</div>
				</Card>
				<Card className="flex flex-col flex-1 gap-4 justify-between items-stretch">
					<div className="space-y-1">
						<CardTitle>Contact email address</CardTitle>
						<CardDescription>
							This is the email address you used to sign up to Cap with.
						</CardDescription>
					</div>
					<Input
						type="email"
						value={user?.email as string}
						id="contactEmail"
						name="contactEmail"
						disabled
					/>
				</Card>
				<Card className="flex flex-col flex-1 gap-4 justify-between items-stretch">
					<div className="space-y-1">
						<CardTitle>Default organization</CardTitle>
						<CardDescription>This is the default organization</CardDescription>
					</div>

					<Select
						value={
							defaultOrgId ??
							user?.defaultOrgId ??
							organizationData?.[0]?.organization.id ??
							""
						}
						onChange={(value) => setDefaultOrgId(value)}
						options={(organizationData || []).map((org) => ({
							value: org.organization.id,
							label: org.organization.name,
						}))}
					/>
				</Card>
			</div>
			<Button
				disabled={!firstName || updateNamePending}
				className="mt-6"
				type="submit"
				size="sm"
				variant="dark"
				spinner={updateNamePending}
			>
				{updateNamePending ? "Saving..." : "Save"}
			</Button>
		</form>
	);
};
