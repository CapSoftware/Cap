import {
	Button,
	Dialog,
	DialogContent,
	DialogFooter,
	DialogHeader,
	DialogTitle,
	Input,
} from "@cap/ui";
import { faFolderPlus } from "@fortawesome/free-solid-svg-icons";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import clsx from "clsx";
import React, { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { createFolder } from "@/actions/folders/createFolder";
import { BlueFolder, NormalFolder, RedFolder, YellowFolder } from "./Folders";

interface Props {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	spaceId?: string;
}

const FolderOptions = [
	{
		value: "normal",
		label: "Normal",
		component: <NormalFolder />,
	},
	{
		value: "blue",
		label: "Blue",
		component: <BlueFolder />,
	},
	{
		value: "red",
		label: "Red",
		component: <RedFolder />,
	},
	{
		value: "yellow",
		label: "Yellow",
		component: <YellowFolder />,
	},
] as const;

export const NewFolderDialog: React.FC<Props> = ({
	open,
	onOpenChange,
	spaceId,
}) => {
	const [selectedColor, setSelectedColor] = useState<
		(typeof FolderOptions)[number]["value"] | null
	>(null);
	const [folderName, setFolderName] = useState<string>("");
	const folderRefs = useRef<Record<string, any>>({});
	const [loading, setLoading] = useState<boolean>(false);

	useEffect(() => {
		if (!open) setSelectedColor(null);
	}, [open]);

	const createFolderHandler = async () => {
		if (!selectedColor) return;
		try {
			setLoading(true);
			await createFolder({
				name: folderName,
				color: selectedColor,
				spaceId,
			});
			setFolderName("");
			setSelectedColor(null);
			onOpenChange(false);
			toast.success("Folder created successfully");
		} catch (error: any) {
			toast.error("Failed to create folder");
		} finally {
			setLoading(false);
		}
	};

	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent className="w-[calc(100%-20px)]">
				<DialogHeader
					icon={<FontAwesomeIcon icon={faFolderPlus} className="size-3.5" />}
				>
					<DialogTitle>New Folder</DialogTitle>
				</DialogHeader>
				<div className="p-5">
					<Input
						value={folderName}
						onChange={(e) => setFolderName(e.target.value)}
						required
						placeholder="Folder name"
					/>
					<div className="flex flex-wrap gap-2 mt-3">
						{FolderOptions.map((option) => {
							const folderRef = useRef<any>(null);
							folderRefs.current[option.value] = folderRef;

							return (
								<div
									className={clsx(
										"flex flex-col flex-1 gap-1 items-center p-2 rounded-xl border transition-colors duration-200 cursor-pointer",
										selectedColor === option.value
											? "border-gray-12 bg-gray-3 hover:bg-gray-3 hover:border-gray-12"
											: "border-gray-4 hover:bg-gray-3 hover:border-gray-5 bg-transparent",
									)}
									key={option.value}
									onClick={() => {
										if (selectedColor === option.value) {
											setSelectedColor(null);
											return;
										}
										setSelectedColor(option.value);
									}}
									onMouseEnter={() => {
										const folderRef = folderRefs.current[option.value]?.current;
										if (!folderRef) return;
										folderRef.stop();
										folderRef.play("folder-open");
									}}
									onMouseLeave={() => {
										const folderRef = folderRefs.current[option.value]?.current;
										if (!folderRef) return;
										folderRef.stop();
										folderRef.play("folder-close");
									}}
								>
									{React.cloneElement(option.component, { ref: folderRef })}
									<p className="text-xs text-gray-10">{option.label}</p>
								</div>
							);
						})}
					</div>
				</div>
				<DialogFooter>
					<Button size="sm" variant="gray" onClick={() => onOpenChange(false)}>
						Cancel
					</Button>
					<Button
						onClick={createFolderHandler}
						size="sm"
						spinner={loading}
						variant="dark"
						disabled={!selectedColor || !folderName.trim().length || loading}
					>
						{loading ? "Creating..." : "Create"}
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
};
