import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuTrigger,
} from "@cap/ui";
import {
	faEllipsis,
	faPencil,
	faTrash,
} from "@fortawesome/free-solid-svg-icons";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import type { RefObject } from "react";

interface FoldersDropdownProps {
	id: string;
	setIsRenaming: (isRenaming: boolean) => void;
	setConfirmDeleteFolderOpen: (open: boolean) => void;
	nameRef: RefObject<HTMLTextAreaElement | null>;
	parentId?: string | null;
}

export const FoldersDropdown = ({
	setIsRenaming,
	setConfirmDeleteFolderOpen,
	nameRef,
}: FoldersDropdownProps) => {
	return (
		<div
			onClick={(e) => e.stopPropagation()}
			onMouseEnter={(e) => e.stopPropagation()}
			onMouseLeave={(e) => e.stopPropagation()}
		>
			<DropdownMenu>
				<DropdownMenuTrigger asChild>
					<div
						className="flex justify-center items-center rounded-full border transition-colors duration-200
            size-8 bg-gray-5 border-gray-7 hover:bg-gray-7 hover:border-gray-9 data-[state=open]:bg-gray-7 data-[state=open]:border-gray-9"
					>
						<FontAwesomeIcon
							className="text-gray-12 size-4"
							icon={faEllipsis}
						/>
					</div>
				</DropdownMenuTrigger>
				<DropdownMenuContent>
					{(() => {
						type FolderDropdownItem = {
							label: string;
							icon: any;
							onClick: () => void | Promise<void>;
						};
						const items: FolderDropdownItem[] = [
							{
								label: "Rename",
								icon: faPencil,
								onClick: () => {
									setIsRenaming(true);
									setTimeout(() => {
										nameRef.current?.focus();
										nameRef.current?.select();
									}, 0);
								},
							},
							// Only show Duplicate if there is NO active space
							// ...(!activeSpace
							//   ? [
							//       {
							//         label: "Duplicate",
							//         icon: faCopy,
							//         onClick: async () => {
							//           try {
							//             await duplicateFolder(id, parentId);
							//             toast.success("Folder duplicated successfully");
							//           } catch (error) {
							//             toast.error("Failed to duplicate folder");
							//           }
							//         },
							//       },
							//     ]
							//   : []),
							{
								label: "Delete",
								icon: faTrash,
								onClick: () => setConfirmDeleteFolderOpen(true),
							},
						];
						return items.map((item) => (
							<DropdownMenuItem
								key={item.label}
								onClick={item.onClick}
								className="rounded-lg"
							>
								<FontAwesomeIcon
									className="mr-1.5 text-gray-10 size-3"
									icon={item.icon}
								/>
								{item.label}
							</DropdownMenuItem>
						));
					})()}
				</DropdownMenuContent>
			</DropdownMenu>
		</div>
	);
};
