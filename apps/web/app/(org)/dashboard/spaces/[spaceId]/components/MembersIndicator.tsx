"use client";

import {
	Button,
	Dialog,
	DialogContent,
	DialogFooter,
	DialogHeader,
	DialogTitle,
	DialogTrigger,
	Form,
	FormControl,
	FormField,
	Select,
} from "@cap/ui";
import { type Space, User } from "@cap/web-domain";
import { faPlus, faUserGroup } from "@fortawesome/free-solid-svg-icons";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { zodResolver } from "@hookform/resolvers/zod";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { useForm } from "react-hook-form";
import { toast } from "sonner";
import * as z from "zod";
import { SignedImageUrl } from "@/components/SignedImageUrl";
import {
	normalizeSpaceRole,
	type SpaceRole,
	spaceRoleLabel,
} from "@/lib/permissions/roles";
import { useDashboardContext } from "../../../Contexts";
import { setSpaceMembers } from "../actions";
import type { SpaceMemberData } from "../page";
import { MemberSelect } from "./MemberSelect";

type MembersIndicatorProps = {
	memberCount: number;
	members: SpaceMemberData[];
	organizationMembers: SpaceMemberData[];
	spaceId: Space.SpaceIdOrOrganisationId;
	canManageMembers: boolean;
	onAddVideos?: () => void;
};

export const MembersIndicator = ({
	memberCount,
	members,
	organizationMembers,
	spaceId,
	canManageMembers,
	onAddVideos,
}: MembersIndicatorProps) => {
	const { user } = useDashboardContext();
	const router = useRouter();
	const [open, setOpen] = useState(false);
	const [isLoading, setIsLoading] = useState(false);
	const [memberRoles, setMemberRoles] = useState<Record<string, SpaceRole>>({});
	const roleOptions = [
		{ value: "member", label: "Member" },
		{ value: "admin", label: "Admin" },
	];

	const formSchema = z.object({
		members: z.array(z.string()).optional(),
	});

	const form = useForm<z.infer<typeof formSchema>>({
		resolver: zodResolver(formSchema),
		defaultValues: {
			members: members.map((m) => m.userId),
		},
	});

	useEffect(() => {
		setMemberRoles(
			Object.fromEntries(
				members.map((member) => [
					member.userId,
					normalizeSpaceRole(member.role) ?? "member",
				]),
			),
		);
		form.reset({
			members: members.map((member) => member.userId),
		});
	}, [members, form]);

	const handleSaveMembers = async (selectedUserIds: User.UserId[]) => {
		if (!canManageMembers) return;

		const currentIds = members.map((m) => m.userId).sort();
		const selectedIds = (selectedUserIds ?? []).slice().sort();
		const noChange =
			currentIds.length === selectedIds.length &&
			currentIds.every((id, i) => id === selectedIds[i]) &&
			currentIds.every(
				(id) =>
					(normalizeSpaceRole(members.find((m) => m.userId === id)?.role) ??
						"member") === (memberRoles[id] ?? "member"),
			);

		if (noChange) {
			toast.info("No changes were applied");
			return;
		}

		setIsLoading(true);
		try {
			await setSpaceMembers({
				spaceId,
				userIds: selectedUserIds ?? [],
				members: (selectedUserIds ?? []).map((userId) => ({
					userId,
					role: memberRoles[userId] ?? "member",
				})),
				role: "member",
			});
			toast.success("Members updated!");
			router.refresh();
		} catch (error) {
			console.error("Failed to update members:", error);
			toast.error("Failed to update members");
		} finally {
			setIsLoading(false);
			setOpen(false);
		}
	};

	const OrgMembers = useCallback(
		(field: { value?: string[] }) => {
			return organizationMembers
				.filter((m) => (field.value ?? []).includes(m.userId))
				.map((m) => ({
					value: m.userId,
					label: m.name || m.email,
					image: m.image || undefined,
				}));
		},
		[organizationMembers],
	);

	return (
		<div className="flex gap-3 items-center">
			<Dialog open={open} onOpenChange={setOpen}>
				<DialogTrigger asChild>
					<Button variant="gray" size="sm" className="z-10">
						<FontAwesomeIcon className="mr-1 size-4" icon={faUserGroup} />
						{memberCount} members
					</Button>
				</DialogTrigger>
				<DialogContent className="p-0 w-full max-w-md rounded-xl border bg-gray-2 border-gray-4">
					<DialogHeader
						icon={<FontAwesomeIcon icon={faUserGroup} />}
						description={
							canManageMembers
								? "View and manage members of this space"
								: "View members of this space"
						}
					>
						<DialogTitle className="text-lg text-gray-12">
							Space Members: {memberCount}
						</DialogTitle>
					</DialogHeader>

					<div className="p-5">
						<div className="flex flex-col">
							{canManageMembers ? (
								<Form {...form}>
									<div className="space-y-2 max-h-[320px] overflow-y-auto">
										<FormField
											control={form.control}
											name="members"
											render={({ field }) => {
												const selectedMembers = OrgMembers(field);
												return (
													<FormControl>
														<div className="space-y-3">
															<MemberSelect
																placeholder="Add member..."
																disabled={false}
																canManageMembers={true}
																showEmptyIfNoMembers={false}
																selected={selectedMembers}
																onSelect={(selected) => {
																	const selectedIds = selected.map(
																		(opt) => opt.value,
																	);
																	field.onChange(selectedIds);
																	setMemberRoles((prev) => {
																		const next: Record<string, SpaceRole> = {};
																		for (const userId of selectedIds) {
																			next[userId] = prev[userId] ?? "member";
																		}
																		return next;
																	});
																}}
															/>
															{selectedMembers.length > 0 && (
																<div className="space-y-2">
																	{selectedMembers.map((member) => (
																		<div
																			key={member.value}
																			className="flex items-center justify-between gap-3 rounded-lg border border-gray-4 bg-gray-3 p-2"
																		>
																			<div className="flex min-w-0 items-center gap-2">
																				<SignedImageUrl
																					name={member.label}
																					image={member.image}
																					className="size-7"
																					letterClass="text-xs"
																				/>
																				<span className="truncate text-sm text-gray-12">
																					{member.label}
																				</span>
																			</div>
																			<Select
																				value={
																					memberRoles[member.value] ?? "member"
																				}
																				placeholder="Role"
																				options={roleOptions}
																				size="sm"
																				variant="gray"
																				disabled={member.value === user.id}
																				onValueChange={(value) => {
																					setMemberRoles((prev) => ({
																						...prev,
																						[member.value]:
																							normalizeSpaceRole(value) ??
																							"member",
																					}));
																				}}
																			/>
																		</div>
																	))}
																</div>
															)}
														</div>
													</FormControl>
												);
											}}
										/>
									</div>
								</Form>
							) : (
								<div className="space-y-2 max-h-[320px] custom-scroll overflow-y-auto">
									{members.map((member) => (
										<div
											key={member.userId}
											className="flex gap-2 items-center p-3 rounded-lg border bg-gray-3 border-gray-4"
										>
											<SignedImageUrl
												name={member.name || member.email}
												image={member.image || undefined}
												className="size-8"
												letterClass="text-sm"
											/>
											<span className="text-sm text-gray-12">
												{member.name || member.email}
											</span>
											<span className="ml-auto rounded-full bg-gray-5 px-2 py-1 text-xs text-gray-11">
												{spaceRoleLabel(
													normalizeSpaceRole(member.role) ?? "member",
												)}
											</span>
										</div>
									))}
								</div>
							)}
						</div>
					</div>

					<DialogFooter>
						<Button variant="gray" size="sm" onClick={() => setOpen(false)}>
							Close
						</Button>
						{canManageMembers && (
							<Button
								onClick={() =>
									handleSaveMembers(
										form
											.getValues("members")
											?.map((v) => User.UserId.make(v)) ?? [],
									)
								}
								disabled={isLoading}
								spinner={isLoading}
								variant="dark"
								size="sm"
							>
								Save
							</Button>
						)}
					</DialogFooter>
				</DialogContent>
			</Dialog>

			{onAddVideos && (
				<Button variant="dark" size="sm" onClick={onAddVideos}>
					<FontAwesomeIcon className="size-3" icon={faPlus} />
					Add videos
				</Button>
			)}
		</div>
	);
};
