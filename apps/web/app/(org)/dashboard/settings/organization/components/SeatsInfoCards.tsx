"use client";

import { Card } from "@cap/ui";
import {
	faChair,
	faCrown,
	faUserGroup,
} from "@fortawesome/free-solid-svg-icons";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { calculateSeats } from "@/utils/organization";

import { useDashboardContext } from "../../../Contexts";

export const SeatsInfoCards = () => {
	const { activeOrganization } = useDashboardContext();
	const { paidSeats, memberCount, paidMemberCount, remainingPaidSeats } =
		calculateSeats(activeOrganization || {});

	return (
		<div className="flex flex-col flex-1 gap-6 justify-center lg:flex-row">
			<Card className="flex flex-col flex-1 gap-3 justify-center items-center">
				<div className="flex justify-center items-center p-3 rounded-full border bg-gray-4 border-gray-5">
					<FontAwesomeIcon
						className="text-gray-12 size-3.5"
						icon={faUserGroup}
					/>
				</div>
				<p className="text-gray-11">
					Total Members
					<span className="ml-2 font-medium text-gray-12">{memberCount}</span>
				</p>
			</Card>
			<Card className="flex flex-col flex-1 gap-3 justify-center items-center">
				<div className="flex justify-center items-center p-3 rounded-full border bg-gray-4 border-gray-5">
					<FontAwesomeIcon className="text-gray-12 size-3.5" icon={faCrown} />
				</div>
				<p className="text-gray-11">
					Paid Seats
					<span className="ml-2 font-medium text-gray-12">
						{paidMemberCount} / {paidSeats}
					</span>
				</p>
			</Card>
			<Card className="flex flex-col flex-1 gap-3 justify-center items-center">
				<div className="flex justify-center items-center p-3 rounded-full border bg-gray-4 border-gray-5">
					<FontAwesomeIcon className="text-gray-12 size-3.5" icon={faChair} />
				</div>
				<p className="text-gray-11">
					Available Paid Seats
					<span className="ml-2 font-medium text-gray-12">
						{remainingPaidSeats}
					</span>
				</p>
			</Card>
		</div>
	);
};
