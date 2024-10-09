import Link from "next/link";

export const UsageButton = ({ subscribed }: { subscribed: boolean }) => {
  return (
    <Link href={subscribed ? "/dashboard/settings/workspace" : "/pricing"}>
      <div className="w-full flex items-center justify-center bg-white border border-gray-200 rounded-xl py-2 px-4 hover:border-blue-500 transition-all">
        {subscribed ? (
          <div className="text-primary font-medium tracking-tighter">
            Cap Pro
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
};
