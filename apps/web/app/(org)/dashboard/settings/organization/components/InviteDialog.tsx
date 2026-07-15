"use client";

import {
	Button,
	Dialog,
	DialogContent,
	DialogFooter,
	DialogHeader,
	DialogTitle,
	Input,
	Select,
	Switch,
} from "@cap/ui";
import { faUserGroup } from "@fortawesome/free-solid-svg-icons";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { useMutation } from "@tanstack/react-query";
import { useRouter } from "next/navigation";
import { useEffect, useId, useState } from "react";
import { toast } from "sonner";
import { sendOrganizationInvites } from "@/actions/organization/send-invites";
import { useDashboardContext } from "../../../Contexts";

interface InviteDialogProps {
	isOpen: boolean;
	setIsOpen: (open: boolean) => void;
}

type InviteRole = "admin" | "member";
type InviteEmail = {
	email: string;
	role: InviteRole;
};

const roleOptions = [
	{ value: "member", label: "成员" },
	{ value: "admin", label: "管理员" },
];

export const InviteDialog = ({ isOpen, setIsOpen }: InviteDialogProps) => {
	const router = useRouter();
	const { activeOrganization } = useDashboardContext();
	const [inviteEmails, setInviteEmails] = useState<InviteEmail[]>([]);
	const [emailInput, setEmailInput] = useState("");
	const [sendEmailNotifications, setSendEmailNotifications] = useState(true);
	const emailInputId = useId();
	const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

	useEffect(() => {
		if (!isOpen) {
			setInviteEmails([]);
			setEmailInput("");
			setSendEmailNotifications(true);
		}
	}, [isOpen]);

	const buildInviteEmailsWithPendingInput = () => {
		const newEmails = emailInput
			.split(",")
			.map((email) => email.trim().toLowerCase())
			.filter((email) => email !== "");

		const invalidEmails = newEmails.filter((email) => !emailRegex.test(email));
		if (invalidEmails.length > 0) {
			toast.error(`邮箱地址无效：${invalidEmails.join(", ")}`);
			return null;
		}

		const validEmails = newEmails.filter((email) => emailRegex.test(email));
		const inviteMap = new Map(
			inviteEmails.map((invite) => [invite.email, invite]),
		);

		for (const email of validEmails) {
			if (!inviteMap.has(email)) {
				inviteMap.set(email, { email, role: "member" });
			}
		}

		return Array.from(inviteMap.values());
	};

	const handleAddEmails = () => {
		const nextInviteEmails = buildInviteEmailsWithPendingInput();
		if (!nextInviteEmails) return;

		setInviteEmails(nextInviteEmails);
		setEmailInput("");
	};

	const handleRemoveEmail = (email: string) => {
		setInviteEmails(inviteEmails.filter((invite) => invite.email !== email));
	};

	const handleUpdateEmailRole = (email: string, role: InviteRole) => {
		setInviteEmails(
			inviteEmails.map((invite) =>
				invite.email === email ? { ...invite, role } : invite,
			),
		);
	};

	const sendInvites = useMutation({
		mutationFn: async (emails: InviteEmail[]) => {
			if (!activeOrganization?.organization.id) {
				throw new Error("没有活动组织");
			}
			return await sendOrganizationInvites(
				emails,
				activeOrganization.organization.id,
				"member",
				{ sendEmailNotifications },
			);
		},
		onSuccess: (result) => {
			if (result.failedEmails.length > 0) {
				toast.warning(
					sendEmailNotifications
						? `邀请已发送，但以下地址投递失败：${result.failedEmails.join(", ")}`
						: `用户已添加，但以下用户配置失败：${result.failedEmails.join(", ")}`,
				);
			} else {
				toast.success(sendEmailNotifications ? "邀请已发送" : "用户已添加");
			}
			setIsOpen(false);
			router.refresh();
		},
		onError: (error) => {
			console.error("Error sending invites:", error);
			toast.error(
				error instanceof Error ? error.message : "发送邀请时发生错误",
			);
		},
	});

	const handleSendInvites = () => {
		const nextInviteEmails = buildInviteEmailsWithPendingInput();
		if (!nextInviteEmails || nextInviteEmails.length === 0) return;

		setInviteEmails(nextInviteEmails);
		setEmailInput("");
		sendInvites.mutate(nextInviteEmails);
	};

	const hasPendingEmailInput = emailInput.trim() !== "";

	return (
		<Dialog open={isOpen} onOpenChange={setIsOpen}>
			<DialogContent className="p-0 w-full max-w-md rounded-xl border bg-gray-2 border-gray-4">
				<DialogHeader
					icon={<FontAwesomeIcon icon={faUserGroup} className="size-3.5" />}
					description="邀请团队成员加入组织"
				>
					<DialogTitle>
						邀请加入{" "}
						<span className="font-medium text-gray-12">
							{activeOrganization?.organization.name}
						</span>
					</DialogTitle>
				</DialogHeader>
				<div className="p-5">
					<Input
						id={emailInputId}
						value={emailInput}
						onChange={(e) => setEmailInput(e.target.value)}
						placeholder="name@company.com"
						onBlur={(e) => {
							const relatedTarget = e.relatedTarget;
							if (
								relatedTarget instanceof HTMLElement &&
								relatedTarget.dataset.inviteSubmit === "true"
							) {
								return;
							}
							handleAddEmails();
						}}
						onKeyDown={(e) => {
							if (e.key === "Enter" || e.key === ",") {
								e.preventDefault();
								handleAddEmails();
							}
						}}
					/>
					<div className="flex overflow-y-auto flex-col gap-2.5 mt-4 max-h-60">
						{inviteEmails.map((invite) => (
							<div
								key={invite.email}
								className="flex gap-3 justify-between items-center p-3 rounded-xl border transition-colors duration-200 border-gray-4 hover:bg-gray-3"
							>
								<span className="min-w-0 text-sm truncate text-gray-12">
									{invite.email}
								</span>
								<Select
									value={invite.role}
									placeholder="角色"
									options={roleOptions}
									size="sm"
									variant="gray"
									onValueChange={(value) =>
										handleUpdateEmailRole(
											invite.email,
											value === "admin" ? "admin" : "member",
										)
									}
								/>
								<Button
									style={
										{
											"--gradient-border-radius": "8px",
										} as React.CSSProperties
									}
									type="button"
									variant="destructive"
									size="xs"
									onClick={() => handleRemoveEmail(invite.email)}
								>
									移除
								</Button>
							</div>
						))}
					</div>
					<div className="flex gap-3 justify-between items-center p-3 mt-4 rounded-lg border border-gray-4 bg-gray-1">
						<div>
							<p className="text-sm font-medium text-gray-12">发送邀请邮件</p>
							<p className="mt-1 text-xs text-gray-10">
								关闭后可直接添加用户而不发送邮件。
							</p>
						</div>
						<Switch
							checked={sendEmailNotifications}
							onCheckedChange={setSendEmailNotifications}
						/>
					</div>
				</div>
				<DialogFooter className="p-5 border-t border-gray-4">
					<Button
						type="button"
						size="sm"
						variant="gray"
						onClick={() => setIsOpen(false)}
					>
						取消
					</Button>
					<Button
						type="button"
						size="sm"
						variant="dark"
						spinner={sendInvites.isPending}
						disabled={
							sendInvites.isPending ||
							(inviteEmails.length === 0 && !hasPendingEmailInput)
						}
						data-invite-submit="true"
						onClick={handleSendInvites}
					>
						{sendEmailNotifications ? "发送邀请" : "添加用户"}
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
};
