import { faChevronDown } from "@fortawesome/free-solid-svg-icons";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import clsx from "clsx";
import moment from "moment";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { toast } from "sonner";
import { editDate } from "@/actions/videos/edit-date";
import { editTitle } from "@/actions/videos/edit-title";
import { Tooltip } from "@/components/Tooltip";
import { removeCapFromVideoTitle } from "@/lib/video-title";
import type { CapCardProps } from "./CapCard";

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

	const [dateValue, setDateValue] = useState(
		moment(effectiveDate).format("YYYY-MM-DD HH:mm:ss"),
	);
	const [isDateEditing, setIsDateEditing] = useState(false);
	const [showFullDate, setShowFullDate] = useState(false);
	const displayName = removeCapFromVideoTitle(cap.name);
	const [title, setTitle] = useState(displayName);
	const [isEditing, setIsEditing] = useState(false);

	const handleTitleBlur = async (capName: string) => {
		if (!title || capName === title) {
			setIsEditing(false);
			return;
		}

		try {
			await editTitle(cap.id, title);
			toast.success("Video title updated");
			setIsEditing(false);
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

	const handleSharedStatusKeyDown = (e: React.KeyboardEvent<HTMLElement>) => {
		if (e.key === "Enter" || e.key === " ") {
			e.preventDefault();
			setIsSharingDialogOpen(true);
		}
	};

	const handleTitleDisplayKeyDown = (e: React.KeyboardEvent<HTMLElement>) => {
		if ((e.key === "Enter" || e.key === " ") && !sharedCapCard) {
			e.preventDefault();
			if (userId === cap.ownerId) setIsEditing(true);
		}
	};

	const handleDateChange = (e: React.ChangeEvent<HTMLInputElement>) => {
		setDateValue(e.target.value);
	};

	const handleDateBlur = async () => {
		const isValidDate = moment(dateValue).isValid();

		if (!isValidDate) {
			toast.error("Invalid date format. Please use YYYY-MM-DD HH:mm:ss");
			setDateValue(moment(effectiveDate).format("YYYY-MM-DD HH:mm:ss"));
			setIsDateEditing(false);
			return;
		}

		const selectedDate = moment(dateValue);
		const currentDate = moment();

		if (selectedDate.isAfter(currentDate)) {
			toast.error("Cannot set a date in the future");
			setDateValue(moment(effectiveDate).format("YYYY-MM-DD HH:mm:ss"));
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
			setDateValue(moment(effectiveDate).format("YYYY-MM-DD HH:mm:ss"));
			setIsDateEditing(false);
		}
	};

	const handleDateDisplayKeyDown = (e: React.KeyboardEvent<HTMLElement>) => {
		if (e.key === "Enter" || e.key === " ") {
			e.preventDefault();
			handleDateClick();
		}
	};

	const renderSharedStatus = () => {
		const baseClassName = clsx(
			"text-sm text-gray-10 transition-colors duration-200 flex items-center mb-1",
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
					<button
						type="button"
						className={clsx(
							baseClassName,
							"border-0 bg-transparent p-0 text-left",
						)}
						onClick={() => setIsSharingDialogOpen(true)}
						onKeyDown={handleSharedStatusKeyDown}
					>
						Not shared{" "}
						<FontAwesomeIcon className="ml-2 size-2.5" icon={faChevronDown} />
					</button>
				);
			} else {
				return (
					<button
						type="button"
						className={clsx(
							baseClassName,
							"border-0 bg-transparent p-0 text-left",
						)}
						onClick={() => setIsSharingDialogOpen(true)}
						onKeyDown={handleSharedStatusKeyDown}
					>
						Shared{" "}
						<FontAwesomeIcon className="ml-1 size-2.5" icon={faChevronDown} />
					</button>
				);
			}
		} else {
			return <p className={baseClassName}>Shared with you</p>;
		}
	};

	return (
		<div>
			<div className="h-[1.25rem] mb-1">
				{isEditing && !sharedCapCard ? (
					<textarea
						rows={1}
						value={title}
						onChange={(e) => setTitle(e.target.value)}
						onBlur={() => handleTitleBlur(displayName)}
						onKeyDown={(e) => handleTitleKeyDown(e)}
						className="text-md resize-none bg-transparent truncate w-full border-0 outline-0 text-gray-12 font-medium p-0 m-0 h-[1.25rem] overflow-hidden leading-[1.25rem] tracking-normal font-[inherit]"
					/>
				) : (
					<p
						className="text-md truncate leading-[1.25rem] text-gray-12 font-medium p-0 m-0 h-[1.25rem] tracking-normal"
						onClick={() => {
							if (!sharedCapCard) {
								if (userId === cap.ownerId) {
									setIsEditing(true);
								}
							}
						}}
						onKeyDown={handleTitleDisplayKeyDown}
						role={
							!sharedCapCard && userId === cap.ownerId ? "button" : undefined
						}
						tabIndex={!sharedCapCard && userId === cap.ownerId ? 0 : undefined}
					>
						{title}
					</p>
				)}
			</div>

			{renderSharedStatus()}
			<div className="mb-1 h-[1.5rem]">
				{isDateEditing && !sharedCapCard ? (
					<div className="flex items-center h-full">
						<input
							type="text"
							value={dateValue}
							onChange={handleDateChange}
							onBlur={handleDateBlur}
							onKeyDown={handleDateKeyDown}
							className="text-sm w-full truncate text-gray-10 bg-transparent focus:outline-none h-full leading-[1.5rem]"
							placeholder="YYYY-MM-DD HH:mm:ss"
						/>
					</div>
				) : (
					<Tooltip content={`Video created at ${effectiveDate}`}>
						<button
							type="button"
							className="text-sm truncate text-gray-10 cursor-pointer flex items-center h-full leading-[1.5rem] border-0 bg-transparent p-0 text-left"
							onClick={handleDateClick}
							onKeyDown={handleDateDisplayKeyDown}
						>
							{showFullDate
								? moment(effectiveDate).format("YYYY-MM-DD HH:mm:ss")
								: moment(effectiveDate).fromNow()}
						</button>
					</Tooltip>
				)}
			</div>
			{cap.expiresAt && (
				<p className="text-xs truncate text-amber-11">
					Deletes {moment(cap.expiresAt).fromNow()}
				</p>
			)}
		</div>
	);
};
