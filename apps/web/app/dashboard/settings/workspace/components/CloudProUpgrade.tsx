"use client";

import {
  Button,
  LogoBadge,
  Card,
  CardDescription,
  CardTitle,
  CardHeader,
  CardContent,
  CardFooter,
  Switch,
} from "@cap/ui";
import { Check, Construction } from "lucide-react";
import { useState, useEffect } from "react";
import { getProPlanId } from "@cap/utils";
import toast from "react-hot-toast";
import { useRouter, useSearchParams } from "next/navigation";
import { parseAsBoolean, parseAsInteger, useQueryState } from "nuqs";
import { pricingPerUser, proPlanFeatureList } from "@/components/pages/consts";
import { useSharedContext } from "@/app/dashboard/_components/DynamicSharedLayout";

export const CloudProUpgrade = ({
  workspaceUserCount,
}: {
  workspaceUserCount: number;
}) => {
  const [proLoading, setProLoading] = useState(false);
  const [isAnnual, setIsAnnual] = useQueryState(
    "proAnnual",
    parseAsBoolean.withDefault(true)
  );
  const [initialRender, setInitialRender] = useState(true);

  const { activeSpace, isCapCloud } = useSharedContext();

  const spaceName = activeSpace?.space.name;

  useEffect(() => {
    const init = async () => {
      setInitialRender(false);
    };

    init();
  }, []);

  const planCheckout = async (planId?: string) => {
    setProLoading(true);

    if (!planId) {
      planId = getProPlanId(isAnnual ? "yearly" : "monthly");
    }

    const response = await fetch(`/api/settings/billing/subscribe`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        priceId: planId,
        spaceId: activeSpace?.space.id,
      }),
    });
    const data = await response.json();

    if (data.subscription === true) {
      toast.success("You are already on the Cap Pro plan");
    }

    if (data.url) {
      window.location.href = data.url;
    }

    setProLoading(false);
  };

  if (!isCapCloud) {
    return null;
  }

  return (
    <div className="flex flex-col gap-4">
      <p className="text-xs">
        Cap is currently in public beta, and we're offering special early
        adopter pricing to our first users. This pricing will be locked in for
        the lifetime of your subscription.
      </p>

      <Card
        className={`bg-gray-50 rounded-xl flex-grow border-blue-500 border-2 w-fit ${
          initialRender ? "fade-in-up animate-delay-2" : ""
        }`}
      >
        <div className="">
          <CardHeader>
            <CardTitle className="text-2xl  font-medium">
              App + Commercial License +{" "}
              <span className="text-blue-500 text-2xl font-bold">Cap Pro</span>
            </CardTitle>
            <CardDescription className="text-lg">
              For professional use + cloud features like shareable links,
              transcriptions, comments, & more. Perfect for teams or sharing
              with clients.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <div className="w-full flex flex-col gap-4">
              <div className="flex flex-row items-center justify-between">
                <h3 className="text-4xl">
                  {isAnnual
                    ? `$${
                        pricingPerUser.cloud.annually * workspaceUserCount
                      }/mo`
                    : `$${
                        pricingPerUser.cloud.monthly * workspaceUserCount
                      }/mo`}
                </h3>

                <div className="flex items-center gap-2">
                  <span className="text-xs">Annual</span>
                  <Switch
                    checked={!isAnnual}
                    onCheckedChange={() => setIsAnnual(!isAnnual)}
                  />
                  <span className="text-xs">Monthly</span>
                </div>
              </div>
              <div>
                <p className="text-sm font-medium">
                  {isAnnual
                    ? `$${pricingPerUser.cloud.annually}/mo per user${
                        workspaceUserCount === 1 ? "" : "s"
                      }, billed annually at $${
                        pricingPerUser.cloud.annually * workspaceUserCount * 12
                      }/year.`
                    : `$${pricingPerUser.cloud.monthly}/mo per user${
                        workspaceUserCount === 1 ? "" : "s"
                      }, billed monthly at $${
                        pricingPerUser.cloud.monthly * workspaceUserCount
                      }/mo.`}
                </p>
              </div>

              <Button
                variant="primary"
                onClick={() => planCheckout()}
                className="w-full mt-2"
                size="lg"
                disabled={proLoading}
              >
                {proLoading ? "Loading..." : `Upgrade ${spaceName} to Cap Pro`}
              </Button>

              <ul className="grid grid-cols-1 md:grid-cols-2 gap-4 list-none mt-4">
                {proPlanFeatureList.map((item, index) => (
                  <li key={index} className="flex justify-start items-center">
                    <div className="w-5 h-5 m-0 p-0 flex items-center border-[2px] border-green-500 justify-center rounded-full">
                      <Check className="w-3 h-3 stroke-[4px] stroke-green-500" />
                    </div>
                    <span className="ml-1.5 text-gray-500 font-bold">
                      {item.text}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          </CardContent>
        </div>
      </Card>
    </div>
  );
};
