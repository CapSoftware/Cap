import { useEffect, useState } from "react";
import Link from "next/link";

export const UsageButton = () => {
  const [isSubscribed, setIsSubscribed] = useState(false);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    fetch("/api/settings/billing/subscription")
      .then((response) => response.json())
      .then((data) => {
        setIsSubscribed(data.subscription);
        setIsLoading(false);
      });
  }, []);

  if (isLoading) {
    return (
      <div className="w-full h-12 bg-gray-200 rounded-xl py-2 px-4 animate-pulse"></div>
    );
  }

  return (
    <Link href={isSubscribed ? "/dashboard/settings/billing" : "/pricing"}>
      <div className="w-full flex items-center justify-center bg-white border border-gray-200 rounded-xl py-2 px-4 hover:border-blue-500 transition-all">
        {isSubscribed ? (
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
