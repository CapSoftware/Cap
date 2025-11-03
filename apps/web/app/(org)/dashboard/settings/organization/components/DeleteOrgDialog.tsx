import {
	Button,
	Dialog,
	DialogContent,
	DialogFooter,
	DialogHeader,
	DialogTitle,
	Input,
} from "@cap/ui";
import type { Organisation } from "@cap/web-domain";
import { faTrashCan } from "@fortawesome/free-solid-svg-icons";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
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
	const { activeOrganization, organizationData, user } = useDashboardContext();
	const [organizationName, setOrganizationName] = useState("");
	const rpc = useRpcClient();
	const router = useRouter();
	const deleteOrg = useEffectMutation({
		mutationFn: Effect.fn(function* () {
			yield* rpc.OrganisationDelete({
				id: activeOrganization?.organization.id as Organisation.OrganisationId,
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
						id={useId()}
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
						onClick={() => deleteOrg.mutate()}
						spinner={deleteOrg.isPending}
						disabled={
							organizationData?.length === 1 ||
							organizationName !== activeOrganization?.organization.name ||
							deleteOrg.isPending
						}
					>
						{deleteOrg.isPending ? "Deleting..." : "Delete"}
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
};

export default DeleteOrgDialog;
