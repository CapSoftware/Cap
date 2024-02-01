import { LogoBadge } from "@cap/ui";
import moment from "moment";

export const ShareHeader = ({
  title,
  createdAt,
}: {
  title: string;
  createdAt: Date;
}) => {
  return (
    <div className="flex items-center space-x-5">
      <LogoBadge className="w-8 h-auto" />
      <div>
        <h1 className="text-2xl">{title}</h1>
        <p className="text-gray-400">{moment(createdAt).fromNow()}</p>
      </div>
    </div>
  );
};
