"use client";

import { Button, Input } from "@cap/ui";
import { faEdit } from "@fortawesome/free-solid-svg-icons/faEdit";
import { faLayerGroup } from "@fortawesome/free-solid-svg-icons/faLayerGroup";
import { faPlus } from "@fortawesome/free-solid-svg-icons/faPlus";
import { faTrash } from "@fortawesome/free-solid-svg-icons/faTrash";
import { Search } from "lucide-react";
import { useParams, useRouter } from "next/navigation";
import { useRef, useState } from "react";
import { toast } from "sonner";
import { deleteSpace } from "@/actions/organization/delete-space";
import { getSpaceMemberIds } from "@/actions/organization/get-space-member-ids";
import { FontAwesomeIcon } from "@/components/FontAwesomeIcon";
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
	const { spacesData } = useDashboardContext();
	const [showSpaceDialog, setShowSpaceDialog] = useState(false);
	const [editSpace, setEditSpace] = useState<NewSpaceFormProps["space"]>(null);
	const [searchQuery, setSearchQuery] = useState("");
	// Edit loads the space's members before opening its form. Any newer
	// dialog action bumps this, so a slower lookup cannot take over a form
	// the user has opened since.
	const dialogRequest = useRef(0);

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
		dialogRequest.current += 1;
		setPendingDeleteSpace(space);
		setConfirmOpen(true);
	};

	const getRoleLabel = (role: Spaces["currentUserRole"]) => {
		const organizationRole = normalizeOrganizationRole(role);
		if (organizationRole) return organizationRoleLabel(organizationRole);
		const spaceRole = normalizeSpaceRole(role);
		return spaceRole ? spaceRoleLabel(spaceRole) : "Member";
	};

	const confirmRemoveSpace = async () => {
		if (!pendingDeleteSpace) return;
		setRemoving(true);
		try {
			const result = await deleteSpace(pendingDeleteSpace.id);
			if (result.success) {
				toast.success("Space deleted successfully");
				router.refresh();
				if (params.spaceId === pendingDeleteSpace.id) {
					router.push("/dashboard");
				}
			} else {
				toast.error(result.error || "Failed to delete space");
			}
		} catch (error) {
			console.error("Error deleting space:", error);
			toast.error("Failed to delete space");
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
					onClick={() => {
						dialogRequest.current += 1;
						setShowSpaceDialog(true);
					}}
					size="sm"
					variant="dark"
				>
					<FontAwesomeIcon className="size-3" icon={faPlus} />
					Create Space
				</Button>
				<div className="flex relative w-full max-w-md">
					<div className="flex absolute inset-y-0 left-3 items-center pointer-events-none">
						<Search className="size-4 text-gray-9" />
					</div>
					<Input
						type="text"
						placeholder="Search spaces..."
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
							<th className="px-6 py-3 font-medium">Name</th>
							<th className="px-6 py-3 font-medium">Members</th>
							<th className="px-6 py-3 font-medium">Videos</th>
							<th className="px-6 py-3 font-medium">Role</th>
							<th className="px-6 py-3 font-medium">Actions</th>
						</tr>
					</thead>
					<tbody>
						{!spacesData && (
							<tr>
								<td colSpan={5} className="px-6 py-6 text-center text-gray-8">
									Loading Spaces…
								</td>
							</tr>
						)}
						{spacesData && filteredSpaces && filteredSpaces.length === 0 && (
							<tr>
								<td colSpan={5} className="px-6 py-6 text-center text-gray-8">
									No spaces found.
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
										{space.memberCount} member
										{space.memberCount === 1 ? "" : "s"}
									</td>
									<td className="px-6 py-4 text-sm text-gray-12">
										{space.videoCount} video
										{space.videoCount === 1 ? "" : "s"}
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
													onClick={async (e) => {
														e.stopPropagation();
														const request = ++dialogRequest.current;
														// Saving replaces the space's members with this
														// list, so it must start from the real ones.
														const members = await getSpaceMemberIds(
															space.id,
														).catch(() => null);
														if (request !== dialogRequest.current) return;
														if (!members) {
															toast.error(
																"Could not load this space's members",
															);
															return;
														}
														setEditSpace({
															id: space.id,
															name: space.name,
															members,
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
				title="Delete space"
				description={
					pendingDeleteSpace
						? `Are you sure you want to delete the space "${pendingDeleteSpace?.name || "selected"}"? This action cannot be undone.`
						: "Are you sure you want to delete this space? This action cannot be undone."
				}
				confirmLabel={removing ? "Deleting..." : "Delete"}
				cancelLabel="Cancel"
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
