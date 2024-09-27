import { useEffect, useState } from "react";
import Link from "next/link";
import { sub } from "date-fns";

export const UsageButton = () => {
  const [usage, setUsage] = useState({
    videoCount: 0,
    videoLimit: 25,
    loading: true,
    subscription: false,
  });

  useEffect(() => {
    fetch("/api/settings/billing/usage")
      .then((response) => response.json())
      .then((data) => {
        setUsage({
          videoCount: data.videoCount,
          videoLimit: data.videoLimit,
          loading: false,
          subscription: data.subscription,
        });
      });
  }, []);

  const progress = (3 / usage.videoLimit) * 100;

  if (usage.loading === true) {
    return (
      <div className="w-full h-12 bg-gray-200 rounded-xl py-2 px-4 animate-pulse"></div>
    );
  }

  return (
    <Link
      href={
        usage.subscription === false
          ? "/pricing"
          : "/dashboard/settings/billing"
      }
    >
      <div className="w-full flex flex-col items-start justify-center bg-white border border-gray-200 rounded-xl py-2 px-4 hover:border-blue-500 transition-all">
        {usage.subscription === false ? (
          <>
            <div className="mb-1 font-medium text-gray-500 text-[0.875rem]">
              {3}/{usage.videoLimit} Caps
            </div>
            <div className="h-[10px] w-full bg-gray-200 rounded-xl overflow-hidden">
              <div
                className="h-[10px] bg-blue-500"
                style={{ width: `${progress}%` }}
              ></div>
            </div>
            <div className="w-full mt-4 pt-2 border-t border-gray-200">
              <span className="text-sm">
                Upgrade to{" "}
                <span className="bg-blue-500 text-sm text-white py-1 px-1.5 rounded-[8px]">
                  Pro
                </span>{" "}
                plan
              </span>
            </div>
          </>
        ) : (
          <div className="text-primary font-medium tracking-tighter">
            Cap Pro
          </div>
        )}
      </div>
    </Link>
  );
};
