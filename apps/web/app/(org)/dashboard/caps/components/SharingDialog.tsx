import {
	Avatar,
	Button,
	Dialog,
	DialogContent,
	DialogFooter,
	DialogHeader,
	DialogTitle,
	Input,
	Switch,
} from "@cap/ui";
import { faCopy, faShareNodes } from "@fortawesome/free-solid-svg-icons";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import clsx from "clsx";
import { motion } from "framer-motion";
import { Check, Globe2, Search } from "lucide-react";
import Image from "next/image";
import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { shareCap } from "@/actions/caps/share";
import { useDashboardContext } from "@/app/(org)/dashboard/Contexts";
import type { Spaces } from "@/app/(org)/dashboard/dashboard-data";
import { Tooltip } from "@/components/Tooltip";

interface SharingDialogProps {
	isOpen: boolean;
	onClose: () => void;
	capId: string;
	capName: string;
	sharedSpaces: {
		id: string;
		name: string;
		iconUrl?: string | null;
		organizationId: string;
	}[];
	onSharingUpdated: (updatedSharedSpaces: string[]) => void;
	isPublic?: boolean;
	spacesData?: Spaces[] | null;
}

export const SharingDialog: React.FC<SharingDialogProps> = ({
	isOpen,
	onClose,
	capId,
	capName,
	sharedSpaces,
	onSharingUpdated,
	isPublic = false,
	spacesData: propSpacesData = null,
}) => {
	const { spacesData: contextSpacesData } = useDashboardContext();
	const spacesData = propSpacesData || contextSpacesData;
	const [selectedSpaces, setSelectedSpaces] = useState<Set<string>>(new Set());
	const [searchTerm, setSearchTerm] = useState("");
	const [initialSelectedSpaces, setInitialSelectedSpaces] = useState<
		Set<string>
	>(new Set());
	const [loading, setLoading] = useState(false);
	const [publicToggle, setPublicToggle] = useState(isPublic);
	const [initialPublicState, setInitialPublicState] = useState(isPublic);
	const tabs = ["Share", "Embed"] as const;
	const [activeTab, setActiveTab] = useState<(typeof tabs)[number]>("Share");

	const sharedSpaceIds = new Set(sharedSpaces?.map((space) => space.id) || []);

	useEffect(() => {
		if (isOpen && sharedSpaces) {
			const spaceIds = new Set(sharedSpaces.map((space) => space.id));
			setSelectedSpaces(spaceIds);
			setInitialSelectedSpaces(spaceIds);
			setPublicToggle(isPublic);
			setInitialPublicState(isPublic);
			setSearchTerm("");
			setActiveTab(tabs[0]);
		}
	}, [isOpen, sharedSpaces, isPublic]);

	const isSpaceSharedViaOrganization = useCallback(
		(spaceId: string) => {
			const space = spacesData?.find((s) => s.id === spaceId);
			if (!space) return false;
			return sharedSpaceIds.has(space.id);
		},
		[spacesData, sharedSpaceIds],
	);

	const handleToggleSpace = (spaceId: string) => {
		setSelectedSpaces((prev) => {
			const newSet = new Set(prev);
			if (newSet.has(spaceId)) {
				newSet.delete(spaceId);
			} else {
				newSet.add(spaceId);
			}
			return newSet;
		});
	};

	const handleSave = async () => {
		try {
			setLoading(true);
			const result = await shareCap({
				capId,
				spaceIds: Array.from(selectedSpaces),
				public: publicToggle,
			});

			if (!result.success) {
				throw new Error(result.error || "Failed to update sharing settings");
			}

			const newSelectedSpaces = Array.from(selectedSpaces);
			const initialSpaces = Array.from(initialSelectedSpaces);

			const addedSpaceIds = newSelectedSpaces.filter(
				(id) => !initialSpaces.includes(id),
			);
			const removedSpaceIds = initialSpaces.filter(
				(id) => !newSelectedSpaces.includes(id),
			);

			const publicChanged = publicToggle !== initialPublicState;

			const getSpaceName = (id: string) => {
				const space = spacesData?.find((space) => space.id === id);
				return space?.name || `Space ${id}`;
			};

			if (
				publicChanged &&
				addedSpaceIds.length === 0 &&
				removedSpaceIds.length === 0
			) {
				toast.success(
					publicToggle ? "Video is now public" : "Video is now private",
				);
			} else if (
				addedSpaceIds.length === 1 &&
				removedSpaceIds.length === 0 &&
				!publicChanged
			) {
				toast.success(`Shared to ${getSpaceName(addedSpaceIds[0] as string)}`);
			} else if (
				removedSpaceIds.length === 1 &&
				addedSpaceIds.length === 0 &&
				!publicChanged
			) {
				toast.success(
					`Unshared from ${getSpaceName(removedSpaceIds[0] as string)}`,
				);
			} else if (
				addedSpaceIds.length > 0 &&
				removedSpaceIds.length === 0 &&
				!publicChanged
			) {
				toast.success(`Shared to ${addedSpaceIds.length} spaces`);
			} else if (
				removedSpaceIds.length > 0 &&
				addedSpaceIds.length === 0 &&
				!publicChanged
			) {
				toast.success(`Unshared from ${removedSpaceIds.length} spaces`);
			} else if (
				addedSpaceIds.length > 0 ||
				removedSpaceIds.length > 0 ||
				publicChanged
			) {
				toast.success(`Sharing settings updated`);
			} else {
				toast.info("No changes to sharing settings");
			}
			onSharingUpdated(newSelectedSpaces);
			onClose();
		} catch (error) {
			toast.error("Failed to update sharing settings");
		} finally {
			setLoading(false);
		}
	};

	const handleCopyEmbedCode = async () => {
		const embedCode = `<div style="position: relative; padding-bottom: 56.25%; height: 0;"><iframe src="${
			process.env.NODE_ENV === "development"
				? process.env.NEXT_PUBLIC_WEB_URL
				: "https://cap.so"
		}/embed/${capId}" frameborder="0" webkitallowfullscreen mozallowfullscreen allowfullscreen style="position: absolute; top: 0; left: 0; width: 100%; height: 100%;"></iframe></div>`;

		try {
			await navigator.clipboard.writeText(embedCode);
			toast.success("Embed code copied to clipboard");
		} catch (error) {
			toast.error("Failed to copy embed code");
		}
	};

	// Separate organization entries from real spaces
	const organizationEntries =
		spacesData?.filter(
			(space) => space.id === space.organizationId && space.primary === true,
		) || [];

	const realSpaces =
		spacesData?.filter(
			(space) => !(space.id === space.organizationId && space.primary === true),
		) || [];

	const allShareableItems = [...organizationEntries, ...realSpaces];

	const filteredSpaces = searchTerm
		? allShareableItems.filter((space) =>
				space.name.toLowerCase().includes(searchTerm.toLowerCase()),
			)
		: allShareableItems;

	return (
		<Dialog open={isOpen} onOpenChange={onClose}>
			<DialogContent className="p-0 w-full max-w-md rounded-xl border bg-gray-2 border-gray-4">
				<DialogHeader
					icon={<FontAwesomeIcon icon={faShareNodes} className="size-3.5" />}
					description={
						activeTab === "Share"
							? "Select how you would like to share the cap"
							: "Copy the embed code to share your cap"
					}
				>
					<DialogTitle className="truncate w-full max-w-[320px]">
						{activeTab === "Share" ? `Share ${capName}` : `Embed ${capName}`}
					</DialogTitle>
				</DialogHeader>

				<div className="flex w-full h-12 border-b bg-gray-1 border-gray-4">
					{tabs.map((tab) => (
						<div
							key={tab}
							className={clsx(
								"flex relative flex-1 justify-center items-center w-full min-w-0 text-sm font-medium transition-colors",
								activeTab === tab
									? "cursor-not-allowed bg-gray-3"
									: "cursor-pointer",
							)}
							onClick={() => setActiveTab(tab)}
						>
							<p
								className={clsx(
									activeTab === tab
										? "text-gray-12 font-medium"
										: "text-gray-10",
									"text-sm",
								)}
							>
								{tab}
							</p>
						</div>
					))}
				</div>

				<div className="p-5">
					{activeTab === "Share" ? (
						<>
							{/* Public sharing toggle */}
							<div className="flex items-center justify-between p-3 mb-4 rounded-lg border bg-gray-1 border-gray-4">
								<div className="flex items-center gap-3">
									<div className="flex items-center justify-center w-8 h-8 rounded-full bg-gray-3">
										<Globe2 className="w-4 h-4 text-gray-11" />
									</div>
									<div>
										<p className="text-sm font-medium text-gray-12">
											Anyone with the link
										</p>
										<p className="text-xs text-gray-10">
											{publicToggle
												? "Anyone on the internet with the link can view"
												: "Only people with access can view"}
										</p>
									</div>
								</div>
								<Switch
									checked={publicToggle}
									onCheckedChange={setPublicToggle}
								/>
							</div>

							<div className="relative mb-3">
								<Input
									type="text"
									placeholder="Search and add to spaces..."
									value={searchTerm}
									className="pr-8"
									onChange={(e) => setSearchTerm(e.target.value)}
								/>
								<Search
									className="absolute right-3 top-1/2 transform -translate-y-1/2 text-gray-10"
									size={20}
								/>
							</div>
							<div className="grid overflow-y-auto grid-cols-4 gap-3 pt-2 max-h-60">
								{filteredSpaces && filteredSpaces.length > 0 ? (
									filteredSpaces.map((space) => (
										<SpaceCard
											key={space.id}
											space={space}
											selectedSpaces={selectedSpaces}
											handleToggleSpace={handleToggleSpace}
											isSharedViaOrganization={isSpaceSharedViaOrganization(
												space.id,
											)}
										/>
									))
								) : (
									<div className="flex col-span-5 gap-2 justify-center items-center text-sm">
										<p className="text-gray-12">
											{allShareableItems && allShareableItems.length > 0
												? "No spaces match your search"
												: "No spaces available"}
										</p>
									</div>
								)}
							</div>
						</>
					) : (
						<div className="space-y-4">
							<div className="p-3 rounded-lg border bg-gray-3 border-gray-4">
								<code className="font-mono text-xs break-all text-gray-11">
									{`<div style="position: relative; padding-bottom: 56.25%; height: 0;"><iframe src="${
										process.env.NODE_ENV === "development"
											? process.env.NEXT_PUBLIC_WEB_URL
											: "https://cap.so"
									}/embed/${capId}" frameborder="0" webkitallowfullscreen mozallowfullscreen allowfullscreen style="position: absolute; top: 0; left: 0; width: 100%; height: 100%;"></iframe></div>`}
								</code>
							</div>
							<Button
								className="w-full font-medium"
								variant="dark"
								onClick={handleCopyEmbedCode}
							>
								<FontAwesomeIcon icon={faCopy} className="size-3.5 mr-1" />
								Copy embed code
							</Button>
						</div>
					)}
				</div>

				<DialogFooter className="p-5 border-t border-gray-4">
					{activeTab === "Share" ? (
						<>
							<Button size="sm" variant="gray" onClick={onClose}>
								Cancel
							</Button>
							<Button
								spinner={loading}
								disabled={loading}
								size="sm"
								variant="dark"
								onClick={handleSave}
							>
								{loading ? "Saving..." : "Save"}
							</Button>
						</>
					) : (
						<Button size="sm" variant="gray" onClick={onClose}>
							Close
						</Button>
					)}
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
};

const SpaceCard = ({
	space,
	selectedSpaces,
	handleToggleSpace,
	isSharedViaOrganization,
}: {
	space: {
		id: string;
		name: string;
		iconUrl?: string | null;
		organizationId: string;
	};
	selectedSpaces: Set<string>;
	handleToggleSpace: (spaceId: string) => void;
	isSharedViaOrganization?: boolean;
}) => {
	const isSelected = selectedSpaces.has(space.id);

	return (
		<Tooltip
			content={
				isSharedViaOrganization
					? `${space.name} (shared via organization)`
					: space.name
			}
		>
			<div
				className={clsx(
					"flex items-center relative overflow-visible flex-col justify-center gap-2 border transition-colors bg-gray-2",
					"duration-200 w-full p-2.5 rounded-xl cursor-pointer",
					isSelected
						? "bg-gray-3 border-green-500"
						: "hover:bg-gray-3 hover:border-gray-5 border-gray-4",
					isSharedViaOrganization && "ring-1 ring-inset ring-green-500/30",
				)}
				onClick={() => handleToggleSpace(space.id)}
			>
				{space.iconUrl ? (
					<div className="overflow-hidden relative flex-shrink-0 rounded-full size-5">
						<Image
							src={space.iconUrl}
							alt={space.name}
							width={24}
							height={24}
							className="object-cover w-full h-full"
						/>
					</div>
				) : (
					<Avatar
						letterClass="text-[11px]"
						className="relative z-10 flex-shrink-0 size-5"
						name={space.name}
					/>
				)}
				<p className="max-w-full text-xs truncate transition-colors duration-200 text-gray-10">
					{space.name}
				</p>
				<motion.div
					key={space.id}
					animate={{
						scale: isSelected ? 1 : 0,
					}}
					initial={{
						scale: isSelected ? 1 : 0,
					}}
					transition={{
						type: isSelected ? "spring" : "tween",
						stiffness: isSelected ? 300 : undefined,
						damping: isSelected ? 20 : undefined,
						duration: !isSelected ? 0.2 : undefined,
					}}
					className="flex absolute -top-2 -right-2 z-10 justify-center items-center bg-green-500 rounded-full bg-gray-4 size-4"
				>
					<Check className="text-white" size={10} />
				</motion.div>
			</div>
		</Tooltip>
	);
};
