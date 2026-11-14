"use client";

import { Button } from "@cap/ui";
import type { Space } from "@cap/web-domain";
import { faLayerGroup } from "@fortawesome/free-solid-svg-icons/faLayerGroup";
import { faLock } from "@fortawesome/free-solid-svg-icons/faLock";
import { faPlus } from "@fortawesome/free-solid-svg-icons/faPlus";
import { faXmark } from "@fortawesome/free-solid-svg-icons/faXmark";
import clsx from "clsx";
import { AnimatePresence, motion } from "framer-motion";
import { ChevronDown, ChevronUp } from "lucide-react";
import Link from "next/link";
import { useParams, usePathname, useRouter } from "next/navigation";
import { useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { shareCap } from "@/actions/caps/share";
import { deleteSpace } from "@/actions/organization/delete-space";
import { FontAwesomeIcon } from "@/components/FontAwesomeIcon";
import { SignedImageUrl } from "@/components/SignedImageUrl";
import { Tooltip } from "@/components/Tooltip";
import {
	CAP_DRAG_TYPE,
	describeDraggedCaps,
	parseCapDrag,
} from "@/lib/move-items";
import { useDashboardContext } from "../../Contexts";
import type { Spaces } from "../../dashboard-data";
import { LayersIcon } from "../AnimatedIcons";
import type { LayersIconHandle } from "../AnimatedIcons/Layers";
import { ConfirmationDialog } from "../ConfirmationDialog";
import SpaceDialog from "./SpaceDialog";

const SPACE_DROP_CONCURRENCY = 4;

const SpacesList = ({ toggleMobileNav }: { toggleMobileNav?: () => void }) => {
	const { spacesData, sidebarCollapsed } = useDashboardContext();
	const [showSpaceDialog, setShowSpaceDialog] = useState(false);
	const [showAllSpaces, setShowAllSpaces] = useState(false);
	const [activeDropTarget, setActiveDropTarget] = useState<string | null>(null);
	const router = useRouter();
	const params = useParams();
	const pathname = usePathname();
	const layersIconRef = useRef<LayersIconHandle>(null);

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

	const { displayedSpaces, hasMoreSpaces, hiddenSpacesCount } = useMemo(() => {
		const spaces = spacesData ?? [];
		return {
			displayedSpaces: showAllSpaces ? spaces : spaces.slice(0, 3),
			hasMoreSpaces: spaces.length > 3,
			hiddenSpacesCount: Math.max(0, spaces.length - 3),
		};
	}, [spacesData, showAllSpaces]);

	if (!spacesData) return null;

	const handleDragOver = (e: React.DragEvent, spaceId: string) => {
		if (!e.dataTransfer.types.includes(CAP_DRAG_TYPE)) return;
		e.preventDefault();
		setActiveDropTarget(spaceId);
	};

	const handleDragLeave = () => {
		setActiveDropTarget(null);
	};

	const handleDrop = async (
		e: React.DragEvent,
		spaceId: Space.SpaceIdOrOrganisationId,
	) => {
		e.preventDefault();
		setActiveDropTarget(null);

		const payload = parseCapDrag(e.dataTransfer.getData(CAP_DRAG_TYPE));
		if (!payload) return;

		const spaceName = spacesData.find((s) => s.id === spaceId)?.name || "space";

		const toastId =
			payload.ids.length > 1
				? toast.loading(`Sharing ${payload.ids.length} Caps to ${spaceName}...`)
				: undefined;

		try {
			let shared = 0;
			let failure: string | undefined;
			let next = 0;
			const shareNext = async () => {
				while (next < payload.ids.length) {
					const capId = payload.ids[next++];
					if (!capId) continue;
					// A drop adds the space. It must not replace the spaces and
					// organizations the Cap is already shared with.
					const result = await shareCap({
						capId,
						spaceIds: [spaceId],
						keepExisting: true,
					}).catch(() => ({ success: false as const, error: undefined }));
					if (result.success) shared += 1;
					else failure ??= result.error;
				}
			};
			await Promise.all(
				Array.from(
					{ length: Math.min(SPACE_DROP_CONCURRENCY, payload.ids.length) },
					shareNext,
				),
			);

			if (shared === payload.ids.length) {
				toast.success(
					`Shared ${describeDraggedCaps(payload)} to ${spaceName}`,
					{ id: toastId },
				);
			} else if (shared > 0) {
				toast.warning(
					`Shared ${shared} of ${payload.ids.length} Caps to ${spaceName}`,
					{ id: toastId },
				);
			} else {
				toast.error(failure || "Failed to share cap", { id: toastId });
			}
			if (shared > 0) router.refresh();
		} catch (error) {
			console.error("Error sharing cap:", error);
			toast.error("Failed to share cap", { id: toastId });
		}
	};

	const activeSpaceParams = (spaceId: Space.SpaceIdOrOrganisationId) =>
		params.spaceId === spaceId;

	return (
		<div className="flex flex-col mt-5">
			<div
				className={clsx(
					"flex items-center mb-1 h-7",
					sidebarCollapsed ? "justify-center" : "justify-between",
				)}
			>
				<h2
					className={clsx(
						"pl-3 text-xs font-medium truncate text-gray-10",
						sidebarCollapsed ? "hidden" : "flex",
					)}
				>
					Spaces
				</h2>
				<Tooltip position="right" content="Create space">
					<Button
						className={clsx(
							"p-0 min-w-[unset] rounded-lg bg-transparent border-transparent hover:bg-gray-3 hover:border-transparent",
							sidebarCollapsed ? "size-8" : "size-6",
						)}
						variant="white"
						onClick={() => {
							setShowSpaceDialog(true);
						}}
					>
						<FontAwesomeIcon
							className={clsx(
								"text-gray-10",
								sidebarCollapsed ? "size-3.5" : "size-3",
							)}
							icon={faPlus}
						/>
					</Button>
				</Tooltip>
			</div>

			<Tooltip
				content="Browse spaces"
				disable={sidebarCollapsed === false}
				position="right"
			>
				<Link
					passHref
					onClick={() => toggleMobileNav?.()}
					prefetch={true}
					onMouseEnter={() => layersIconRef.current?.startAnimation()}
					onMouseLeave={() => layersIconRef.current?.stopAnimation()}
					href="/dashboard/spaces/browse"
					className={clsx(
						"relative border border-transparent transition z-3",
						sidebarCollapsed
							? "flex justify-center px-0 mb-0.5 items-center w-full size-9"
							: "h-9 w-full px-3 mb-0.5",
						pathname.includes("/dashboard/spaces/browse")
							? "dashboard-nav-active pointer-events-none"
							: "dashboard-nav-hover",
						"flex items-center justify-start rounded-lg outline-none overflow-hidden",
					)}
				>
					<LayersIcon
						ref={layersIconRef}
						className={clsx(
							pathname.includes("/dashboard/spaces/browse")
								? "text-gray-12"
								: "text-gray-10",
						)}
						size={sidebarCollapsed ? 18 : 16}
					/>
					<p
						className={clsx(
							"text-sm truncate",
							pathname.includes("/dashboard/spaces/browse")
								? "font-medium text-gray-12"
								: "text-gray-11",
							sidebarCollapsed ? "hidden" : "ml-2.5",
						)}
					>
						Browse spaces
					</p>
				</Link>
			</Tooltip>

			<div>
				{displayedSpaces.map((space: Spaces) => {
					return (
						<Tooltip
							position="right"
							disable={!sidebarCollapsed}
							content={space.name}
							key={space.id}
						>
							<li
								className={clsx(
									"relative list-none transition-colors overflow-visible duration-150 rounded-lg mb-0.5",
									activeSpaceParams(space.id)
										? "cursor-default"
										: "cursor-pointer",
								)}
								onDragOver={(e) => handleDragOver(e, space.id)}
								onDragLeave={handleDragLeave}
								onDrop={(e) => handleDrop(e, space.id)}
							>
								{activeSpaceParams(space.id) && (
									<motion.div
										layoutId="navlinks"
										className={clsx(
											"absolute rounded-lg dashboard-nav-active",
											sidebarCollapsed
												? "inset-0 right-0 left-0 mx-auto"
												: "inset-0",
										)}
										style={{ willChange: "transform" }}
										transition={{
											layout: {
												type: "tween",
												duration: 0.1,
											},
										}}
									/>
								)}
								<AnimatePresence>
									{activeDropTarget === space.id && (
										<motion.div
											className="absolute inset-0 z-10 rounded-lg border transition-all duration-200 pointer-events-none border-blue-9 bg-blue-3"
											initial={{ opacity: 0 }}
											animate={{ opacity: 1 }}
											exit={{ opacity: 0 }}
											transition={{ duration: 0.2 }}
										/>
									)}
								</AnimatePresence>
								<Link
									href={`/dashboard/spaces/${space.id}`}
									className={clsx(
										"flex relative z-10 items-center px-3 h-9 truncate rounded-lg transition-colors group/space",
										sidebarCollapsed ? "justify-center px-0" : "",
										!activeSpaceParams(space.id) && "dashboard-nav-hover",
									)}
								>
									<SignedImageUrl
										image={space.iconUrl}
										name={space.name}
										letterClass={clsx(
											sidebarCollapsed ? "text-sm" : "text-[11px]",
										)}
										className={clsx(
											"relative flex-shrink-0",
											sidebarCollapsed ? "size-6" : "size-[18px]",
										)}
									/>
									{!sidebarCollapsed && (
										<>
											<span
												className={clsx(
													"ml-2.5 text-sm truncate transition-colors group-hover/space:text-gray-12",
													activeSpaceParams(space.id)
														? "font-medium text-gray-12"
														: "text-gray-11",
												)}
											>
												{space.name}
											</span>
											{space.hasPassword && (
												<FontAwesomeIcon
													icon={faLock}
													className="ml-1.5 size-2.5 text-amber-600"
												/>
											)}
											{!space.primary && space.currentUserCanManage && (
												<button
													type="button"
													onClick={(e) => handleDeleteSpace(e, space)}
													className={
														"flex justify-center items-center -mr-1.5 ml-auto rounded-md opacity-0 transition-all size-6 group-hover/space:opacity-100 focus-visible:opacity-100 hover:bg-gray-4"
													}
													aria-label={`Delete ${space.name} space`}
												>
													<FontAwesomeIcon
														icon={faXmark}
														className="size-3 text-gray-10"
													/>
												</button>
											)}
										</>
									)}
								</Link>
							</li>
						</Tooltip>
					);
				})}
			</div>

			<SpaceToggleControl
				showAllSpaces={showAllSpaces}
				hasMoreSpaces={hasMoreSpaces}
				sidebarCollapsed={sidebarCollapsed}
				hiddenSpacesCount={hiddenSpacesCount}
				setShowAllSpaces={setShowAllSpaces}
			/>

			<ConfirmationDialog
				open={confirmOpen}
				icon={<FontAwesomeIcon icon={faLayerGroup} />}
				title="Delete space"
				description={
					pendingDeleteSpace
						? `Are you sure you want to delete the space "${pendingDeleteSpace.name}"? This action cannot be undone.`
						: ""
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
			<SpaceDialog
				open={showSpaceDialog}
				onClose={() => setShowSpaceDialog(false)}
				onSpaceUpdated={() => {
					router.refresh();
					setShowSpaceDialog(false);
				}}
			/>
		</div>
	);
};

const SpaceToggleControl = ({
	showAllSpaces,
	hasMoreSpaces,
	sidebarCollapsed,
	hiddenSpacesCount,
	setShowAllSpaces,
}: {
	showAllSpaces: boolean;
	hasMoreSpaces: boolean;
	sidebarCollapsed: boolean;
	hiddenSpacesCount: number;
	setShowAllSpaces: (show: boolean) => void;
}) => {
	if (sidebarCollapsed) return null;
	if (!showAllSpaces && hasMoreSpaces) {
		return (
			<button
				type="button"
				onClick={() => setShowAllSpaces(true)}
				className="flex justify-between items-center px-3 w-full h-9 truncate rounded-lg transition-colors cursor-pointer text-gray-10 hover:text-gray-12 dashboard-nav-hover"
			>
				<span className="text-sm text-gray-10">+ {hiddenSpacesCount} more</span>
				<ChevronDown size={16} className="ml-2" />
			</button>
		);
	}
	if (showAllSpaces) {
		return (
			<button
				type="button"
				onClick={() => setShowAllSpaces(false)}
				className="flex justify-between items-center px-3 w-full h-9 truncate rounded-lg transition-colors cursor-pointer text-gray-10 hover:text-gray-12 dashboard-nav-hover"
			>
				<span className="text-sm text-gray-10">Show less</span>
				<ChevronUp size={16} className="ml-2" />
			</button>
		);
	}
	return null;
};

export default SpacesList;
