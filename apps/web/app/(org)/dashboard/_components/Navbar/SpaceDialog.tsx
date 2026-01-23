"use client";

import { faLayerGroup } from "@fortawesome/free-solid-svg-icons";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { zodResolver } from "@hookform/resolvers/zod";
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
} from "@inflight/ui";
import type { ImageUpload } from "@inflight/web-domain";
import { useRouter } from "next/navigation";
import type React from "react";
import { useEffect, useRef, useState } from "react";
import { useForm } from "react-hook-form";
import { toast } from "sonner";
import * as z from "zod";
import { updateSpace } from "@/actions/organization/update-space";
import { FileInput } from "@/components/FileInput";
import { useDashboardContext } from "../../Contexts";
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
				<div className="p-5">
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
	} | null;
}

const formSchema = z.object({
	name: z
		.string()
		.min(1, "Space name is required")
		.max(25, "Space name must be at most 25 characters"),
	members: z.array(z.string()).optional(),
});

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
	const { activeOrganization } = useDashboardContext();

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

						if (edit && space?.id) {
							formData.append("id", space.id);
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
					} catch (error: any) {
						console.error(
							edit ? "Error updating space:" : "Error creating space:",
							error,
						);
						toast.error(
							error?.message ||
								error?.error ||
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

					<div className="space-y-1">
						<Label htmlFor="icon">Space Icon</Label>
						<CardDescription className="w-full max-w-[400px]">
							Upload a custom logo or icon for your space (max 1MB).
						</CardDescription>
					</div>

					<div className="relative mt-2">
						<FileInput
							id="space-icon"
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
