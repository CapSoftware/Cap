"use client";

import { buildEnv } from "@cap/env";
import {
	Button,
	Card,
	CardDescription,
	CardHeader,
	CardTitle,
	Select,
	Switch,
	Table,
	TableBody,
	TableCell,
	TableHead,
	TableHeader,
	TableRow,
} from "@cap/ui";
import { faUser } from "@fortawesome/free-solid-svg-icons";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { useMutation } from "@tanstack/react-query";
import { format } from "date-fns";
import { zhCN } from "date-fns/locale";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { toast } from "sonner";
import { removeOrganizationInvite } from "@/actions/organization/remove-invite";
import { removeOrganizationMember } from "@/actions/organization/remove-member";
import { toggleProSeat } from "@/actions/organization/toggle-pro-seat";
import { updateOrganizationMemberRole } from "@/actions/organization/update-member-role";
import { ConfirmationDialog } from "@/app/(org)/dashboard/_components/ConfirmationDialog";
import { useDashboardContext } from "@/app/(org)/dashboard/Contexts";
import {
	type AssignableOrganizationRole,
	canChangeOrganizationMemberRole,
	canManageOrganizationMembers,
	canManageOrganizationProSeats,
	canRemoveOrganizationMember,
	getEffectiveOrganizationRole,
	normalizeAssignableOrganizationRole,
	organizationRoleLabel,
} from "@/lib/permissions/roles";
import { calculateSeats } from "@/utils/organization";

interface MembersCardProps {
	setIsInviteDialogOpen: (isOpen: boolean) => void;
}

export const MembersCard = ({ setIsInviteDialogOpen }: MembersCardProps) => {
	const router = useRouter();
	const { activeOrganization, user } = useDashboardContext();
	const { proSeatsRemaining } = calculateSeats({
		...(activeOrganization || {}),
		ownerId: activeOrganization?.organization.ownerId,
		ownerIsPro: Boolean(activeOrganization?.ownerIsPro),
	});
	const currentMember = activeOrganization?.members.find(
		(member) => member.userId === user.id,
	);
	const currentRole = getEffectiveOrganizationRole({
		userId: user.id,
		ownerId: activeOrganization?.organization.ownerId,
		memberRole: currentMember?.role,
	});
	const pendingInviteEmails = new Set(
		activeOrganization?.invites?.map((invite) =>
			invite.invitedEmail.toLowerCase(),
		) ?? [],
	);
	const memberEmails = new Set(
		activeOrganization?.members?.map((member) =>
			member.user.email.toLowerCase(),
		) ?? [],
	);
	const canManageMembers = canManageOrganizationMembers(currentRole);
	const canManageProSeats = canManageOrganizationProSeats(currentRole);

	const [confirmOpen, setConfirmOpen] = useState(false);
	const [pendingMember, setPendingMember] = useState<{
		id: string;
		name: string;
		email: string;
	} | null>(null);
	const [deletingInviteId, setDeletingInviteId] = useState<string | null>(null);
	const roleOptions = [
		{ value: "admin", label: "管理员" },
		{ value: "member", label: "成员" },
	];
	const showMemberManagerToast = () => {
		toast.error("只有管理员和所有者可以管理组织成员");
	};

	const deleteInviteMutation = useMutation({
		mutationFn: (inviteId: string) => {
			if (!activeOrganization?.organization.id) {
				throw new Error("未找到组织");
			}
			setDeletingInviteId(inviteId);
			return removeOrganizationInvite(
				inviteId,
				activeOrganization.organization.id,
			);
		},
		onSuccess: () => {
			toast.success("邀请已删除");
			setDeletingInviteId(null);
			router.refresh();
		},
		onError: () => {
			toast.error("删除邀请时发生错误");
			setDeletingInviteId(null);
		},
	});

	const removeMemberMutation = useMutation({
		mutationFn: (memberId: string) => {
			if (!activeOrganization?.organization.id) {
				throw new Error("未找到组织");
			}
			return removeOrganizationMember(
				memberId,
				activeOrganization.organization.id,
			);
		},
		onSuccess: () => {
			toast.success("成员已移除");
			setConfirmOpen(false);
			setPendingMember(null);
			router.refresh();
		},
		onError: (error) => {
			toast.error(
				error instanceof Error ? error.message : "移除成员时发生错误",
			);
		},
	});

	const updateRoleMutation = useMutation({
		mutationFn: ({
			memberId,
			role,
		}: {
			memberId: string;
			role: AssignableOrganizationRole;
		}) => {
			if (!activeOrganization?.organization.id) {
				throw new Error("未找到组织");
			}
			return updateOrganizationMemberRole(
				memberId,
				activeOrganization.organization.id,
				role,
			);
		},
		onSuccess: () => {
			toast.success("角色已更新");
			router.refresh();
		},
		onError: (error) => {
			toast.error(error instanceof Error ? error.message : "更新角色失败");
		},
	});

	const toggleProSeatMutation = useMutation({
		mutationFn: ({
			memberId,
			enable,
		}: {
			memberId: string;
			enable: boolean;
		}) => {
			if (!activeOrganization?.organization.id) {
				throw new Error("未找到组织");
			}
			return toggleProSeat(
				memberId,
				activeOrganization.organization.id,
				enable,
			);
		},
		onSuccess: (_data, { enable }) => {
			toast.success(enable ? "已分配 Pro 席位" : "已移除 Pro 席位");
			router.refresh();
		},
		onError: (error) => {
			toast.error(error instanceof Error ? error.message : "更新 Pro 席位失败");
		},
	});

	const handleRemoveMember = (member: {
		id: string;
		user: { name: string; email: string };
	}) => {
		setPendingMember({
			id: member.id,
			name: member.user.name,
			email: member.user.email,
		});
		setConfirmOpen(true);
	};

	const isMemberOwner = (id: string) => {
		return id === activeOrganization?.organization.ownerId;
	};

	return (
		<>
			<ConfirmationDialog
				open={confirmOpen}
				icon={<FontAwesomeIcon icon={faUser} />}
				title="移除成员"
				description={
					pendingMember
						? `确定要从组织中移除 ${pendingMember.name} 吗？此操作无法撤销。`
						: ""
				}
				confirmLabel={removeMemberMutation.isPending ? "正在移除…" : "移除"}
				cancelLabel="取消"
				loading={removeMemberMutation.isPending}
				onConfirm={() => {
					if (pendingMember) {
						removeMemberMutation.mutate(pendingMember.id);
					}
				}}
				onCancel={() => {
					setConfirmOpen(false);
					setPendingMember(null);
				}}
			/>
			<Card>
				<div className="flex flex-wrap gap-6 justify-between items-center w-full">
					<CardHeader>
						<CardTitle>成员</CardTitle>
						<CardDescription>管理组织成员。</CardDescription>
					</CardHeader>
					<Button
						type="button"
						size="sm"
						variant="dark"
						className="px-6 min-w-auto"
						onClick={() => {
							if (!canManageMembers) {
								showMemberManagerToast();
								return;
							}
							setIsInviteDialogOpen(true);
						}}
						disabled={!canManageMembers}
					>
						+ 邀请用户
					</Button>
				</div>
				<Table className="mt-5">
					<TableHeader>
						<TableRow>
							<TableHead>成员</TableHead>
							<TableHead>邮箱</TableHead>
							<TableHead>角色</TableHead>
							{buildEnv.NEXT_PUBLIC_IS_CAP && <TableHead>Pro</TableHead>}
							<TableHead>加入时间</TableHead>
							<TableHead>状态</TableHead>
							<TableHead>操作</TableHead>
						</TableRow>
					</TableHeader>
					<TableBody>
						{activeOrganization?.members?.map((member) => {
							const memberIsOwner = isMemberOwner(member.user.id);
							const memberRole = getEffectiveOrganizationRole({
								userId: member.user.id,
								ownerId: activeOrganization.organization.ownerId,
								memberRole: member.role,
							});
							const assignableRole =
								normalizeAssignableOrganizationRole(memberRole);
							const canUpdateRole = canChangeOrganizationMemberRole({
								actorRole: currentRole,
								actorUserId: user.id,
								targetUserId: member.user.id,
								ownerId: activeOrganization.organization.ownerId,
								targetRole: memberRole,
								nextRole: assignableRole,
							});
							const canRemoveMember = canRemoveOrganizationMember({
								actorRole: currentRole,
								actorUserId: user.id,
								targetUserId: member.user.id,
								ownerId: activeOrganization.organization.ownerId,
								targetRole: memberRole,
							});
							const roleUpdating =
								updateRoleMutation.isPending &&
								updateRoleMutation.variables?.memberId === member.id;
							return (
								<TableRow key={member.id}>
									<TableCell>{member.user.name}</TableCell>
									<TableCell>{member.user.email}</TableCell>
									<TableCell>
										{memberIsOwner || memberRole === "owner" ? (
											"所有者"
										) : (
											<Select
												value={assignableRole ?? "member"}
												placeholder="角色"
												options={roleOptions}
												size="sm"
												variant="gray"
												onValueChange={(value) => {
													const nextRole =
														normalizeAssignableOrganizationRole(value);
													if (!nextRole) return;
													updateRoleMutation.mutate({
														memberId: member.id,
														role: nextRole,
													});
												}}
												disabled={!canUpdateRole || roleUpdating}
											/>
										)}
									</TableCell>
									{buildEnv.NEXT_PUBLIC_IS_CAP && (
										<TableCell>
											{memberIsOwner ? (
												<span className="text-xs text-gray-10">-</span>
											) : (
												<Switch
													checked={member.hasProSeat}
													onCheckedChange={(checked) =>
														toggleProSeatMutation.mutate({
															memberId: member.id,
															enable: checked,
														})
													}
													disabled={
														!canManageProSeats ||
														(toggleProSeatMutation.isPending &&
															toggleProSeatMutation.variables?.memberId ===
																member.id) ||
														(!member.hasProSeat && proSeatsRemaining <= 0)
													}
												/>
											)}
										</TableCell>
									)}
									<TableCell>
										{format(member.createdAt, "yyyy年M月d日", {
											locale: zhCN,
										})}
									</TableCell>
									<TableCell>
										{pendingInviteEmails.has(member.user.email.toLowerCase())
											? "待处理"
											: "有效"}
									</TableCell>
									<TableCell>
										{!memberIsOwner ? (
											<Button
												type="button"
												size="xs"
												variant="destructive"
												className="min-w-[unset] h-[28px]"
												onClick={() => {
													if (canRemoveMember) {
														handleRemoveMember({
															id: member.id,
															user: {
																name: member.user.name ?? "（无姓名）",
																email: member.user.email ?? "（无邮箱）",
															},
														});
													} else {
														showMemberManagerToast();
													}
												}}
												disabled={!canRemoveMember}
											>
												移除
											</Button>
										) : (
											"-"
										)}
									</TableCell>
								</TableRow>
							);
						})}
						{activeOrganization?.invites
							?.filter(
								(invite) =>
									!memberEmails.has(invite.invitedEmail.toLowerCase()),
							)
							.map((invite) => (
								<TableRow key={invite.id}>
									<TableCell className="text-gray-10">待处理</TableCell>
									<TableCell>{invite.invitedEmail}</TableCell>
									<TableCell>
										{organizationRoleLabel(
											normalizeAssignableOrganizationRole(invite.role) ??
												"member",
										)}
									</TableCell>
									{buildEnv.NEXT_PUBLIC_IS_CAP && <TableCell>-</TableCell>}
									<TableCell>-</TableCell>
									<TableCell>已邀请</TableCell>
									<TableCell>
										<Button
											type="button"
											size="xs"
											variant="destructive"
											onClick={() => {
												if (canManageMembers) {
													deleteInviteMutation.mutate(invite.id);
												} else {
													showMemberManagerToast();
												}
											}}
											disabled={
												!canManageMembers || deletingInviteId === invite.id
											}
										>
											{deletingInviteId === invite.id
												? "正在删除…"
												: "删除邀请"}
										</Button>
									</TableCell>
								</TableRow>
							))}
					</TableBody>
				</Table>
			</Card>
		</>
	);
};
