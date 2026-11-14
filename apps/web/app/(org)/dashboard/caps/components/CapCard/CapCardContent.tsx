import { faChevronDown } from "@fortawesome/free-solid-svg-icons/faChevronDown";
import clsx from "clsx";
import { useRouter } from "next/navigation";
import { useRef, useState } from "react";
import { toast } from "sonner";
import { editDate } from "@/actions/videos/edit-date";
import { editTitle } from "@/actions/videos/edit-title";
import { FontAwesomeIcon } from "@/components/FontAwesomeIcon";
import { Tooltip } from "@/components/Tooltip";
import { formatDateTime, formatFromNow } from "@/lib/date-format";
import type { CapCardProps } from "./CapCard";

// Only typed dates need moment's parser, so it loads when the date editor opens
// instead of shipping with every dashboard page.
const loadMoment = () => import("moment").then((module) => module.default);

interface CapContentProps {
	cap: CapCardProps["cap"];
	userId?: string;
	sharedCapCard?: boolean;
	hideSharedStatus?: boolean;
	isOwner: boolean;
	setIsSharingDialogOpen: (isSharingDialogOpen: boolean) => void;
}

export const CapCardContent: React.FC<CapContentProps> = ({
	cap,
	userId,
	sharedCapCard = false,
	hideSharedStatus,
	isOwner,
	setIsSharingDialogOpen,
}) => {
	const router = useRouter();
	const effectiveDate = cap.metadata?.customCreatedAt
		? new Date(cap.metadata.customCreatedAt)
		: cap.createdAt;

	const [dateValue, setDateValue] = useState(formatDateTime(effectiveDate));
	const [isDateEditing, setIsDateEditing] = useState(false);
	const [showFullDate, setShowFullDate] = useState(false);
	const [title, setTitle] = useState(cap.name);
	const [savedTitle, setSavedTitle] = useState(cap.name);
	const [isEditing, setIsEditing] = useState(false);
	// The field stays editable while a save is in flight, so the save reads
	// the latest draft and the editor state to avoid replacing text typed
	// after the blur.
	const draftRef = useRef(cap.name);
	const editingRef = useRef(false);

	const setEditing = (value: boolean) => {
		editingRef.current = value;
		setIsEditing(value);
	};

	const setDraft = (value: string) => {
		draftRef.current = value;
		setTitle(value);
	};

	const handleTitleBlur = async () => {
		const next = title.trim();
		if (!next || next === savedTitle) {
			setDraft(savedTitle);
			setEditing(false);
			return;
		}

		try {
			await editTitle(cap.id, next);
			setSavedTitle(next);
			toast.success("Video title updated");
			if (!editingRef.current || draftRef.current.trim() === next) {
				setDraft(next);
				setEditing(false);
			}
			router.refresh();
		} catch (error) {
			if (error instanceof Error) {
				toast.error(error.message);
			} else {
				toast.error("Failed to update title - please try again.");
			}
		}
	};

	const handleDateClick = () => {
		if (userId === cap.ownerId) {
			if (!isDateEditing) {
				loadMoment().catch(() => {});
				setIsDateEditing(true);
			}
		} else {
			setShowFullDate(!showFullDate);
		}
	};

	const handleTitleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
		if (e.key === "Enter") {
			e.preventDefault();
		}
	};

	const handleDateChange = (e: React.ChangeEvent<HTMLInputElement>) => {
		setDateValue(e.target.value);
	};

	const handleDateBlur = async () => {
		let moment: Awaited<ReturnType<typeof loadMoment>>;
		try {
			moment = await loadMoment();
		} catch {
			toast.error("Failed to update date - please try again.");
			return;
		}
		const isValidDate = moment(dateValue).isValid();

		if (!isValidDate) {
			toast.error("Invalid date format. Please use YYYY-MM-DD HH:mm:ss");
			setDateValue(formatDateTime(effectiveDate));
			setIsDateEditing(false);
			return;
		}

		const selectedDate = moment(dateValue);
		const currentDate = moment();

		if (selectedDate.isAfter(currentDate)) {
			toast.error("Cannot set a date in the future");
			setDateValue(formatDateTime(effectiveDate));
			setIsDateEditing(false);
			return;
		}

		if (selectedDate.isSame(effectiveDate)) {
			setIsDateEditing(false);
			return;
		}

		try {
			await editDate(cap.id, selectedDate.toISOString());
			toast.success("Video date updated");
			setIsDateEditing(false);
			router.refresh();
		} catch (error) {
			if (error instanceof Error) {
				toast.error(error.message);
			} else {
				toast.error("Failed to update date - please try again.");
			}
		}
	};

	const handleDateKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
		if (e.key === "Enter") {
			e.preventDefault();
			handleDateBlur();
		} else if (e.key === "Escape") {
			setDateValue(formatDateTime(effectiveDate));
			setIsDateEditing(false);
		}
	};

	const renderSharedStatus = () => {
		const baseClassName = clsx(
			"flex shrink-0 gap-1 items-center text-[13px] text-gray-10 transition-colors duration-200",
			"hover:text-gray-12",
			hideSharedStatus ? "pointer-events-none" : "cursor-pointer",
		);
		if (isOwner && !hideSharedStatus) {
			const hasSpaceSharing =
				(cap.sharedOrganizations?.length ?? 0) > 0 ||
				(cap.sharedSpaces?.length ?? 0) > 0;
			const isPublic = cap.public;

			if (!hasSpaceSharing && !isPublic) {
				return (
					<p
						className={baseClassName}
						onClick={() => setIsSharingDialogOpen(true)}
					>
						Not shared
						<FontAwesomeIcon
							className="size-2 text-gray-9"
							icon={faChevronDown}
						/>
					</p>
				);
			} else {
				return (
					<p
						className={baseClassName}
						onClick={() => setIsSharingDialogOpen(true)}
					>
						Shared
						<FontAwesomeIcon
							className="size-2 text-gray-9"
							icon={faChevronDown}
						/>
					</p>
				);
			}
		}
		if (isOwner) return null;
		return <p className={baseClassName}>Shared with you</p>;
	};
	const sharedStatus = renderSharedStatus();

	return (
		<div className="flex flex-col gap-1 min-w-0">
			<div className="h-5">
				{isEditing && !sharedCapCard ? (
					<textarea
						rows={1}
						value={title}
						onChange={(e) => setDraft(e.target.value)}
						onBlur={handleTitleBlur}
						onKeyDown={(e) => handleTitleKeyDown(e)}
						className="overflow-hidden p-0 m-0 w-full h-5 text-sm font-medium tracking-normal leading-5 truncate bg-transparent border-0 resize-none outline-0 text-gray-12 font-[inherit]"
					/>
				) : (
					<p
						className="p-0 m-0 h-5 text-sm font-medium tracking-normal leading-5 truncate text-gray-12"
						onClick={() => {
							if (!sharedCapCard) {
								if (userId === cap.ownerId) {
									setEditing(true);
								}
							}
						}}
					>
						{title}
					</p>
				)}
			</div>

			<div className="flex gap-1.5 items-center min-w-0 h-5">
				{sharedStatus}
				{sharedStatus && (
					<span aria-hidden className="text-[13px] text-gray-7">
						·
					</span>
				)}
				{isDateEditing && !sharedCapCard ? (
					<input
						type="text"
						value={dateValue}
						onChange={handleDateChange}
						onBlur={handleDateBlur}
						onKeyDown={handleDateKeyDown}
						className="flex-1 min-w-0 h-5 text-[13px] leading-5 truncate bg-transparent text-gray-10 focus:outline-none"
						placeholder="YYYY-MM-DD HH:mm:ss"
					/>
				) : (
					<Tooltip content={`Cap created at ${effectiveDate}`}>
						<p
							className="min-w-0 text-[13px] leading-5 truncate transition-colors cursor-pointer text-gray-10 hover:text-gray-12"
							onClick={handleDateClick}
						>
							{showFullDate
								? formatDateTime(effectiveDate)
								: formatFromNow(effectiveDate)}
						</p>
					</Tooltip>
				)}
			</div>
		</div>
	);
};
