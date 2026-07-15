"use client";

import { Button, Input, Label, Select } from "@cap/ui";
import type { Organisation } from "@cap/web-domain";
import {
	ChevronRightIcon,
	DatabaseIcon,
	FolderOpenIcon,
	InfoIcon,
	VideoIcon,
} from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useId, useState, useTransition } from "react";
import { toast } from "sonner";
import {
	connectOrganizationGoogleDrive,
	disconnectOrganizationGoogleDrive,
	getOrganizationGoogleDrivePickerToken,
	listOrganizationGoogleDriveFolders,
	type OrganizationGoogleDriveFolder,
	type OrganizationStorageSettings,
	removeOrganizationS3Config,
	saveOrganizationS3Config,
	setOrganizationGoogleDriveLocation,
	setOrganizationStorageProvider,
	testOrganizationS3Config,
} from "@/actions/organization/storage";
import { useDashboardContext } from "@/app/(org)/dashboard/Contexts";

const defaultS3Config = {
	provider: "aws",
	accessKeyId: "",
	secretAccessKey: "",
	endpoint: "https://s3.amazonaws.com",
	bucketName: "",
	region: "us-east-1",
};

const s3ProviderOptions = [
	{ value: "aws", label: "AWS S3" },
	{ value: "cloudflare", label: "Cloudflare R2" },
	{ value: "supabase", label: "Supabase" },
	{ value: "minio", label: "MinIO" },
	{ value: "other", label: "其他 S3 兼容服务" },
];

const proRequiredMessage =
	"Cap Pro is required to manage organization integrations";

const getOrganizationId = (settings: OrganizationStorageSettings) =>
	settings.organization.id as Organisation.OrganisationId;

function StatusBadge({
	configured,
	active,
}: {
	configured: boolean;
	active: boolean;
}) {
	if (active) {
		return (
			<span className="inline-flex items-center gap-1 px-2 py-0.5 text-[11px] font-medium rounded-md bg-green-500/10 text-green-600">
				<span className="size-1.5 rounded-full bg-green-500" />
				已启用
			</span>
		);
	}

	if (configured) {
		return (
			<span className="inline-flex items-center gap-1 px-2 py-0.5 text-[11px] font-medium rounded-md bg-blue-500/10 text-blue-600">
				<span className="size-1.5 rounded-full bg-blue-500" />
				已连接
			</span>
		);
	}

	return (
		<span className="inline-flex items-center px-2 py-0.5 text-[11px] font-medium rounded-md bg-gray-3 text-gray-9">
			未配置
		</span>
	);
}

export function OrganizationStorageIntegrations({
	initialSettings,
}: {
	initialSettings: OrganizationStorageSettings;
}) {
	const router = useRouter();
	const { user, setUpgradeModalOpen } = useDashboardContext();
	const [settings, setSettings] = useState(initialSettings);
	const [s3Config, setS3Config] = useState(
		initialSettings.s3 ?? defaultS3Config,
	);
	const [isPending, startTransition] = useTransition();
	const [expandedIntegration, setExpandedIntegration] = useState<
		"s3" | "googleDrive" | null
	>(null);
	const [folderBrowserOpen, setFolderBrowserOpen] = useState(false);
	const [folderBrowserParent, setFolderBrowserParent] = useState({
		id: "root",
		name: "我的云端硬盘",
	});
	const [folderBrowserHistory, setFolderBrowserHistory] = useState<
		Array<{ id: string; name: string }>
	>([]);
	const [folderBrowserFolders, setFolderBrowserFolders] = useState<
		OrganizationGoogleDriveFolder[]
	>([]);
	const [folderBrowserLoading, setFolderBrowserLoading] = useState(false);
	const organizationId = getOrganizationId(settings);
	const regionId = useId();
	const bucketId = useId();
	const endpointId = useId();
	const accessKeyId = useId();
	const secretKeyId = useId();

	useEffect(() => {
		setSettings(initialSettings);
		setS3Config(initialSettings.s3 ?? defaultS3Config);
	}, [initialSettings]);

	const requirePro = () => {
		if (user.isPro) return true;
		setUpgradeModalOpen(true);
		return false;
	};

	const runMutation = (
		action: () => Promise<unknown>,
		successMessage: string,
	) => {
		if (!requirePro()) return;

		startTransition(async () => {
			try {
				await action();
				toast.success(successMessage);
				router.refresh();
			} catch (error) {
				if (error instanceof Error && error.message === proRequiredMessage) {
					setUpgradeModalOpen(true);
					return;
				}

				toast.error(error instanceof Error ? error.message : "请求失败");
			}
		});
	};

	const saveS3 = () =>
		runMutation(
			() =>
				saveOrganizationS3Config({
					organizationId,
					provider: s3Config.provider,
					accessKeyId: s3Config.accessKeyId,
					secretAccessKey: s3Config.secretAccessKey,
					endpoint: s3Config.endpoint,
					bucketName: s3Config.bucketName,
					region: s3Config.region,
				}),
			"S3 配置已保存",
		);

	const testS3 = () =>
		runMutation(
			() =>
				testOrganizationS3Config({
					organizationId,
					provider: s3Config.provider,
					accessKeyId: s3Config.accessKeyId,
					secretAccessKey: s3Config.secretAccessKey,
					endpoint: s3Config.endpoint,
					bucketName: s3Config.bucketName,
					region: s3Config.region,
				}),
			"S3 连接已验证",
		);

	const connectDrive = () =>
		runMutation(async () => {
			const { url } = await connectOrganizationGoogleDrive(organizationId);
			window.location.href = url;
		}, "正在打开 Google 云端硬盘授权");

	const disconnectDrive = () =>
		runMutation(
			() => disconnectOrganizationGoogleDrive(organizationId),
			"Google 云端硬盘已断开连接",
		);

	const setActiveProvider = (provider: "s3" | "googleDrive") =>
		runMutation(
			() => setOrganizationStorageProvider({ organizationId, provider }),
			provider === "s3" ? "S3 已启用" : "Google 云端硬盘已启用",
		);

	const loadFolderBrowser = async (
		parent: { id: string; name: string },
		history: Array<{ id: string; name: string }>,
	) => {
		if (!requirePro()) return;

		setFolderBrowserLoading(true);
		try {
			const { folders } = await listOrganizationGoogleDriveFolders({
				organizationId,
				parentId: parent.id,
			});
			setFolderBrowserParent(parent);
			setFolderBrowserHistory(history);
			setFolderBrowserFolders(folders);
			setFolderBrowserOpen(true);
		} catch (error) {
			if (error instanceof Error && error.message === proRequiredMessage) {
				setUpgradeModalOpen(true);
				return;
			}

			toast.error(
				error instanceof Error ? error.message : "加载云端硬盘文件夹失败",
			);
		} finally {
			setFolderBrowserLoading(false);
		}
	};

	const openFolderBrowser = () => {
		startTransition(async () => {
			await loadFolderBrowser({ id: "root", name: "我的云端硬盘" }, []);
		});
	};

	const openChildFolder = (folder: OrganizationGoogleDriveFolder) => {
		startTransition(async () => {
			await loadFolderBrowser({ id: folder.id, name: folder.name }, [
				...folderBrowserHistory,
				folderBrowserParent,
			]);
		});
	};

	const openParentFolder = () => {
		const parent = folderBrowserHistory.at(-1);
		if (!parent) return;
		startTransition(async () => {
			await loadFolderBrowser(parent, folderBrowserHistory.slice(0, -1));
		});
	};

	const selectDriveFolder = (folder: OrganizationGoogleDriveFolder) =>
		runMutation(async () => {
			await setOrganizationGoogleDriveLocation({
				organizationId,
				folderId: folder.id,
				folderName: folder.name,
				driveId: folder.driveId,
				driveName: folder.driveName,
			});
			setFolderBrowserOpen(false);
		}, "Google 云端硬盘位置已更新");

	const selectCurrentDriveFolder = () =>
		selectDriveFolder({
			id: folderBrowserParent.id,
			name: folderBrowserParent.name,
			driveId: null,
			driveName: null,
		});

	const toggleExpand = (integration: "s3" | "googleDrive") => {
		if (!requirePro()) return;

		setExpandedIntegration((prev) =>
			prev === integration ? null : integration,
		);
	};

	const bothConfigured =
		!!settings.s3?.configured && !!settings.googleDrive?.connected;
	const hasDriveLocation = !!settings.googleDrive?.folderId;
	const selectedDriveName = settings.googleDrive?.driveName ?? "我的云端硬盘";
	const selectedFolderName = settings.googleDrive?.folderName ?? null;
	const driveIsActive =
		bothConfigured && settings.activeProvider === "googleDrive";
	const folderBreadcrumb = selectedFolderName
		? `${selectedDriveName} › ${selectedFolderName}`
		: selectedDriveName;
	const filePathPreview = `${selectedFolderName ?? selectedDriveName} / 用户-ID / 视频-ID`;

	return (
		<div className="flex flex-col gap-4">
			<div className="flex items-center gap-2 px-1">
				<InfoIcon className="size-3.5 text-gray-9 shrink-0" />
				<p className="text-[12px] text-gray-9">
					存储设置适用于 {settings.organization.name}{" "}
					的所有成员。管理员和所有者可以管理集成。
				</p>
			</div>

			{bothConfigured && (
				<div className="flex items-center justify-between px-3 py-2.5 rounded-lg border border-gray-3 bg-gray-2">
					<p className="text-[12px] text-gray-11">当前存储服务</p>
					<div className="flex items-center rounded-md bg-gray-3 p-0.5 gap-0.5">
						<button
							type="button"
							className={`px-2.5 py-1 text-[11px] font-medium rounded transition-all cursor-pointer ${
								settings.activeProvider === "s3"
									? "bg-gray-12 text-gray-1 shadow-sm"
									: "text-gray-10 hover:text-gray-12"
							}`}
							onClick={() => setActiveProvider("s3")}
							disabled={isPending}
						>
							S3
						</button>
						<button
							type="button"
							className={`px-2.5 py-1 text-[11px] font-medium rounded transition-all cursor-pointer ${
								settings.activeProvider === "googleDrive"
									? "bg-gray-12 text-gray-1 shadow-sm"
									: "text-gray-10 hover:text-gray-12"
							}`}
							onClick={() => setActiveProvider("googleDrive")}
							disabled={!hasDriveLocation || isPending}
						>
							Google Drive
						</button>
					</div>
				</div>
			)}

			<div className="rounded-xl border border-gray-3 overflow-hidden">
				<button
					type="button"
					onClick={() => toggleExpand("s3")}
					className="w-full flex items-center gap-3 px-3.5 py-3 text-left hover:bg-gray-2 transition-colors cursor-pointer"
				>
					<DatabaseIcon className="size-4 shrink-0 text-gray-10" />
					<span className="flex-1 text-[13px] font-medium text-gray-12">
						S3 兼容存储
					</span>
					<StatusBadge
						configured={!!settings.s3?.configured}
						active={bothConfigured && settings.activeProvider === "s3"}
					/>
					<ChevronRightIcon
						className={`size-3.5 text-gray-8 transition-transform duration-150 shrink-0 ${
							expandedIntegration === "s3" ? "rotate-90" : ""
						}`}
					/>
				</button>

				{expandedIntegration === "s3" && (
					<div className="border-t border-gray-3 px-3.5 py-4">
						<p className="text-[12px] text-gray-10 mb-4">
							连接你自己的存储桶以获得完整控制权。{" "}
							<a
								href="https://cap.so/docs/s3-config"
								target="_blank"
								rel="noopener noreferrer"
								className="underline text-gray-12 hover:text-gray-11"
							>
								设置指南
							</a>
						</p>
						<div className="grid gap-3 md:grid-cols-2">
							<div className="flex flex-col gap-1">
								<Label className="text-[11px]">服务商</Label>
								<Select
									value={s3Config.provider}
									onValueChange={(value) =>
										setS3Config((current) => ({
											...current,
											provider: value,
										}))
									}
									placeholder="选择服务商"
									options={s3ProviderOptions}
								/>
							</div>
							<div className="flex flex-col gap-1">
								<Label htmlFor={accessKeyId} className="text-[11px]">
									访问密钥 ID
								</Label>
								<Input
									id={accessKeyId}
									type="password"
									value={s3Config.accessKeyId}
									placeholder={
										settings.s3?.configured ? "已安全存储" : "PL31OADSQNK"
									}
									autoComplete="off"
									onChange={(event) =>
										setS3Config((current) => ({
											...current,
											accessKeyId: event.target.value,
										}))
									}
								/>
							</div>
							<div className="flex flex-col gap-1">
								<Label htmlFor={secretKeyId} className="text-[11px]">
									秘密访问密钥
								</Label>
								<Input
									id={secretKeyId}
									type="password"
									value={s3Config.secretAccessKey}
									placeholder={
										settings.s3?.configured ? "已安全存储" : "PL31OADSQNK"
									}
									autoComplete="off"
									onChange={(event) =>
										setS3Config((current) => ({
											...current,
											secretAccessKey: event.target.value,
										}))
									}
								/>
							</div>
							<div className="flex flex-col gap-1">
								<Label htmlFor={endpointId} className="text-[11px]">
									端点
								</Label>
								<Input
									id={endpointId}
									value={s3Config.endpoint}
									placeholder="https://s3.amazonaws.com"
									onChange={(event) =>
										setS3Config((current) => ({
											...current,
											endpoint: event.target.value,
										}))
									}
								/>
							</div>
							<div className="flex flex-col gap-1">
								<Label htmlFor={bucketId} className="text-[11px]">
									存储桶名称
								</Label>
								<Input
									id={bucketId}
									value={s3Config.bucketName}
									placeholder="my-bucket"
									onChange={(event) =>
										setS3Config((current) => ({
											...current,
											bucketName: event.target.value,
										}))
									}
								/>
							</div>
							<div className="flex flex-col gap-1">
								<Label htmlFor={regionId} className="text-[11px]">
									区域
								</Label>
								<Input
									id={regionId}
									value={s3Config.region}
									placeholder="us-east-1"
									onChange={(event) =>
										setS3Config((current) => ({
											...current,
											region: event.target.value,
										}))
									}
								/>
							</div>
						</div>
						<div className="flex items-center gap-2 mt-4 pt-3 border-t border-gray-3">
							<Button
								type="button"
								size="xs"
								onClick={saveS3}
								disabled={isPending}
							>
								保存
							</Button>
							<Button
								type="button"
								size="xs"
								variant="gray"
								onClick={testS3}
								disabled={isPending}
							>
								测试
							</Button>
							{settings.s3?.configured && (
								<Button
									type="button"
									size="xs"
									variant="destructive"
									onClick={() =>
										runMutation(
											() => removeOrganizationS3Config(organizationId),
											"S3 配置已移除",
										)
									}
									disabled={isPending}
								>
									移除
								</Button>
							)}
						</div>
					</div>
				)}
			</div>

			<div className="rounded-xl border border-gray-3 overflow-hidden">
				<button
					type="button"
					onClick={() => toggleExpand("googleDrive")}
					className="w-full flex items-center gap-3 px-3.5 py-3 text-left hover:bg-gray-2 transition-colors cursor-pointer"
				>
					<svg
						aria-hidden="true"
						className="size-4 shrink-0"
						viewBox="0 0 87.3 78"
						xmlns="http://www.w3.org/2000/svg"
					>
						<path
							d="m6.6 66.85 3.85 6.65c.8 1.4 1.95 2.5 3.3 3.3l13.75-23.8h-27.5c0 1.55.4 3.1 1.2 4.5z"
							fill="#0066da"
						/>
						<path
							d="m43.65 25-13.75-23.8c-1.35.8-2.5 1.9-3.3 3.3l-25.4 44a9.06 9.06 0 0 0 -1.2 4.5h27.5z"
							fill="#00ac47"
						/>
						<path
							d="m73.55 76.8c1.35-.8 2.5-1.9 3.3-3.3l1.6-2.75 7.65-13.25c.8-1.4 1.2-2.95 1.2-4.5h-27.502l5.852 11.5z"
							fill="#ea4335"
						/>
						<path
							d="m43.65 25 13.75-23.8c-1.35-.8-2.9-1.2-4.5-1.2h-18.5c-1.6 0-3.15.45-4.5 1.2z"
							fill="#00832d"
						/>
						<path
							d="m59.8 53h-32.3l-13.75 23.8c1.35.8 2.9 1.2 4.5 1.2h50.8c1.6 0 3.15-.45 4.5-1.2z"
							fill="#2684fc"
						/>
						<path
							d="m73.4 26.5-12.7-22c-.8-1.4-1.95-2.5-3.3-3.3l-13.75 23.8 16.15 28h27.45c0-1.55-.4-3.1-1.2-4.5z"
							fill="#ffba00"
						/>
					</svg>
					<span className="flex-1 text-[13px] font-medium text-gray-12">
						Google Drive
					</span>
					<StatusBadge
						configured={!!settings.googleDrive?.connected}
						active={bothConfigured && settings.activeProvider === "googleDrive"}
					/>
					<ChevronRightIcon
						className={`size-3.5 text-gray-8 transition-transform duration-150 shrink-0 ${
							expandedIntegration === "googleDrive" ? "rotate-90" : ""
						}`}
					/>
				</button>

				{expandedIntegration === "googleDrive" && (
					<div className="border-t border-gray-3 px-3.5 py-4">
						{settings.googleDrive?.connected ? (
							<div className="flex flex-col gap-3">
								{settings.googleDrive.email && (
									<p className="text-[12px] text-gray-10">
										连接账户：{" "}
										<span className="text-gray-12 font-medium">
											{settings.googleDrive.email}
										</span>
									</p>
								)}

								<div className="flex flex-col gap-3 rounded-lg border border-gray-3 bg-gray-2 p-3">
									<div className="flex items-center justify-between">
										<p className="text-[12px] font-medium text-gray-12">
											存储位置
										</p>
										{driveIsActive ? (
											<span className="inline-flex items-center gap-1 px-2 py-0.5 text-[11px] font-medium rounded-md bg-green-500/10 text-green-600">
												<span className="size-1.5 rounded-full bg-green-500" />
												已启用
											</span>
										) : (
											<span className="text-[11px] text-gray-9">
												{hasDriveLocation
													? bothConfigured
														? "未启用"
														: "可启用"
													: "选择文件夹后即可启用"}
											</span>
										)}
									</div>

									<div className="flex items-center gap-3 rounded-md bg-gray-3 px-3 py-2.5">
										<div className="flex items-center justify-center size-8 rounded-md bg-gray-1 shrink-0">
											<FolderOpenIcon className="size-4 text-gray-10" />
										</div>
										<div className="min-w-0 flex-1">
											<p className="text-[10px] text-gray-9">文件夹</p>
											<p className="truncate text-[12px] font-medium text-gray-12">
												{folderBreadcrumb}
											</p>
										</div>
										<Button
											type="button"
											size="xs"
											variant="gray"
											onClick={openFolderBrowser}
											disabled={isPending || folderBrowserLoading}
										>
											更改
										</Button>
									</div>

									{hasDriveLocation && (
										<div className="flex items-center gap-2 rounded-md bg-gray-3 px-3 py-2 text-[11px] text-gray-10">
											<VideoIcon className="size-3.5 shrink-0 text-gray-9" />
											<span className="text-gray-9">录制保存路径</span>
											<span className="min-w-0 truncate text-gray-12 font-medium">
												{filePathPreview}
											</span>
										</div>
									)}

									{!driveIsActive && (
										<div className="flex justify-end pt-0.5">
											<Button
												type="button"
												size="xs"
												onClick={() => setActiveProvider("googleDrive")}
												disabled={!hasDriveLocation || isPending}
											>
												启用
											</Button>
										</div>
									)}
								</div>

								{folderBrowserOpen && (
									<div className="flex flex-col gap-2 rounded-lg border border-gray-3 p-3">
										<div className="flex items-center justify-between gap-2">
											<div className="min-w-0">
												<p className="text-[10px] text-gray-9">
													浏览 Google 云端硬盘
												</p>
												<p className="truncate text-[12px] font-medium text-gray-12">
													{folderBrowserParent.name}
												</p>
											</div>
											<div className="flex gap-1.5">
												<Button
													type="button"
													size="xs"
													variant="gray"
													onClick={openParentFolder}
													disabled={
														folderBrowserHistory.length === 0 ||
														folderBrowserLoading
													}
												>
													返回
												</Button>
												<Button
													type="button"
													size="xs"
													onClick={selectCurrentDriveFolder}
													disabled={folderBrowserLoading || isPending}
												>
													使用此文件夹
												</Button>
											</div>
										</div>
										<div className="flex flex-col gap-1">
											{folderBrowserLoading ? (
												<div className="rounded-md bg-gray-2 px-3 py-2 text-[12px] text-gray-10">
													正在加载…
												</div>
											) : folderBrowserFolders.length > 0 ? (
												folderBrowserFolders.map((folder) => (
													<div
														key={folder.id}
														className="flex items-center gap-2.5 rounded-md bg-gray-2 px-2.5 py-2"
													>
														<FolderOpenIcon className="size-3.5 shrink-0 text-gray-9" />
														<p className="min-w-0 flex-1 truncate text-[12px] text-gray-12">
															{folder.name}
														</p>
														<Button
															type="button"
															size="xs"
															variant="gray"
															onClick={() => openChildFolder(folder)}
															disabled={folderBrowserLoading}
														>
															打开
														</Button>
														<Button
															type="button"
															size="xs"
															onClick={() => selectDriveFolder(folder)}
															disabled={isPending}
														>
															选择
														</Button>
													</div>
												))
											) : (
												<div className="rounded-md bg-gray-2 px-3 py-2 text-[12px] text-gray-10">
													未找到文件夹
												</div>
											)}
										</div>
									</div>
								)}

								<div className="flex items-center gap-2 pt-2 border-t border-gray-3">
									<Button
										type="button"
										size="xs"
										variant="gray"
										onClick={() =>
											runMutation(
												() =>
													getOrganizationGoogleDrivePickerToken(organizationId),
												"Google 云端硬盘连接已验证",
											)
										}
										disabled={isPending}
									>
										测试
									</Button>
									<Button
										type="button"
										size="xs"
										variant="destructive"
										onClick={disconnectDrive}
										disabled={isPending}
									>
										断开连接
									</Button>
								</div>
							</div>
						) : (
							<div className="flex items-center justify-between gap-3">
								<p className="text-[12px] text-gray-10">
									关联 Google
									账户，将上传内容存储在云端硬盘的“Cap”文件夹中。连接后可以更改存储位置。
								</p>
								<Button
									type="button"
									size="xs"
									onClick={connectDrive}
									disabled={isPending}
								>
									连接
								</Button>
							</div>
						)}
					</div>
				)}
			</div>
		</div>
	);
}
