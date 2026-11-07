"use client";

import { buildEnv } from "@cap/env";
import {
	Button,
	Card,
	CardDescription,
	CardHeader,
	CardTitle,
	Input,
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
import clsx from "clsx";
import { format } from "date-fns";
import { ArrowDown, ArrowUp, ArrowUpDown, Search } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { toast } from "sonner";
import { removeOrganizationInvite } from "@/actions/organization/remove-invite";
import { removeOrganizationMember } from "@/actions/organization/remove-member";
import { toggleProSeat } from "@/actions/organization/toggle-pro-seat";
import { updateOrganizationMemberRole } from "@/actions/organization/update-member-role";
import { ConfirmationDialog } from "@/app/(org)/dashboard/_components/ConfirmationDialog";
import { useDashboardContext } from "@/app/(org)/dashboard/Contexts";
import type { Organization } from "@/app/(org)/dashboard/dashboard-data";
import {
	filterAndSortMembersTableRows,
	type MembersTableRow,
	type MembersTableSort,
	type MembersTableSortKey,
	type MembersTableStatus,
	nextMembersTableSort,
} from "@/lib/organization-members-table";
import {
	type AssignableOrganizationRole,
	canChangeOrganizationMemberRole,
	canManageOrganizationMembers,
	canManageOrganizationProSeats,
	canRemoveOrganizationMember,
	getEffectiveOrganizationRole,
	normalizeAssignableOrganizationRole,
	type OrganizationRole,
	organizationRoleLabel,
} from "@/lib/permissions/roles";
import { calculateSeats } from "@/utils/organization";

interface MembersCardProps {
	setIsInviteDialogOpen: (isOpen: boolean) => void;
}

type Row = MembersTableRow &
	(
		| { kind: "member"; member: Organization["members"][number] }
		| { kind: "invite"; invite: Organization["invites"][number] }
	);

const roleFilterOptions = [
	{ value: "all", label: "All roles" },
	{ value: "owner", label: "Owner" },
	{ value: "admin", label: "Admin" },
	{ value: "member", label: "Member" },
];

const statusFilterOptions = [
	{ value: "all", label: "All statuses" },
	{ value: "active", label: "Active" },
	{ value: "pending", label: "Pending" },
	{ value: "invited", label: "Invited" },
];

const statusLabels: Record<MembersTableStatus, string> = {
	active: "Active",
	pending: "Pending",
	invited: "Invited",
};

const isRoleFilter = (value: string): value is OrganizationRole | "all" =>
	roleFilterOptions.some((option) => option.value === value);

const isStatusFilter = (value: string): value is MembersTableStatus | "all" =>
	statusFilterOptions.some((option) => option.value === value);

const SortableHead = ({
	label,
	sortKey,
	sort,
	onSort,
}: {
	label: string;
	sortKey: MembersTableSortKey;
	sort: MembersTableSort | null;
	onSort: (key: MembersTableSortKey) => void;
}) => {
	const direction = sort?.key === sortKey ? sort.direction : null;
	const Icon =
		direction === "asc"
			? ArrowUp
			: direction === "desc"
				? ArrowDown
				: ArrowUpDown;
	return (
		<TableHead
			aria-sort={
				direction === "asc"
					? "ascending"
					: direction === "desc"
						? "descending"
						: "none"
			}
		>
			<button
				type="button"
				onClick={() => onSort(sortKey)}
				className="inline-flex gap-1 items-center font-medium rounded-sm hover:text-gray-11 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-gray-12"
			>
				{label}
				<Icon
					aria-hidden="true"
					className={clsx(
						"size-3.5",
						direction ? "text-gray-12" : "text-gray-9",
					)}
				/>
			</button>
		</TableHead>
	);
};

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

	const [search, setSearch] = useState("");
	const [roleFilter, setRoleFilter] = useState<OrganizationRole | "all">("all");
	const [statusFilter, setStatusFilter] = useState<MembersTableStatus | "all">(
		"all",
	);
	const [sort, setSort] = useState<MembersTableSort | null>(null);

	const allRows: Row[] = [
		...(activeOrganization?.members ?? []).map(
			(member): Row => ({
				kind: "member",
				member,
				name: member.user.name,
				email: member.user.email,
				role:
					getEffectiveOrganizationRole({
						userId: member.user.id,
						ownerId: activeOrganization?.organization.ownerId,
						memberRole: member.role,
					}) ?? "member",
				status: pendingInviteEmails.has(member.user.email.toLowerCase())
					? "pending"
					: "active",
				joinedAt: member.createdAt,
			}),
		),
		...(activeOrganization?.invites ?? [])
			.filter((invite) => !memberEmails.has(invite.invitedEmail.toLowerCase()))
			.map(
				(invite): Row => ({
					kind: "invite",
					invite,
					name: null,
					email: invite.invitedEmail,
					role: normalizeAssignableOrganizationRole(invite.role) ?? "member",
					status: "invited",
					joinedAt: null,
				}),
			),
	];
	const visibleRows = filterAndSortMembersTableRows(allRows, {
		search,
		role: roleFilter,
		status: statusFilter,
		sort,
	});
	const hasActiveFilters =
		search.trim() !== "" || roleFilter !== "all" || statusFilter !== "all";
	const handleSort = (key: MembersTableSortKey) =>
		setSort((current) => nextMembersTableSort(current, key));
	const columnCount = buildEnv.NEXT_PUBLIC_IS_CAP ? 7 : 6;

	const [confirmOpen, setConfirmOpen] = useState(false);
	const [pendingMember, setPendingMember] = useState<{
		id: string;
		name: string;
		email: string;
	} | null>(null);
	const [deletingInviteId, setDeletingInviteId] = useState<string | null>(null);
	const roleOptions = [
		{ value: "admin", label: "Admin" },
		{ value: "member", label: "Member" },
	];
	const showMemberManagerToast = () => {
		toast.error("Only admins and owners can manage organization members");
	};

	const deleteInviteMutation = useMutation({
		mutationFn: (inviteId: string) => {
			if (!activeOrganization?.organization.id) {
				throw new Error("Organization not found");
			}
			setDeletingInviteId(inviteId);
			return removeOrganizationInvite(
				inviteId,
				activeOrganization.organization.id,
			);
		},
		onSuccess: () => {
			toast.success("Invite deleted successfully");
			setDeletingInviteId(null);
			router.refresh();
		},
		onError: () => {
			toast.error("An error occurred while deleting invite");
			setDeletingInviteId(null);
		},
	});

	const removeMemberMutation = useMutation({
		mutationFn: (memberId: string) => {
			if (!activeOrganization?.organization.id) {
				throw new Error("Organization not found");
			}
			return removeOrganizationMember(
				memberId,
				activeOrganization.organization.id,
			);
		},
		onSuccess: () => {
			toast.success("Member removed successfully");
			setConfirmOpen(false);
			setPendingMember(null);
			router.refresh();
		},
		onError: (error) => {
			toast.error(
				error instanceof Error
					? error.message
					: "An error occurred while removing member",
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
				throw new Error("Organization not found");
			}
			return updateOrganizationMemberRole(
				memberId,
				activeOrganization.organization.id,
				role,
			);
		},
		onSuccess: () => {
			toast.success("Role updated");
			router.refresh();
		},
		onError: (error) => {
			toast.error(
				error instanceof Error ? error.message : "Failed to update role",
			);
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
				throw new Error("Organization not found");
			}
			return toggleProSeat(
				memberId,
				activeOrganization.organization.id,
				enable,
			);
		},
		onSuccess: (_data, { enable }) => {
			toast.success(enable ? "Pro seat assigned" : "Pro seat removed");
			router.refresh();
		},
		onError: (error) => {
			toast.error(
				error instanceof Error ? error.message : "Failed to update Pro seat",
			);
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
				title="Remove member"
				description={
					pendingMember
						? `Are you sure you want to remove ${pendingMember.name} from your organization? This action cannot be undone.`
						: ""
				}
				confirmLabel={removeMemberMutation.isPending ? "Removing..." : "Remove"}
				cancelLabel="Cancel"
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
						<CardTitle>Members</CardTitle>
						<CardDescription>Manage your organization members.</CardDescription>
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
						+ Invite users
					</Button>
				</div>
				<div className="flex flex-wrap gap-3 items-center mt-5">
					<div className="relative flex-1 min-w-[220px]">
						<Search
							aria-hidden="true"
							className="absolute left-3 top-1/2 z-10 size-4 -translate-y-1/2 text-gray-9"
						/>
						<Input
							type="search"
							value={search}
							onChange={(event) => setSearch(event.target.value)}
							placeholder="Search by name or email"
							aria-label="Search members"
							className="pl-9"
						/>
					</div>
					<Select
						value={roleFilter}
						options={roleFilterOptions}
						placeholder="Role"
						variant="light"
						className="sm:w-40"
						onValueChange={(value) => {
							if (isRoleFilter(value)) setRoleFilter(value);
						}}
					/>
					<Select
						value={statusFilter}
						options={statusFilterOptions}
						placeholder="Status"
						variant="light"
						className="sm:w-40"
						onValueChange={(value) => {
							if (isStatusFilter(value)) setStatusFilter(value);
						}}
					/>
				</div>
				{hasActiveFilters && (
					<p className="mt-3 text-xs text-gray-10" aria-live="polite">
						Showing {visibleRows.length} of {allRows.length}
					</p>
				)}
				<Table className="mt-3">
					<TableHeader>
						<TableRow>
							<SortableHead
								label="Member"
								sortKey="name"
								sort={sort}
								onSort={handleSort}
							/>
							<SortableHead
								label="Email"
								sortKey="email"
								sort={sort}
								onSort={handleSort}
							/>
							<SortableHead
								label="Role"
								sortKey="role"
								sort={sort}
								onSort={handleSort}
							/>
							{buildEnv.NEXT_PUBLIC_IS_CAP && <TableHead>Pro</TableHead>}
							<SortableHead
								label="Joined"
								sortKey="joined"
								sort={sort}
								onSort={handleSort}
							/>
							<TableHead>Status</TableHead>
							<TableHead>Actions</TableHead>
						</TableRow>
					</TableHeader>
					<TableBody>
						{visibleRows.length === 0 && (
							<TableRow>
								<TableCell
									colSpan={columnCount}
									className="py-8 text-center text-gray-10"
								>
									No members match your search or filters.
								</TableCell>
							</TableRow>
						)}
						{visibleRows.map((row) => {
							if (row.kind === "invite") {
								const { invite } = row;
								return (
									<TableRow key={invite.id}>
										<TableCell className="text-gray-10">Pending</TableCell>
										<TableCell>{invite.invitedEmail}</TableCell>
										<TableCell>{organizationRoleLabel(row.role)}</TableCell>
										{buildEnv.NEXT_PUBLIC_IS_CAP && <TableCell>-</TableCell>}
										<TableCell>-</TableCell>
										<TableCell>{statusLabels[row.status]}</TableCell>
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
													? "Deleting..."
													: "Delete Invite"}
											</Button>
										</TableCell>
									</TableRow>
								);
							}
							const { member } = row;
							const ownerId = activeOrganization?.organization.ownerId;
							const memberIsOwner = isMemberOwner(member.user.id);
							const memberRole = getEffectiveOrganizationRole({
								userId: member.user.id,
								ownerId,
								memberRole: member.role,
							});
							const assignableRole =
								normalizeAssignableOrganizationRole(memberRole);
							const canUpdateRole = canChangeOrganizationMemberRole({
								actorRole: currentRole,
								actorUserId: user.id,
								targetUserId: member.user.id,
								ownerId,
								targetRole: memberRole,
								nextRole: assignableRole,
							});
							const canRemoveMember = canRemoveOrganizationMember({
								actorRole: currentRole,
								actorUserId: user.id,
								targetUserId: member.user.id,
								ownerId,
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
											"Owner"
										) : (
											<Select
												value={assignableRole ?? "member"}
												placeholder="Role"
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
												<span className="text-xs text-gray-10">
													{activeOrganization?.ownerIsPro ? "Included" : "Free"}
												</span>
											) : (
												<div className="flex items-center gap-2">
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
													{member.hasProSeat &&
														!activeOrganization?.hasActiveProSeatProvider && (
															<span className="text-xs text-amber-600">
																Inactive
															</span>
														)}
												</div>
											)}
										</TableCell>
									)}
									<TableCell>
										{format(member.createdAt, "MMM d, yyyy")}
									</TableCell>
									<TableCell>{statusLabels[row.status]}</TableCell>
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
																name: member.user.name ?? "(No Name)",
																email: member.user.email ?? "(No Email)",
															},
														});
													} else {
														showMemberManagerToast();
													}
												}}
												disabled={!canRemoveMember}
											>
												Remove
											</Button>
										) : (
											"-"
										)}
									</TableCell>
								</TableRow>
							);
						})}
					</TableBody>
				</Table>
			</Card>
		</>
	);
};
