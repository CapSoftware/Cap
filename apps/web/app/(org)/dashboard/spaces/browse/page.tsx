"use client";

import { Button, Input } from "@cap/ui";
import {
	faEdit,
	faLayerGroup,
	faPlus,
	faTrash,
} from "@fortawesome/free-solid-svg-icons";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { Search } from "lucide-react";
import { useParams, useRouter } from "next/navigation";
import { useState } from "react";
import { toast } from "sonner";

import { deleteSpace } from "@/actions/organization/delete-space";
import { SignedImageUrl } from "@/components/SignedImageUrl";
import {
	normalizeOrganizationRole,
	normalizeSpaceRole,
	organizationRoleLabel,
	spaceRoleLabel,
} from "@/lib/permissions/roles";
import { ConfirmationDialog } from "../../_components/ConfirmationDialog";
import SpaceDialog, {
	type NewSpaceFormProps,
} from "../../_components/Navbar/SpaceDialog";
import { useDashboardContext } from "../../Contexts";
import type { Spaces } from "../../dashboard-data";

export default function BrowseSpacesPage() {
	const { spacesData, user, activeOrganization } = useDashboardContext();
	const [showSpaceDialog, setShowSpaceDialog] = useState(false);
	const [editSpace, setEditSpace] = useState<NewSpaceFormProps["space"]>(null);
	const [searchQuery, setSearchQuery] = useState("");

	const trueActiveOrgMembers = activeOrganization?.members.filter(
		(m) => m.user?.id !== user?.id,
	);

	const filteredSpaces = spacesData?.filter((space: Spaces) =>
		space.name.toLowerCase().includes(searchQuery.toLowerCase()),
	);
	const router = useRouter();
	const params = useParams();

	const [confirmOpen, setConfirmOpen] = useState(false);
	const [pendingDeleteSpace, setPendingDeleteSpace] = useState<Spaces | null>(
		null,
	);
	const [removing, setRemoving] = useState(false);

	const handleDeleteSpace = (e: React.MouseEvent, space: Spaces) => {
		e.preventDefault();
		e.stopPropagation();
		setPendingDeleteSpace(space);
		setConfirmOpen(true);
	};

	const getRoleLabel = (role: Spaces["currentUserRole"]) => {
		const organizationRole = normalizeOrganizationRole(role);
		if (organizationRole) return organizationRoleLabel(organizationRole);
		const spaceRole = normalizeSpaceRole(role);
		return spaceRole ? spaceRoleLabel(spaceRole) : "成员";
	};

	const confirmRemoveSpace = async () => {
		if (!pendingDeleteSpace) return;
		setRemoving(true);
		try {
			const result = await deleteSpace(pendingDeleteSpace.id);
			if (result.success) {
				toast.success("空间已删除");
				router.refresh();
				if (params.spaceId === pendingDeleteSpace.id) {
					router.push("/dashboard");
				}
			} else {
				toast.error(result.error || "删除空间失败");
			}
		} catch (error) {
			console.error("删除空间时出错：", error);
			toast.error("删除空间失败");
		} finally {
			setRemoving(false);
			setConfirmOpen(false);
			setPendingDeleteSpace(null);
		}
	};

	return (
		<>
			<div className="flex flex-wrap gap-3 justify-between items-start w-full">
				<Button
					onClick={() => setShowSpaceDialog(true)}
					size="sm"
					variant="dark"
				>
					<FontAwesomeIcon className="size-3" icon={faPlus} />
					创建空间
				</Button>
				<div className="flex relative w-full max-w-md">
					<div className="flex absolute inset-y-0 left-3 items-center pointer-events-none">
						<Search className="size-4 text-gray-9" />
					</div>
					<Input
						type="text"
						placeholder="搜索空间……"
						className="flex-1 pr-3 pl-8 w-full min-w-full text-sm placeholder-gray-8"
						value={searchQuery}
						onChange={(e) => setSearchQuery(e.target.value)}
					/>
				</div>
			</div>
			<div className="overflow-x-auto rounded-xl border border-gray-3">
				<table className="min-w-full bg-gray-1">
					<thead>
						<tr className="text-sm text-left text-gray-10">
							<th className="px-6 py-3 font-medium">名称</th>
							<th className="px-6 py-3 font-medium">成员</th>
							<th className="px-6 py-3 font-medium">视频</th>
							<th className="px-6 py-3 font-medium">角色</th>
							<th className="px-6 py-3 font-medium">操作</th>
						</tr>
					</thead>
					<tbody>
						{!spacesData && (
							<tr>
								<td colSpan={5} className="px-6 py-6 text-center text-gray-8">
									正在加载空间……
								</td>
							</tr>
						)}
						{spacesData && filteredSpaces && filteredSpaces.length === 0 && (
							<tr>
								<td colSpan={5} className="px-6 py-6 text-center text-gray-8">
									未找到空间。
								</td>
							</tr>
						)}
						{filteredSpaces?.map((space: Spaces) => {
							return (
								<tr
									key={space.id}
									onClick={() => router.push(`/dashboard/spaces/${space.id}`)}
									className="border-t transition-colors cursor-pointer hover:bg-gray-2 border-gray-3"
								>
									<td className="flex gap-3 items-center px-6 py-4">
										<SignedImageUrl
											image={space.iconUrl}
											name={space.name}
											className="relative flex-shrink-0 size-7"
											letterClass="text-sm"
										/>
										<span className="text-sm font-semibold text-gray-12">
											{space.name}
										</span>
									</td>
									<td className="px-6 py-4 text-sm text-gray-12">
										{space.memberCount} 位成员
									</td>
									<td className="px-6 py-4 text-sm text-gray-12">
										{space.videoCount} 个视频
									</td>
									<td className="px-6 py-4 text-sm text-gray-12">
										{getRoleLabel(space.currentUserRole)}
									</td>
									<td className="px-6">
										{space.currentUserCanManage && !space.primary ? (
											<div className="flex gap-2">
												<Button
													variant="gray"
													className="size-8 p-0 min-w-[unset]"
													size="sm"
													onClick={(e) => {
														e.stopPropagation();
														setEditSpace({
															id: space.id,
															name: space.name,
															members: (trueActiveOrgMembers || []).map(
																(m: { user: { id: string } }) => m.user.id,
															),
															iconUrl: space.iconUrl ?? undefined,
															settings: space.settings,
															hasPassword: space.hasPassword,
															public: space.public,
														});
														setShowSpaceDialog(true);
													}}
												>
													<FontAwesomeIcon icon={faEdit} className="size-3" />
												</Button>
												<Button
													variant="gray"
													onClick={(e) => handleDeleteSpace(e, space)}
													className="size-8 p-0 min-w-[unset]"
													size="sm"
												>
													<FontAwesomeIcon icon={faTrash} className="size-3" />
												</Button>
											</div>
										) : (
											<div className="h-8 text-gray-10">
												<p>...</p>
											</div>
										)}
									</td>
								</tr>
							);
						})}
					</tbody>
				</table>
			</div>
			<SpaceDialog
				open={showSpaceDialog}
				onClose={() => {
					setShowSpaceDialog(false);
					setEditSpace(null);
				}}
				edit={!!editSpace}
				space={editSpace}
				onSpaceUpdated={() => {
					setShowSpaceDialog(false);
					setEditSpace(null);
					router.refresh();
				}}
			/>
			<ConfirmationDialog
				open={confirmOpen}
				icon={<FontAwesomeIcon icon={faLayerGroup} />}
				title="删除空间"
				description={
					pendingDeleteSpace
						? `确定要删除空间“${pendingDeleteSpace?.name || "所选空间"}”吗？此操作无法撤销。`
						: "确定要删除此空间吗？此操作无法撤销。"
				}
				confirmLabel={removing ? "正在删除……" : "删除"}
				cancelLabel="取消"
				loading={removing}
				onConfirm={confirmRemoveSpace}
				onCancel={() => {
					setConfirmOpen(false);
					setPendingDeleteSpace(null);
				}}
			/>
		</>
	);
}
