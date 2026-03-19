import { faArrowDown, faArrowUp } from "@fortawesome/free-solid-svg-icons";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { SettingsDropdown } from "./SettingsDropdown";

export const NotificationFooter = () => {
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
			<SettingsDropdown />
		</div>
	);
};
