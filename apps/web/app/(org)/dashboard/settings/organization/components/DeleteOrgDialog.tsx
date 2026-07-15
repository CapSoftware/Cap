import {
	Button,
	Dialog,
	DialogContent,
	DialogFooter,
	DialogHeader,
	DialogTitle,
	Input,
} from "@cap/ui";
import { faTrashCan } from "@fortawesome/free-solid-svg-icons";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { Effect } from "effect";
import { signOut } from "next-auth/react";
import { useId, useState } from "react";
import { toast } from "sonner";
import { useEffectMutation, useRpcClient } from "@/lib/EffectRuntime";
import { useDashboardContext } from "../../../Contexts";

interface DeleteOrgDialogProps {
	open: boolean;
	onOpenChange: (open: boolean) => void;
}

const DeleteOrgDialog = ({ open, onOpenChange }: DeleteOrgDialogProps) => {
	const { activeOrganization } = useDashboardContext();
	const [organizationName, setOrganizationName] = useState("");
	const rpc = useRpcClient();
	const inputId = useId();
	const organizationNameToConfirm = activeOrganization?.organization.name ?? "";
	const softDeleteOrg = useEffectMutation({
		mutationFn: Effect.fn(function* () {
			if (!activeOrganization) return;
			yield* rpc.OrganisationSoftDelete({
				id: activeOrganization.organization.id,
			});
		}),
		onSuccess: () => {
			toast.success("组织已删除");
			onOpenChange(false);
			void signOut({ callbackUrl: "/" });
		},
		onError: (error) => {
			console.error(error);
			toast.error("删除组织失败");
		},
	});

	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent>
				<DialogHeader
					icon={<FontAwesomeIcon className="size-3.5" icon={faTrashCan} />}
					description="移除组织会删除其成员关系、邀请、空间、共享视频、分析数据和由 Cap 托管的媒体。自定义存储中的文件不会被删除。"
				>
					<DialogTitle>删除组织</DialogTitle>
				</DialogHeader>
				<div className="p-5 space-y-3">
					<div className="text-sm text-gray-11">
						请输入{" "}
						<span className="font-medium text-gray-12">
							{organizationNameToConfirm}
						</span>{" "}
						以确认。
					</div>
					<Input
						id={inputId}
						value={organizationName}
						onChange={(e) => setOrganizationName(e.target.value)}
						placeholder="组织名称"
					/>
				</div>
				<DialogFooter>
					<Button size="sm" variant="gray" onClick={() => onOpenChange(false)}>
						取消
					</Button>
					<Button
						size="sm"
						variant="destructive"
						onClick={() => softDeleteOrg.mutate()}
						spinner={softDeleteOrg.isPending}
						disabled={
							organizationName.trim() !== organizationNameToConfirm ||
							softDeleteOrg.isPending
						}
					>
						{softDeleteOrg.isPending ? "正在删除…" : "删除"}
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
};

export default DeleteOrgDialog;
