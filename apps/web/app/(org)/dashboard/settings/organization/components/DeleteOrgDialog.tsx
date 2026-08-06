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
			toast.success("Organization deleted successfully");
			onOpenChange(false);
			void signOut({ callbackUrl: "/" });
		},
		onError: (error) => {
			console.error(error);
			toast.error("Failed to delete organization");
		},
	});

	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent>
				<DialogHeader
					icon={<FontAwesomeIcon className="size-3.5" icon={faTrashCan} />}
					description="Removing your organization will delete its memberships, invites, spaces, shared videos, analytics, and Cap-hosted media. Custom storage files are not deleted."
				>
					<DialogTitle>Delete Organization</DialogTitle>
				</DialogHeader>
				<div className="p-5 space-y-3">
					<div className="text-sm text-gray-11">
						Type{" "}
						<span className="font-medium text-gray-12">
							{organizationNameToConfirm}
						</span>{" "}
						to confirm.
					</div>
					<Input
						id={inputId}
						value={organizationName}
						onChange={(e) => setOrganizationName(e.target.value)}
						placeholder="Organization name"
					/>
				</div>
				<DialogFooter>
					<Button size="sm" variant="gray" onClick={() => onOpenChange(false)}>
						Cancel
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
						{softDeleteOrg.isPending ? "Deleting..." : "Delete"}
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
};

export default DeleteOrgDialog;
