"use client";

import { useSharedContext } from "@/app/dashboard/_components/DynamicSharedLayout";
import { Card } from "@cap/ui";
import { faChair, faUserGroup } from "@fortawesome/free-solid-svg-icons";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";

export const SeatsInfoCards = () => {
  const { activeOrganization } = useSharedContext();

  return (
    <div className="flex flex-col flex-1 gap-6 justify-center lg:flex-row">
      <Card className="flex flex-col flex-1 gap-3 justify-center items-center">
        <FontAwesomeIcon className="text-gray-10 size-5" icon={faChair} />
        <p className="text-gray-12">
          Seats Remaining
          <span className="ml-2 font-bold text-gray-12">
            {(activeOrganization?.inviteQuota ?? 1) -
              (activeOrganization?.totalInvites ?? 0)}
          </span>
        </p>
      </Card>
      <Card className="flex flex-col flex-1 gap-3 justify-center items-center">
        <FontAwesomeIcon className="text-gray-10 size-5" icon={faUserGroup} />
        <p className="text-gray-12">
          Seats Capacity
          <span className="ml-2 font-bold text-gray-12">
            {activeOrganization?.inviteQuota}
          </span>
        </p>
      </Card>
    </div>
  );
};
