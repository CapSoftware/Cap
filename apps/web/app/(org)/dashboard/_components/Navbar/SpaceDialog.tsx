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
import {
	faGear,
	faLayerGroup,
	faLock,
} from "@fortawesome/free-solid-svg-icons";
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
			<DialogContent className="p-0 w-[calc(100%-20px)] max-w-md rounded-xl border bg-gray-2 border-gray-4">
				<DialogHeader
					icon={<FontAwesomeIcon icon={faLayerGroup} />}
					description={
						edit
							? "Edit your space details"
							: "A new space for your team to collaborate"
					}
				>
					<DialogTitle className="text-lg text-gray-12">
						{edit ? "Edit Space" : "Create New Space"}
					</DialogTitle>
				</DialogHeader>
				<div className="p-5 max-h-[70vh] overflow-y-auto">
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
	const [passwordValue, setPasswordValue] = useState("");
	const iconInputId = useId();

	useEffect(() => {
		setSettings({ ...defaultSettings, ...space?.settings });
		setPasswordEnabled(Boolean(space?.hasPassword));
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

					{/* Space Members Input */}
					<div className="space-y-1">
						<Label htmlFor="members">Members</Label>
						<CardDescription className="w-full max-w-[400px]">
							Add team members to this space.
						</CardDescription>
					</div>
					<FormField
						control={form.control}
						name="members"
						render={({ field }) => {
							return (
								<FormControl>
									<MemberSelect
										placeholder="Add member..."
										showEmptyIfNoMembers={false}
										disabled={isUploading}
										canManageMembers={true}
										selected={(activeOrganization?.members ?? [])
											.filter((m) => (field.value ?? []).includes(m.user.id))
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
							);
						}}
					/>

					<div className="space-y-3 rounded-xl border border-gray-4 bg-gray-1 p-3">
						<div className="flex items-start justify-between gap-4">
							<div className="flex gap-3">
								<div className="flex size-8 items-center justify-center rounded-full bg-gray-3">
									<FontAwesomeIcon
										icon={faLock}
										className="size-3 text-gray-11"
									/>
								</div>
								<div>
									<p className="text-sm font-medium text-gray-12">
										Require password
									</p>
									<p className="text-xs text-gray-10">
										All caps in this space require this password
									</p>
								</div>
							</div>
							<Switch
								checked={passwordEnabled}
								onCheckedChange={handlePasswordToggle}
							/>
						</div>
						{passwordEnabled && (
							<div className="space-y-1">
								<Input
									type="password"
									value={passwordValue}
									onChange={(e) => setPasswordValue(e.target.value)}
									placeholder={
										space?.hasPassword ? "Enter new password" : "Set a password"
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

					<div className="space-y-3 rounded-xl border border-gray-4 bg-gray-1 p-3">
						<div className="flex gap-3">
							<div className="flex size-8 items-center justify-center rounded-full bg-gray-3">
								<FontAwesomeIcon
									icon={faGear}
									className="size-3 text-gray-11"
								/>
							</div>
							<div>
								<p className="text-sm font-medium text-gray-12">Viewer rules</p>
								<p className="text-xs text-gray-10">
									These apply to every cap in this space
								</p>
							</div>
						</div>
						<div className="grid grid-cols-1 gap-2">
							{settingOptions.map((option) => {
								const disabled =
									(option.pro && !user?.isPro) ||
									((option.value === "disableSummary" ||
										option.value === "disableChapters") &&
										settings.disableTranscript);

								return (
									<div
										key={option.value}
										className="flex items-center justify-between gap-4 rounded-lg border border-gray-3 bg-gray-2 p-3"
									>
										<div>
											<div className="flex items-center gap-1.5">
												<p className="text-sm text-gray-12">{option.label}</p>
												{option.pro && (
													<p className="rounded-full bg-blue-11 px-1.5 py-1 text-[10px] font-medium leading-none text-white">
														Pro
													</p>
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
					</div>

					<div className="space-y-1">
						<Label htmlFor={iconInputId}>Space Icon</Label>
						<CardDescription className="w-full max-w-[400px]">
							Upload a custom logo or icon for your space (max 1MB).
						</CardDescription>
					</div>

					<div className="relative mt-2">
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
			</form>
		</Form>
	);
};

export default SpaceDialog;
