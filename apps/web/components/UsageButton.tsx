import { useSharedContext } from "@/app/dashboard/_components/DynamicSharedLayout";
import Link from "next/link";

export const UsageButton = () => {
  const { isCapCloud, isSubscribed, isSuperAdmin } = useSharedContext();

  if (isCapCloud) {
    return (
      <Link href={"/dashboard/settings/workspace"}>
        <div className="w-full flex items-center justify-center bg-white border border-gray-200 rounded-xl py-2 px-4 hover:border-blue-500 transition-all">
          {isSubscribed ? (
            <div className="text-primary font-medium tracking-tighter">
              Cap{" "}
              <span className="bg-blue-500 text-sm text-white py-1 px-1.5 rounded-[8px]">
                Pro
              </span>
            </div>
          ) : (
            <span className="text-sm">
              Upgrade to{" "}
              <span className="bg-blue-500 text-sm text-white py-1 px-1.5 rounded-[8px]">
                Pro
              </span>{" "}
              plan
            </span>
          )}
        </div>
      </Link>
    );
  }

  return isSuperAdmin ? (
    <Link
      href={
        isSubscribed
          ? "/dashboard/admin/server-config"
          : "/pricing?deploy=selfhosted"
      }
    >
      <div className="w-full flex items-center justify-center bg-white border border-gray-200 rounded-xl py-2 px-4 hover:border-blue-500 transition-all">
        {isSubscribed ? (
          <div className="text-primary font-medium tracking-tighter">
            Cap{" "}
            <span className="bg-blue-500 text-sm text-white py-1 px-1.5 rounded-[8px]">
              Pro
            </span>{" "}
            Self-Hosted
          </div>
        ) : (
          <span className="text-sm">
            Upgrade to{" "}
            <span className="bg-blue-500 text-sm text-white py-1 px-1.5 rounded-[8px]">
              Pro
            </span>{" "}
            self-hosted
          </span>
        )}
      </div>
    </Link>
  ) : (
    <Link href={"/pricing"}>
      <div className="w-full flex items-center justify-center bg-white border border-gray-200 rounded-xl py-2 px-4 hover:border-blue-500 transition-all">
        {isSubscribed ? (
          <div className="text-primary font-medium tracking-tighter">
            Cap{" "}
            <span className="bg-blue-500 text-sm text-white py-1 px-1.5 rounded-[8px]">
              Pro
            </span>{" "}
            Self-Hosted
          </div>
        ) : (
          <span className="text-sm">
            Ask your admin to upgrade to{" "}
            <span className="bg-blue-500 text-sm text-white py-1 px-1.5 rounded-[8px]">
              Pro
            </span>
          </span>
        )}
      </div>
    </Link>
  );
};
