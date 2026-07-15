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
							? "管理详细信息、分享方式和观看者权限。"
							: "创建一个供团队协作的空间。"
					}
				>
					<DialogTitle className="text-lg text-gray-12">
						{edit ? "编辑空间" : "创建新空间"}
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
						取消
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
								? "正在保存……"
								: "正在创建……"
							: edit
								? "保存"
								: "创建"}
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
		.min(1, "请输入空间名称")
		.max(25, "空间名称最多可包含 25 个字符"),
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
		label: "启用评论",
		value: "disableComments",
		description: "允许观看者评论此空间中的录制内容",
	},
	{
		label: "启用摘要",
		value: "disableSummary",
		description: "显示此空间中录制内容的 AI 摘要",
		pro: true,
	},
	{
		label: "启用字幕",
		value: "disableCaptions",
		description: "允许观看者使用此空间中录制内容的字幕",
	},
	{
		label: "启用章节",
		value: "disableChapters",
		description: "显示此空间中录制内容的 AI 章节",
		pro: true,
	},
	{
		label: "启用回应",
		value: "disableReactions",
		description: "允许观看者回应此空间中的录制内容",
	},
	{
		label: "启用文字稿",
		value: "disableTranscript",
		description: "启用后也会允许显示摘要和章节",
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
				toast.error("文件大小必须小于 1 MB");
				return;
			}
			// Validate file type
			if (!file.type.startsWith("image/")) {
				toast.error("文件必须是图片");
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
								throw new Error("请输入空间密码");
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
								throw new Error(result.error || "更新空间失败");
							}
							toast.success("空间已更新");
							router.refresh();
						} else {
							if (passwordEnabled && !passwordValue.trim()) {
								throw new Error("请输入空间密码");
							}
							const result = await createSpace(formData);
							if (!result.success) {
								throw new Error(result.error || "创建空间失败");
							}
							toast.success("空间已创建");
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
									? "更新空间失败"
									: "创建空间失败";
						toast.error(message || (edit ? "更新空间失败" : "创建空间失败"));
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
							title="详细信息"
							description="为你的空间命名并选择空间成员。"
						/>
						<div className="grid grid-cols-1 gap-4 md:grid-cols-2 md:items-start">
							<div className="space-y-4">
								<FormField
									control={form.control}
									name="name"
									render={({ field }) => (
										<FormControl>
											<Input
												placeholder="空间名称"
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
										<Label htmlFor={iconInputId}>空间图标</Label>
										<CardDescription>
											自定义徽标或图标（最大 1 MB）。
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
									<Label htmlFor="members">成员</Label>
									<CardDescription>将团队成员添加到此空间。</CardDescription>
								</div>
								<FormField
									control={form.control}
									name="members"
									render={({ field }) => (
										<FormControl>
											<MemberSelect
												placeholder="添加成员……"
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
						<SectionLabel title="分享" description="控制他人如何访问此空间。" />
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
												需要密码
											</p>
											<p className="text-xs text-gray-10">
												保护此空间中的所有录制内容
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
												space?.hasPassword ? "输入新密码" : "设置密码"
											}
										/>
										{space?.hasPassword && !passwordValue && (
											<p className="text-xs text-gray-9">留空以保留现有密码</p>
										)}
									</div>
								)}
							</div>
						</div>
					</section>

					{/* Viewer permissions */}
					<section className="space-y-3">
						<SectionLabel
							title="观看者权限"
							description="这些设置适用于此空间中分享的所有录制内容。"
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
