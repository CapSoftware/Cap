import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuTrigger,
} from "@cap/ui";
import {
	faCopy,
	faEllipsis,
	faGlobe,
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
	public: boolean;
	onPublicToggle: () => void;
	onCopyPublicLink: () => void;
}

export const FoldersDropdown = ({
	setIsRenaming,
	setConfirmDeleteFolderOpen,
	nameRef,
	public: isPublic,
	onPublicToggle,
	onCopyPublicLink,
}: FoldersDropdownProps) => {
	return (
		<DropdownMenu>
			<DropdownMenuTrigger asChild>
				<button
					type="button"
					onClick={(e) => {
						e.preventDefault();
						e.stopPropagation();
					}}
					onMouseEnter={(e) => e.stopPropagation()}
					onMouseLeave={(e) => e.stopPropagation()}
					className="flex justify-center items-center rounded-full border transition-colors duration-200
            size-8 bg-gray-5 border-gray-7 hover:bg-gray-7 hover:border-gray-9 data-[state=open]:bg-gray-7 data-[state=open]:border-gray-9"
				>
					<FontAwesomeIcon className="text-gray-12 size-4" icon={faEllipsis} />
				</button>
			</DropdownMenuTrigger>
			<DropdownMenuContent>
				{(() => {
					type FolderDropdownItem = {
						label: string;
						icon: typeof faPencil;
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
						{
							label: isPublic ? "Make private" : "Make public",
							icon: faGlobe,
							onClick: onPublicToggle,
						},
						...(isPublic
							? [
									{
										label: "Copy public link",
										icon: faCopy,
										onClick: onCopyPublicLink,
									},
								]
							: []),
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
	);
};
