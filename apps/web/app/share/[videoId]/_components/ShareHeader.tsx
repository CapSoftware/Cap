import { Button, LogoBadge } from "@cap/ui";
import { videos } from "@cap/database/schema";
import moment from "moment";
import { userSelectProps } from "@cap/database/auth/session";
import { useRouter } from "next/navigation";

export const ShareHeader = ({
  data,
  user,
}: {
  data: typeof videos.$inferSelect;
  user: typeof userSelectProps | null;
}) => {
  const { push } = useRouter();

  return (
    <div>
      <div className="md:flex md:items-center md:justify-between space-x-0 md:space-x-6">
        <div className="flex items-center md:justify-between space-x-6">
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
        {user !== null && (
          <div className="hidden md:flex">
            <Button
              onClick={() => {
                push(`${process.env.NEXT_PUBLIC_URL}/dashboard`);
              }}
            >
              Go to Dashboard
            </Button>
          </div>
        )}
      </div>
    </div>
  );
};
