import { Logo } from "@cap/ui";
import { videos } from "@cap/database/schema";

export const ShareHeader = ({ data }: { data: typeof videos.$inferSelect }) => {
  return (
    <div>
      <div>
        <div className="flex items-center space-x-1">
          <Logo className="w-[75px] h-auto" />
          <span className="text-[9px] font-medium text-gray-400">
            v{process.env.appVersion}
          </span>
        </div>
      </div>
    </div>
  );
};
