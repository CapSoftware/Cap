import { LogoBadge } from "@cap/ui";
import { videos } from "@cap/database/schema";
import moment from "moment";

export const ShareHeader = ({ data }: { data: typeof videos.$inferSelect }) => {
  return (
    <div>
      <div className="flex items-center space-x-6">
        <div>
          <a
            href={`${process.env.NEXT_PUBLIC_URL}?referrer=${data.id}`}
            target="_blank"
          >
            <LogoBadge className="w-8 h-auto" />
          </a>
        </div>
        <div>
          <h1 className="text-2xl">{data.name}</h1>
          <p className="text-gray-400 text-sm">
            {moment(data.createdAt).fromNow()}
          </p>
        </div>
      </div>
    </div>
  );
};
