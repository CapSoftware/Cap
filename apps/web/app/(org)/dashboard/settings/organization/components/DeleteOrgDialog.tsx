import { faTrashCan } from "@fortawesome/free-solid-svg-icons";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import {
	Button,
	Dialog,
	DialogContent,
	DialogFooter,
	DialogHeader,
	DialogTitle,
	Input,
} from "@inflight/ui";
import { Effect } from "effect";
import { useRouter } from "next/navigation";
import { startTransition, useId, useState } from "react";
import { toast } from "sonner";
import { useEffectMutation, useRpcClient } from "@/lib/EffectRuntime";
import { useDashboardContext } from "../../../Contexts";

interface DeleteOrgDialogProps {
	open: boolean;
	onOpenChange: (open: boolean) => void;
}

const DeleteOrgDialog = ({ open, onOpenChange }: DeleteOrgDialogProps) => {
	const { activeOrganization, organizationData } = useDashboardContext();
	const [organizationName, setOrganizationName] = useState("");
	const rpc = useRpcClient();
	const inputId = useId();
	const router = useRouter();
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
			startTransition(() => {
				router.push("/dashboard/caps");
				router.refresh();
			});
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
					description="Removing your organization will delete all associated data, including videos, and cannot be undone."
				>
					<DialogTitle>Delete Organization</DialogTitle>
				</DialogHeader>
				<div className="p-5">
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
							organizationData?.length === 1 ||
							organizationName !== activeOrganization?.organization.name ||
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
