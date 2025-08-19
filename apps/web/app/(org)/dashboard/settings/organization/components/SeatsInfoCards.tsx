"use client";

import { Card } from "@cap/ui";
import { faChair, faUserGroup } from "@fortawesome/free-solid-svg-icons";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { calculateSeats } from "@/utils/organization";

import { useDashboardContext } from "../../../Contexts";

export const SeatsInfoCards = () => {
	const { activeOrganization } = useDashboardContext();
	const { inviteQuota, remainingSeats } = calculateSeats(
		activeOrganization || {},
	);

	return (
		<div className="flex flex-col flex-1 gap-6 justify-center lg:flex-row">
			<Card className="flex flex-col flex-1 gap-3 justify-center items-center">
				<div className="flex justify-center items-center p-3 bg-gray-4 border border-gray-5 rounded-full">
					<FontAwesomeIcon className="text-white size-3.5" icon={faChair} />
				</div>
				<p className="text-gray-11">
					Seats Remaining
					<span className="ml-2 font-medium text-gray-12">
						{remainingSeats}
					</span>
				</p>
			</Card>
			<Card className="flex flex-col flex-1 gap-3 justify-center items-center">
				<div className="flex justify-center items-center p-3 bg-gray-4 border border-gray-5 rounded-full">
					<FontAwesomeIcon className="text-white size-3.5" icon={faUserGroup} />
				</div>
				<p className="text-gray-11">
					Seats Capacity
					<span className="ml-2 font-medium text-gray-12">{inviteQuota}</span>
				</p>
			</Card>
		</div>
	);
};
