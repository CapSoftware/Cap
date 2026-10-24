import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuTrigger,
} from "@cap/ui";
import {
	faCopy,
	faEllipsis,
	faFolderTree,
	faGlobe,
	faPencil,
	faTrash,
} from "@fortawesome/free-solid-svg-icons";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { type RefObject, useRef } from "react";

interface FoldersDropdownProps {
	id: string;
	setIsRenaming: (isRenaming: boolean) => void;
	setConfirmDeleteFolderOpen: (open: boolean) => void;
	nameRef: RefObject<HTMLTextAreaElement | null>;
	parentId?: string | null;
	public: boolean;
	onPublicToggle: () => void;
	onCopyPublicLink: () => void;
	canMove: boolean;
	onMove: () => void;
}

export const FoldersDropdown = ({
	setIsRenaming,
	setConfirmDeleteFolderOpen,
	nameRef,
	public: isPublic,
	onPublicToggle,
	onCopyPublicLink,
	canMove,
	onMove,
}: FoldersDropdownProps) => {
	const renameRequestedRef = useRef(false);

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
			<DropdownMenuContent
				onCloseAutoFocus={(event) => {
					// Radix restores focus to the trigger on close from a setTimeout(0)
					// scheduled when the menu unmounts, so it always lands after the
					// rename focus calls below. That blur makes the textarea's onBlur
					// exit rename mode instantly (reported as "flashes then can't
					// type"). Opt out for rename only; other items still restore focus
					// to the trigger.
					if (!renameRequestedRef.current) return;
					renameRequestedRef.current = false;
					event.preventDefault();
					// Fallback only: never take focus back off wherever the user has
					// since clicked.
					if (document.activeElement === document.body) {
						nameRef.current?.focus();
						nameRef.current?.select();
					}
				}}
			>
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
								renameRequestedRef.current = true;
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
						...(canMove
							? [
									{
										label: "Move",
										icon: faFolderTree,
										onClick: onMove,
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
