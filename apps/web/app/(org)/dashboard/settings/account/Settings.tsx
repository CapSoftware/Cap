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
import { type ImageUpload, Organisation } from "@cap/web-domain";
import { useMutation } from "@tanstack/react-query";
import { Effect, Option } from "effect";
import { useRouter } from "next/navigation";
import { useEffect, useId, useState } from "react";
import { toast } from "sonner";
import { SignedImageUrl } from "@/components/SignedImageUrl";
import { useEffectMutation, useRpcClient } from "@/lib/EffectRuntime";
import { withRpc } from "@/lib/Rpcs";
import { useDashboardContext } from "../../Contexts";
import { ProfileImage } from "./components/ProfileImage";
import { patchAccountSettings } from "./server";

export const Settings = () => {
	const router = useRouter();
	const { organizationData, user } = useDashboardContext();
	const [firstName, setFirstName] = useState(user?.name || "");
	const [lastName, setLastName] = useState(user?.lastName || "");
	const [defaultOrgId, setDefaultOrgId] = useState<
		Organisation.OrganisationId | undefined
	>(user?.defaultOrgId || undefined);
	const firstNameId = useId();
	const lastNameId = useId();
	const contactEmailId = useId();
	const initialProfileImage = user?.imageUrl ?? null;
	const [profileImageOverride, setProfileImageOverride] = useState<
		ImageUpload.ImageUrl | null | undefined
	>(undefined);
	const profileImagePreviewUrl =
		profileImageOverride !== undefined
			? profileImageOverride
			: initialProfileImage;

	useEffect(() => {
		if (
			profileImageOverride !== undefined &&
			profileImageOverride === initialProfileImage
		) {
			setProfileImageOverride(undefined);
		}
	}, [initialProfileImage, profileImageOverride]);

	// Track if form has unsaved changes
	const hasChanges =
		firstName !== (user?.name || "") ||
		lastName !== (user?.lastName || "") ||
		defaultOrgId !== user?.defaultOrgId;

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

	const rpc = useRpcClient();

	const uploadProfileImageMutation = useEffectMutation({
		mutationFn: Effect.fn(function* (file: File) {
			const arrayBuffer = yield* Effect.promise(() => file.arrayBuffer());
			yield* rpc.UserUpdate({
				id: user.id,
				image: Option.some({
					data: new Uint8Array(arrayBuffer),
					contentType: file.type,
					fileName: file.name,
				}),
			});
		}),
		onSuccess: () => {
			setProfileImageOverride(undefined);
			toast.success("Profile image updated successfully");
			router.refresh();
		},
		onError: (error) => {
			console.error("Error uploading profile image:", error);
			setProfileImageOverride(undefined);
			toast.error(
				error instanceof Error
					? error.message
					: "Failed to upload profile image",
			);
		},
	});

	const removeProfileImageMutation = useEffectMutation({
		mutationFn: () => rpc.UserUpdate({ id: user.id, image: Option.none() }),
		onSuccess: () => {
			setProfileImageOverride(null);
			toast.success("Profile image removed");
			router.refresh();
		},
		onError: (error) => {
			console.error("Error removing profile image:", error);
			setProfileImageOverride(initialProfileImage);
			toast.error(
				error instanceof Error
					? error.message
					: "Failed to remove profile image",
			);
		},
	});

	const isProfileImageMutating =
		uploadProfileImageMutation.isPending ||
		removeProfileImageMutation.isPending;

	const handleProfileImageChange = (file: File | null) => {
		if (!file || isProfileImageMutating) {
			return;
		}
		uploadProfileImageMutation.mutate(file);
	};

	const handleProfileImageRemove = () => {
		if (isProfileImageMutating) {
			return;
		}
		setProfileImageOverride(null);
		removeProfileImageMutation.mutate();
	};

	return (
		<form
			onSubmit={(e) => {
				e.preventDefault();
				updateName();
			}}
		>
			<div className="grid gap-6 w-full md:grid-cols-2">
				<Card className="space-y-4">
					<div className="space-y-1">
						<CardTitle>Profile image</CardTitle>
						<CardDescription>
							This image appears in your profile, comments, and shared caps.
						</CardDescription>
					</div>
					<ProfileImage
						initialPreviewUrl={profileImagePreviewUrl}
						onChange={handleProfileImageChange}
						onRemove={handleProfileImageRemove}
						disabled={isProfileImageMutating}
						isUploading={uploadProfileImageMutation.isPending}
						isRemoving={removeProfileImageMutation.isPending}
						userName={user?.name}
					/>
				</Card>
				<Card className="space-y-4">
					<div className="space-y-1">
						<CardTitle>Your name</CardTitle>
						<CardDescription>
							Changing your name below will update how your name appears when
							sharing a Cap, and in your profile.
						</CardDescription>
					</div>
					<div className="flex flex-col flex-wrap gap-3 w-full">
						<div className="flex-1">
							<Input
								type="text"
								placeholder="First name"
								onChange={(e) => setFirstName(e.target.value)}
								defaultValue={firstName as string}
								id={firstNameId}
								name="firstName"
							/>
						</div>
						<div className="flex-1 space-y-2">
							<Input
								type="text"
								placeholder="Last name"
								onChange={(e) => setLastName(e.target.value)}
								defaultValue={lastName as string}
								id={lastNameId}
								name="lastName"
							/>
						</div>
					</div>
				</Card>
				<Card className="flex flex-col gap-4">
					<div className="space-y-1">
						<CardTitle>Contact email address</CardTitle>
						<CardDescription>
							This is the email address you used to sign up to Cap with.
						</CardDescription>
					</div>
					<Input
						type="email"
						value={user?.email as string}
						id={contactEmailId}
						name="contactEmail"
						disabled
					/>
				</Card>
				<Card className="flex flex-col gap-4">
					<div className="space-y-1">
						<CardTitle>Default organization</CardTitle>
						<CardDescription>This is the default organization</CardDescription>
					</div>

					<Select
						placeholder="Default organization"
						value={
							defaultOrgId ??
							user?.defaultOrgId ??
							organizationData?.[0]?.organization.id ??
							""
						}
						onValueChange={(value) =>
							setDefaultOrgId(Organisation.OrganisationId.make(value))
						}
						options={(organizationData || []).map((org) => ({
							value: org.organization.id,
							label: org.organization.name,
							image: (
								<SignedImageUrl
									className="size-5"
									image={org.organization.iconUrl}
									name={org.organization.name}
								/>
							),
						}))}
					/>
				</Card>
			</div>
			<Button
				disabled={!firstName || updateNamePending || !hasChanges}
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
