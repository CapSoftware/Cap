import { faArrowDown } from "@fortawesome/free-solid-svg-icons/faArrowDown";
import { faArrowUp } from "@fortawesome/free-solid-svg-icons/faArrowUp";
import { faCog } from "@fortawesome/free-solid-svg-icons/faCog";
import Link from "next/link";
import { FontAwesomeIcon } from "@/components/FontAwesomeIcon";

export const NotificationFooter = ({ onClose }: { onClose?: () => void }) => {
	return (
		<div className="flex justify-between items-center px-6 py-3 rounded-b-xl border bg-gray-4 border-gray-5">
			<div className="flex gap-2 items-center">
				<p className="text-[13px] text-gray-10">Navigate</p>
				<div className="flex gap-1 justify-center items-center rounded-md size-4 bg-gray-10">
					<FontAwesomeIcon
						icon={faArrowDown}
						className="text-gray-2 size-2.5"
					/>
				</div>
				<div className="flex gap-1 justify-center items-center rounded-md size-4 bg-gray-10">
					<FontAwesomeIcon icon={faArrowUp} className="text-gray-2 size-2.5" />
				</div>
			</div>
			<Link
				href="/dashboard/settings/notifications"
				onClick={onClose}
				className="flex gap-1 items-center transition-opacity duration-200 cursor-pointer hover:opacity-70"
			>
				<FontAwesomeIcon icon={faCog} className="text-gray-10 size-3" />
				<p className="text-[13px] text-gray-10">Settings</p>
			</Link>
		</div>
	);
};
