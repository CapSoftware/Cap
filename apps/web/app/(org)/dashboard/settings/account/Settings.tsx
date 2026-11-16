"use client";

import {
	Button,
	Dialog,
	DialogContent,
	DialogFooter,
	DialogHeader,
	DialogTitle,
	Input,
	Select,
} from "@cap/ui";
import { type ImageUpload, Organisation } from "@cap/web-domain";
import { useMutation } from "@tanstack/react-query";
import clsx from "clsx";
import { Effect, Option } from "effect";
import { LogOut } from "lucide-react";
import { useRouter } from "next/navigation";
import { signOut } from "next-auth/react";
import { useEffect, useId, useState } from "react";
import { toast } from "sonner";
import { resetUser } from "@/app/utils/analytics";
import { SignedImageUrl } from "@/components/SignedImageUrl";
import { useEffectMutation, useRpcClient } from "@/lib/EffectRuntime";
import { useDashboardContext } from "../../Contexts";
import {
	SettingsCard,
	SettingsRow,
	SettingsSection,
	settingsFieldClass,
} from "../organization/_components/settings-ui";
import { ProfileImage } from "./components/ProfileImage";
import { patchAccountSettings, signOutAllDevices } from "./server";

export const Settings = () => {
	const router = useRouter();
	const { organizationData, user } = useDashboardContext();
	const [firstName, setFirstName] = useState(user?.name || "");
	const [lastName, setLastName] = useState(user?.lastName || "");
	const [defaultOrgId, setDefaultOrgId] = useState<
		Organisation.OrganisationId | undefined
	>(user?.defaultOrgId || undefined);
	const [signOutAllDevicesOpen, setSignOutAllDevicesOpen] = useState(false);
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

	const signOutAllDevicesMutation = useMutation({
		mutationFn: signOutAllDevices,
		onSuccess: () => {
			toast.success("Signed out of all devices");
			setSignOutAllDevicesOpen(false);
			resetUser();
			signOut({ callbackUrl: "/login" });
		},
		onError: () => {
			toast.error("Failed to sign out of all devices");
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
		<>
			<form
				onSubmit={(e) => {
					e.preventDefault();
					updateName();
				}}
			>
				<SettingsSection title="Profile">
					<SettingsCard>
						<SettingsRow
							title="Profile image"
							description="This image appears in your profile, comments, and shared caps. Recommended size: 120x120."
							control={
								<ProfileImage
									initialPreviewUrl={profileImagePreviewUrl}
									onChange={handleProfileImageChange}
									onRemove={handleProfileImageRemove}
									disabled={isProfileImageMutating}
									isUploading={uploadProfileImageMutation.isPending}
									isRemoving={removeProfileImageMutation.isPending}
									userName={user?.name}
								/>
							}
						/>
						<SettingsRow
							title={<label htmlFor={firstNameId}>Your name</label>}
							description="Changing your name will update how it appears when sharing a Cap, and in your profile."
							control={
								<div className="flex gap-2 w-full sm:w-auto">
									<Input
										type="text"
										placeholder="First name"
										className={clsx(settingsFieldClass, "w-full sm:w-36")}
										onChange={(e) => setFirstName(e.target.value)}
										defaultValue={firstName as string}
										id={firstNameId}
										name="firstName"
									/>
									<Input
										type="text"
										placeholder="Last name"
										aria-label="Last name"
										className={clsx(settingsFieldClass, "w-full sm:w-36")}
										onChange={(e) => setLastName(e.target.value)}
										defaultValue={lastName as string}
										id={lastNameId}
										name="lastName"
									/>
								</div>
							}
						/>
						<SettingsRow
							title={
								<label htmlFor={contactEmailId}>Contact email address</label>
							}
							description="This is the email address you used to sign up to Cap with."
							control={
								<Input
									type="email"
									className={clsx(
										settingsFieldClass,
										"w-full sm:w-[17rem] disabled:bg-gray-2 disabled:text-gray-10",
									)}
									value={user?.email as string}
									id={contactEmailId}
									name="contactEmail"
									disabled
								/>
							}
						/>
						<SettingsRow
							title="Default organization"
							description="This is your default organization."
							control={
								<div className="w-full sm:w-[17rem]">
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
								</div>
							}
						/>
						<div className="flex justify-end px-4 py-3 rounded-b-xl sm:px-5 bg-gray-2">
							<Button
								disabled={!firstName || updateNamePending || !hasChanges}
								className="px-4 h-9"
								type="submit"
								size="sm"
								variant="dark"
								spinner={updateNamePending}
							>
								{updateNamePending ? "Saving..." : "Save changes"}
							</Button>
						</div>
					</SettingsCard>
				</SettingsSection>
			</form>
			<SettingsSection title="Security">
				<SettingsCard>
					<SettingsRow
						title="Sign out of all devices"
						description="Invalidate every Cap web session, desktop app authentication token, and CLI API key connected to your account."
						control={
							<Button
								type="button"
								size="sm"
								variant="destructive"
								className="px-4 h-9"
								icon={<LogOut className="size-3.5" />}
								onClick={() => setSignOutAllDevicesOpen(true)}
							>
								Sign out all devices
							</Button>
						}
					/>
				</SettingsCard>
			</SettingsSection>
			<Dialog
				open={signOutAllDevicesOpen}
				onOpenChange={setSignOutAllDevicesOpen}
			>
				<DialogContent>
					<DialogHeader
						icon={<LogOut className="size-4" />}
						description="This will immediately invalidate existing Cap web sessions, desktop session tokens, desktop API keys, and CLI API keys for your account."
					>
						<DialogTitle>Sign out of all devices?</DialogTitle>
					</DialogHeader>
					<div className="p-5 space-y-3 text-sm text-gray-11">
						<p>
							You will be signed out of this browser after the reset completes.
						</p>
						<p>
							The Cap desktop app may need you to click Sign out, then sign in
							again before uploads and settings sync work.
						</p>
					</div>
					<DialogFooter>
						<Button
							type="button"
							size="sm"
							variant="gray"
							onClick={() => setSignOutAllDevicesOpen(false)}
						>
							Cancel
						</Button>
						<Button
							type="button"
							size="sm"
							variant="destructive"
							icon={<LogOut className="size-4" />}
							onClick={() => signOutAllDevicesMutation.mutate()}
							spinner={signOutAllDevicesMutation.isPending}
							disabled={signOutAllDevicesMutation.isPending}
						>
							{signOutAllDevicesMutation.isPending
								? "Signing out..."
								: "Sign out all devices"}
						</Button>
					</DialogFooter>
				</DialogContent>
			</Dialog>
		</>
	);
};
