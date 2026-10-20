"use client";

import {
	Button,
	CardDescription,
	Dialog,
	DialogContent,
	DialogFooter,
	DialogHeader,
	DialogTitle,
	Form,
	FormControl,
	FormField,
	Input,
	Label,
	Switch,
} from "@cap/ui";
import type { ImageUpload } from "@cap/web-domain";
import { faLayerGroup, faLock } from "@fortawesome/free-solid-svg-icons";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { zodResolver } from "@hookform/resolvers/zod";
import { useRouter } from "next/navigation";
import type React from "react";
import { useEffect, useId, useRef, useState } from "react";
import { useForm } from "react-hook-form";
import { toast } from "sonner";
import * as z from "zod";
import { updateSpace } from "@/actions/organization/update-space";
import { FileInput } from "@/components/FileInput";
import { useDashboardContext } from "../../Contexts";
import type { OrganizationSettings } from "../../dashboard-data";
import { MemberSelect } from "../../spaces/[spaceId]/components/MemberSelect";
import { PublicCollectionField } from "../PublicCollectionField";
import { createSpace } from "./server";

interface SpaceDialogProps {
	open: boolean;
	onClose: () => void;
	edit?: boolean;
	space?: {
		id: string;
		name: string;
		members: string[];
		iconUrl?: ImageUpload.ImageUrl;
		settings?: OrganizationSettings | null;
		hasPassword?: boolean;
		public?: boolean;
	} | null;
	onSpaceUpdated?: () => void;
}

const SpaceDialog = ({
	open,
	onClose,
	edit = false,
	space,
	onSpaceUpdated,
}: SpaceDialogProps) => {
	const [isSubmitting, setIsSubmitting] = useState(false);
	const formRef = useRef<HTMLFormElement | null>(null);
	const [spaceName, setSpaceName] = useState(space?.name || "");

	useEffect(() => {
		setSpaceName(space?.name || "");
	}, [space]);

	return (
		<Dialog open={open} onOpenChange={(open) => !open && onClose()}>
			<DialogContent className="p-0 w-[calc(100%-20px)] max-w-2xl rounded-xl border bg-gray-2 border-gray-4">
				<DialogHeader
					icon={<FontAwesomeIcon icon={faLayerGroup} />}
					description={
						edit
							? "Manage details, sharing and viewer permissions."
							: "Set up a space for your team to collaborate."
					}
				>
					<DialogTitle className="text-lg text-gray-12">
						{edit ? "Edit Space" : "Create New Space"}
					</DialogTitle>
				</DialogHeader>
				<div className="px-6 py-5 max-h-[70vh] overflow-y-auto">
					<NewSpaceForm
						formRef={formRef}
						setCreateLoading={setIsSubmitting}
						onSpaceCreated={onSpaceUpdated || onClose}
						onNameChange={setSpaceName}
						edit={edit}
						space={space}
					/>
				</div>
				<DialogFooter>
					<Button variant="gray" size="sm" onClick={onClose}>
						Cancel
					</Button>
					<Button
						variant="dark"
						size="sm"
						disabled={isSubmitting || !spaceName.trim().length}
						spinner={isSubmitting}
						onClick={() => formRef.current?.requestSubmit()}
					>
						{isSubmitting
							? edit
								? "Saving..."
								: "Creating..."
							: edit
								? "Save"
								: "Create"}
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
};

export interface NewSpaceFormProps {
	onSpaceCreated: () => void;
	formRef?: React.RefObject<HTMLFormElement | null>;
	setCreateLoading?: React.Dispatch<React.SetStateAction<boolean>>;
	onNameChange?: (name: string) => void;
	edit?: boolean;
	space?: {
		id: string;
		name: string;
		members: string[];
		iconUrl?: ImageUpload.ImageUrl;
		settings?: OrganizationSettings | null;
		hasPassword?: boolean;
		public?: boolean;
	} | null;
}

const formSchema = z.object({
	name: z
		.string()
		.min(1, "Space name is required")
		.max(25, "Space name must be at most 25 characters"),
	members: z.array(z.string()).optional(),
});

const defaultSettings: OrganizationSettings = {
	disableComments: false,
	disableSummary: false,
	disableCaptions: false,
	disableChapters: false,
	disableReactions: false,
	disableTranscript: false,
};

const settingOptions: {
	label: string;
	value: keyof OrganizationSettings;
	description: string;
	pro?: boolean;
}[] = [
	{
		label: "Enable comments",
		value: "disableComments",
		description: "Allow viewers to comment on caps in this space",
	},
	{
		label: "Enable summary",
		value: "disableSummary",
		description: "Show AI-generated summary for caps in this space",
		pro: true,
	},
	{
		label: "Enable captions",
		value: "disableCaptions",
		description: "Allow viewers to use captions for caps in this space",
	},
	{
		label: "Enable chapters",
		value: "disableChapters",
		description: "Show AI-generated chapters for caps in this space",
		pro: true,
	},
	{
		label: "Enable reactions",
		value: "disableReactions",
		description: "Allow viewers to react to caps in this space",
	},
	{
		label: "Enable transcript",
		value: "disableTranscript",
		description: "Enabling this also allows summary and chapters",
		pro: true,
	},
];

export const NewSpaceForm: React.FC<NewSpaceFormProps> = (props) => {
	const { edit = false, space } = props;
	const router = useRouter();

	const form = useForm<z.infer<typeof formSchema>>({
		resolver: zodResolver(formSchema),
		defaultValues: {
			name: space?.name || "",
			members: space?.members || [],
		},
		mode: "onChange",
	});

	useEffect(() => {
		if (space) {
			form.reset({
				name: space.name,
				members: space.members,
			});
		} else {
			form.reset({ name: "", members: [] });
		}
	}, [space, form]);

	const [selectedFile, setSelectedFile] = useState<File | null>(null);
	const [isUploading, setIsUploading] = useState(false);
	const { activeOrganization, user, setUpgradeModalOpen } =
		useDashboardContext();
	const [settings, setSettings] = useState<OrganizationSettings>({
		...defaultSettings,
		...space?.settings,
	});
	const [passwordEnabled, setPasswordEnabled] = useState(
		Boolean(space?.hasPassword),
	);
	const [publicEnabled, setPublicEnabled] = useState(Boolean(space?.public));
	const [passwordValue, setPasswordValue] = useState("");
	const iconInputId = useId();

	useEffect(() => {
		setSettings({ ...defaultSettings, ...space?.settings });
		setPasswordEnabled(Boolean(space?.hasPassword));
		setPublicEnabled(Boolean(space?.public));
		setPasswordValue("");
	}, [space]);

	const handleToggleSetting = (key: keyof OrganizationSettings) => {
		setSettings((prev) => {
			const nextValue = !prev[key];

			if (key === "disableTranscript" && nextValue) {
				return {
					...prev,
					[key]: nextValue,
					disableSummary: true,
					disableChapters: true,
				};
			}

			return { ...prev, [key]: nextValue };
		});
	};

	const handlePasswordToggle = (checked: boolean) => {
		if (checked && user && !user.isPro) {
			setUpgradeModalOpen(true);
			return;
		}
		setPasswordEnabled(checked);
		if (!checked) {
			setPasswordValue("");
		}
	};

	const handleFileChange = (file: File | null) => {
		if (file) {
			// Validate file size (1MB = 1024 * 1024 bytes)
			if (file.size > 1024 * 1024) {
				toast.error("File size must be less than 1MB");
				return;
			}
			// Validate file type
			if (!file.type.startsWith("image/")) {
				toast.error("File must be an image");
				return;
			}
		}
		setSelectedFile(file);
	};

	return (
		<Form {...form}>
			<form
				className="space-y-4"
				ref={props.formRef}
				onSubmit={form.handleSubmit(async (values) => {
					try {
						if (selectedFile) {
							setIsUploading(true);
						}
						props.setCreateLoading?.(true);

						const formData = new FormData();
						formData.append("name", values.name);

						if (selectedFile) {
							formData.append("icon", selectedFile);
						}

						if (values.members && values.members.length > 0) {
							values.members.forEach((id) => {
								formData.append("members[]", id);
							});
						}

						for (const option of settingOptions) {
							formData.append(option.value, String(settings[option.value]));
						}

						formData.append("passwordEnabled", String(passwordEnabled));
						formData.append("public", String(publicEnabled));

						if (passwordEnabled && passwordValue.trim()) {
							formData.append("password", passwordValue.trim());
						}

						if (edit && space?.id) {
							if (
								passwordEnabled &&
								!space.hasPassword &&
								!passwordValue.trim()
							) {
								throw new Error("Space password is required");
							}
							formData.append("id", space.id);
							const passwordAction = !passwordEnabled
								? space.hasPassword
									? "remove"
									: "keep"
								: passwordValue.trim()
									? "set"
									: "keep";
							formData.append("passwordAction", passwordAction);
							// If the user removed the icon, send a removeIcon flag
							if (selectedFile === null && space.iconUrl) {
								formData.append("removeIcon", "true");
							}
							const result = await updateSpace(formData);
							if (!result.success) {
								throw new Error(result.error || "Failed to update space");
							}
							toast.success("Space updated successfully");
							router.refresh();
						} else {
							if (passwordEnabled && !passwordValue.trim()) {
								throw new Error("Space password is required");
							}
							const result = await createSpace(formData);
							if (!result.success) {
								throw new Error(result.error || "Failed to create space");
							}
							toast.success("Space created successfully");
							router.refresh();
						}

						form.reset();
						setSelectedFile(null);
						props.onSpaceCreated();
					} catch (error) {
						console.error(
							edit ? "Error updating space:" : "Error creating space:",
							error,
						);
						const message =
							error instanceof Error
								? error.message
								: edit
									? "Failed to update space"
									: "Failed to create space";
						toast.error(
							message ||
								(edit ? "Failed to update space" : "Failed to create space"),
						);
					} finally {
						setIsUploading(false);
						props.setCreateLoading?.(false);
					}
				})}
			>
				<div className="space-y-7">
					{/* Details */}
					<section className="space-y-3">
						<SectionLabel
							title="Details"
							description="Name your space and choose who belongs in it."
						/>
						<div className="grid grid-cols-1 gap-4 md:grid-cols-2 md:items-start">
							<div className="space-y-4">
								<FormField
									control={form.control}
									name="name"
									render={({ field }) => (
										<FormControl>
											<Input
												placeholder="Space name"
												maxLength={25}
												{...field}
												onChange={(e) => {
													field.onChange(e);
													props.onNameChange?.(e.target.value);
												}}
											/>
										</FormControl>
									)}
								/>

								<div className="space-y-2">
									<div className="space-y-1">
										<Label htmlFor={iconInputId}>Space icon</Label>
										<CardDescription>
											Custom logo or icon (max 1MB).
										</CardDescription>
									</div>
									<FileInput
										id={iconInputId}
										name="icon"
										initialPreviewUrl={space?.iconUrl || null}
										notDraggingClassName="hover:bg-gray-3"
										onChange={handleFileChange}
										disabled={isUploading}
										isLoading={isUploading}
									/>
								</div>
							</div>

							<div className="space-y-2">
								<div className="space-y-1">
									<Label htmlFor="members">Members</Label>
									<CardDescription>
										Add team members to this space.
									</CardDescription>
								</div>
								<FormField
									control={form.control}
									name="members"
									render={({ field }) => (
										<FormControl>
											<MemberSelect
												placeholder="Add member..."
												showEmptyIfNoMembers={false}
												disabled={isUploading}
												canManageMembers={true}
												selected={(activeOrganization?.members ?? [])
													.filter((m) =>
														(field.value ?? []).includes(m.user.id),
													)
													.map((m) => ({
														value: m.user.id,
														label: m.user.name || m.user.email,
														image: m.user.image ?? undefined,
													}))}
												onSelect={(selected) =>
													field.onChange(selected.map((opt) => opt.value))
												}
											/>
										</FormControl>
									)}
								/>
							</div>
						</div>
					</section>

					{/* Sharing */}
					<section className="space-y-3">
						<SectionLabel
							title="Sharing"
							description="Control how this space can be reached."
						/>
						<div className="grid grid-cols-1 gap-4 md:grid-cols-2 md:items-start">
							<PublicCollectionField
								kind="space"
								enabled={publicEnabled}
								onChange={setPublicEnabled}
								isPro={Boolean(activeOrganization?.ownerIsPro)}
								onUpgrade={() => setUpgradeModalOpen(true)}
								collectionId={edit && space?.id ? space.id : undefined}
							/>

							<div className="rounded-xl border border-gray-4 bg-gray-1">
								<div className="flex gap-3 justify-between items-center p-3.5">
									<div className="flex gap-3 items-center min-w-0">
										<div className="flex justify-center items-center rounded-full size-9 bg-gray-3 shrink-0">
											<FontAwesomeIcon
												icon={faLock}
												className="size-3.5 text-gray-11"
											/>
										</div>
										<div className="min-w-0">
											<p className="text-sm font-medium text-gray-12">
												Require password
											</p>
											<p className="text-xs text-gray-10">
												Protect every cap in this space
											</p>
										</div>
									</div>
									<Switch
										checked={passwordEnabled}
										onCheckedChange={handlePasswordToggle}
									/>
								</div>
								{passwordEnabled && (
									<div className="px-3.5 pb-3.5 space-y-1">
										<Input
											type="password"
											value={passwordValue}
											onChange={(e) => setPasswordValue(e.target.value)}
											placeholder={
												space?.hasPassword
													? "Enter new password"
													: "Set a password"
											}
										/>
										{space?.hasPassword && !passwordValue && (
											<p className="text-xs text-gray-9">
												Leave blank to keep existing password
											</p>
										)}
									</div>
								)}
							</div>
						</div>
					</section>

					{/* Viewer permissions */}
					<section className="space-y-3">
						<SectionLabel
							title="Viewer permissions"
							description="These apply to every cap shared in this space."
						/>
						<div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
							{settingOptions.map((option) => {
								const disabled =
									(option.pro && !user?.isPro) ||
									((option.value === "disableSummary" ||
										option.value === "disableChapters") &&
										settings.disableTranscript);

								return (
									<div
										key={option.value}
										className="flex gap-3 justify-between items-center p-3 rounded-lg border border-gray-4 bg-gray-1"
									>
										<div>
											<div className="flex gap-1.5 items-center">
												<p className="text-sm text-gray-12">{option.label}</p>
												{option.pro && (
													<span className="rounded-full bg-blue-11 px-1.5 py-0.5 text-[10px] font-medium leading-none text-white">
														Pro
													</span>
												)}
											</div>
											<p className="text-xs text-gray-10">
												{option.description}
											</p>
										</div>
										<Switch
											disabled={disabled}
											checked={!settings[option.value]}
											onCheckedChange={() => handleToggleSetting(option.value)}
										/>
									</div>
								);
							})}
						</div>
					</section>
				</div>
			</form>
		</Form>
	);
};

function SectionLabel({
	title,
	description,
}: {
	title: string;
	description?: string;
}) {
	return (
		<div>
			<p className="text-[11px] font-medium tracking-wide uppercase text-gray-9">
				{title}
			</p>
			{description && (
				<p className="mt-0.5 text-xs text-gray-10">{description}</p>
			)}
		</div>
	);
}

export default SpaceDialog;
