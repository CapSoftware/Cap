"use client";

import {
	Button,
	Card,
	CardDescription,
	CardTitle,
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
import { Effect, Option } from "effect";
import { LogOut } from "lucide-react";
import { useRouter } from "next/navigation";
import { signOut } from "next-auth/react";
import { useEffect, useId, useState } from "react";
import { toast } from "sonner";
import { SignedImageUrl } from "@/components/SignedImageUrl";
import { useEffectMutation, useRpcClient } from "@/lib/EffectRuntime";
import { useDashboardContext } from "../../Contexts";
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
			toast.success("姓名已更新");
			router.refresh();
		},
		onError: () => {
			toast.error("更新姓名失败");
		},
	});

	const signOutAllDevicesMutation = useMutation({
		mutationFn: signOutAllDevices,
		onSuccess: () => {
			toast.success("已从所有设备退出登录");
			setSignOutAllDevicesOpen(false);
			signOut({ callbackUrl: "/login" });
		},
		onError: () => {
			toast.error("从所有设备退出登录失败");
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
			toast.success("头像已更新");
			router.refresh();
		},
		onError: (error) => {
			console.error("Error uploading profile image:", error);
			setProfileImageOverride(undefined);
			toast.error(error instanceof Error ? error.message : "上传头像失败");
		},
	});

	const removeProfileImageMutation = useEffectMutation({
		mutationFn: () => rpc.UserUpdate({ id: user.id, image: Option.none() }),
		onSuccess: () => {
			setProfileImageOverride(null);
			toast.success("头像已移除");
			router.refresh();
		},
		onError: (error) => {
			console.error("Error removing profile image:", error);
			setProfileImageOverride(initialProfileImage);
			toast.error(error instanceof Error ? error.message : "移除头像失败");
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
				<div className="grid gap-6 w-full md:grid-cols-2">
					<Card className="space-y-4">
						<div className="space-y-1">
							<CardTitle>头像</CardTitle>
							<CardDescription>
								此图片会显示在你的个人资料、评论和共享录制中。
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
							<CardTitle>你的姓名</CardTitle>
							<CardDescription>
								修改姓名后，共享录制和个人资料中显示的姓名也会更新。
							</CardDescription>
						</div>
						<div className="flex flex-col flex-wrap gap-3 w-full">
							<div className="flex-1">
								<Input
									type="text"
									placeholder="名字"
									onChange={(e) => setFirstName(e.target.value)}
									defaultValue={firstName as string}
									id={firstNameId}
									name="firstName"
								/>
							</div>
							<div className="flex-1 space-y-2">
								<Input
									type="text"
									placeholder="姓氏"
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
							<CardTitle>联系邮箱</CardTitle>
							<CardDescription>
								这是你注册 Cap 时使用的邮箱地址。
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
							<CardTitle>默认组织</CardTitle>
							<CardDescription>登录后将默认进入此组织。</CardDescription>
						</div>

						<Select
							placeholder="默认组织"
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
					{updateNamePending ? "正在保存…" : "保存"}
				</Button>
			</form>
			<Card className="flex flex-col gap-4 mt-6 md:flex-row md:items-center md:justify-between">
				<div className="space-y-1">
					<CardTitle>从所有设备退出登录</CardTitle>
					<CardDescription>
						使与你的账户关联的所有 Cap 网页会话和桌面应用认证令牌失效。
					</CardDescription>
				</div>
				<Button
					type="button"
					size="sm"
					variant="destructive"
					icon={<LogOut className="size-4" />}
					onClick={() => setSignOutAllDevicesOpen(true)}
				>
					从所有设备退出登录
				</Button>
			</Card>
			<Dialog
				open={signOutAllDevicesOpen}
				onOpenChange={setSignOutAllDevicesOpen}
			>
				<DialogContent>
					<DialogHeader
						icon={<LogOut className="size-4" />}
						description="这将立即使你账户现有的 Cap 网页会话、桌面会话令牌和桌面 API 密钥失效。"
					>
						<DialogTitle>从所有设备退出登录？</DialogTitle>
					</DialogHeader>
					<div className="p-5 space-y-3 text-sm text-gray-11">
						<p>重置完成后，你将从当前浏览器退出登录。</p>
						<p>
							Cap
							桌面应用可能需要你先点击“退出登录”，然后重新登录，上传和设置同步才能恢复。
						</p>
					</div>
					<DialogFooter>
						<Button
							type="button"
							size="sm"
							variant="gray"
							onClick={() => setSignOutAllDevicesOpen(false)}
						>
							取消
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
								? "正在退出…"
								: "从所有设备退出登录"}
						</Button>
					</DialogFooter>
				</DialogContent>
			</Dialog>
		</>
	);
};
