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

  const progress = (usage.videoCount / usage.videoLimit) * 100;

  if (usage.loading === true) {
    return (
      <div className="w-[130px] h-12 bg-gray-200 rounded-xl py-2 px-4 animate-pulse"></div>
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
      <div className="w-[130px] flex flex-col items-center justify-center h-12 bg-tertiary-3 rounded-xl py-2 px-4 hover:bg-tertiary transition-all">
        {usage.subscription === false ? (
          <>
            <div className="mb-1 text-primary font-medium tracking-tighter">
              {usage.videoCount}/{usage.videoLimit} caps
            </div>
            <div className="h-[7px] max-w-[100px] w-full bg-white rounded-xl overflow-hidden">
              <div
                className="h-[7px] bg-primary"
                style={{ width: `${progress}%` }}
              ></div>
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
