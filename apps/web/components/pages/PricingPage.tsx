"use client";

import {
  Button,
  Card,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
  Switch,
} from "@cap/ui";
import { getProPlanId } from "@cap/utils";
import clsx from "clsx";
import { Check } from "lucide-react";
import { useRouter, useSearchParams } from "next/navigation";
import { useEffect, useState } from "react";
import toast from "react-hot-toast";
import { SimplePlans } from "../text/SimplePlans";

const QuantityButton = ({
  onClick,
  children,
}: {
  onClick: () => void;
  children: React.ReactNode;
}) => {
  return (
    <button
      onClick={onClick}
      className="flex justify-center items-center px-2 py-0 w-6 h-6 bg-gray-200 rounded-md hover:bg-gray-300 focus:outline-none focus:ring-2 focus:ring-gray-400"
    >
      {children}
    </button>
  );
};

export const PricingPage = () => {
  const [proLoading, setProLoading] = useState(false);
  const [commercialLoading, setCommercialLoading] = useState(false);
  const [isAnnual, setIsAnnual] = useState(true);
  const [isCommercialAnnual, setIsCommercialAnnual] = useState(false);
  const [proQuantity, setProQuantity] = useState(1);
  const [licenseQuantity, setLicenseQuantity] = useState(1);
  const [initialRender, setInitialRender] = useState(true);
  const { push } = useRouter();
  const searchParams = useSearchParams();

  const faqContent = [
    {
      title: "Can I self-host Cap for free?",
      answer:
        "Yes, you can self-host Cap for free, for personal use. However, if you want to use Cap for commercial purposes, you will need to purchase a self-hosted license.",
    },
    {
      title: "How much does a self-hosted license cost?",
      answer:
        "A self-hosted license costs $9/month, per user, with a minimum of 10 users.",
    },
    {
      title: "What happens after the beta period ends?",
      answer:
        "Early adopters will keep their special pricing for the lifetime of their subscription, even after we move out of beta and adjust our regular pricing.",
    },
  ];

  useEffect(() => {
    const init = async () => {
      setInitialRender(false);
      const planFromUrl = searchParams.get("plan");
      const next = searchParams.get("next");
      const pendingPriceId = localStorage.getItem("pendingPriceId");
      const pendingProQuantity = localStorage.getItem("pendingQuantity");

      if (pendingPriceId && pendingProQuantity) {
        localStorage.removeItem("pendingPriceId");
        localStorage.removeItem("pendingQuantity");

        const response = await fetch(`/api/settings/billing/subscribe`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            priceId: pendingPriceId,
            quantity: parseInt(pendingProQuantity),
          }),
        });
        const data = await response.json();

        if (data.url) {
          window.location.href = data.url;
        }
      } else if (planFromUrl) {
        planCheckout(planFromUrl);
      }
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
      body: JSON.stringify({ priceId: planId, quantity: proQuantity }),
    });
    const data = await response.json();

    if (data.auth === false) {
      localStorage.setItem("pendingPriceId", planId);
      localStorage.setItem("pendingQuantity", proQuantity.toString());
      push(`/login?next=/pricing`);
      return;
    }

    if (data.subscription === true) {
      toast.success("You are already on the Cap Pro plan");
    }

    if (data.url) {
      window.location.href = data.url;
    }

    setProLoading(false);
  };

  const openCommercialCheckout = async () => {
    setCommercialLoading(true);
    try {
      const response = await fetch(`/api/commercial/checkout`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          type: isCommercialAnnual ? "yearly" : "lifetime",
          quantity: licenseQuantity,
        }),
      });

      const data = await response.json();

      if (response.status === 200) {
        window.location.href = data.url;
      } else {
        throw new Error(data.message);
      }
    } catch (error) {
      console.error("Error during commercial checkout:", error);
      toast.error("Failed to start checkout process");
    } finally {
      setCommercialLoading(false);
    }
  };

  const proList = [
    {
      text: "Connect your own domain to Cap",
      available: true,
    },
    {
      text: "Unlimited cloud storage & Shareable links",
      available: true,
    },
    {
      text: "Connect custom S3 storage bucket",
      available: true,
    },
    {
      text: "Desktop app commercial license included",
      available: true,
    },
    {
      text: "Advanced teams features",
      available: true,
    },
    {
      text: "Unlimited views",
      available: true,
    },
    {
      text: "Password protected videos",
      available: true,
    },
    {
      text: "Advanced analytics",
      available: true,
    },
    {
      text: "Priority support",
      available: true,
    },
  ];

  const commercialList = [
    {
      text: "Commercial Use of Cap Recorder + Editor",
      available: true,
    },
    {
      text: "Community Support",
      available: true,
    },
    {
      text: "Local-only features",
      available: true,
    },
    {
      text: "Perpetual license option",
      available: true,
    },
  ];

  return (
    <div>
      <div className="py-12 mt-16 space-y-24 wrapper">
        <div>
          <div className="text-center">
            <div className={`mb-4 ${initialRender ? "fade-in-down" : ""}`}>
              <SimplePlans />
            </div>
            <h1
              className={clsx("text-4xl md:text-5xl", {
                "fade-in-down animate-delay-1": initialRender,
              })}
            >
              Early Adopter Pricing
            </h1>
            <p
              className={clsx("mx-auto mb-8 max-w-[800px]", {
                "fade-in-down animate-delay-1": initialRender,
              })}
            >
              Cap is currently in public beta, and we're offering special early
              adopter pricing to our first users. This pricing will be locked in
              for the lifetime of your subscription.
            </p>
          </div>

          <div className="grid grid-cols-1 gap-3 items-stretch md:grid-cols-2">
            <Card
              className={`bg-gray-1 rounded-xl min-h-[600px] flex-grow ${
                initialRender ? "fade-in-down animate-delay-2" : ""
              }`}
            >
              <div className="space-y-4">
                <CardHeader>
                  <CardTitle className="text-2xl">
                    App + Commercial License
                  </CardTitle>
                  <CardDescription className="text-lg">
                    For professional use of the desktop app, without cloud
                    features.
                  </CardDescription>
                  <div>
                    <div className="flex items-center space-x-3">
                      <h3 className="text-4xl">
                        {isCommercialAnnual
                          ? `$${29 * licenseQuantity}`
                          : `$${58 * licenseQuantity}`}
                      </h3>
                      <div>
                        <p className="text-sm font-medium">
                          {isCommercialAnnual
                            ? licenseQuantity === 1
                              ? "billed annually"
                              : `for ${licenseQuantity} licenses, billed annually`
                            : licenseQuantity === 1
                            ? "one-time payment"
                            : `for ${licenseQuantity} licenses, one-time payment`}
                        </p>
                        {isCommercialAnnual && (
                          <p className="text-sm">
                            or, ${58 * licenseQuantity} one-time payment
                          </p>
                        )}
                      </div>
                    </div>
                    <div className="flex justify-between items-center pt-4 mt-2 border-t border-gray-200">
                      <div className="flex items-center">
                        <span className="mr-2 text-xs">
                          Switch to {isCommercialAnnual ? "lifetime" : "yearly"}
                        </span>
                        <Switch
                          checked={!isCommercialAnnual}
                          onCheckedChange={() =>
                            setIsCommercialAnnual(!isCommercialAnnual)
                          }
                        />
                      </div>
                      <div className="flex items-center">
                        <span className="mr-2 text-xs">Licenses:</span>
                        <div className="flex gap-2 items-center">
                          <QuantityButton
                            onClick={() =>
                              licenseQuantity > 1 &&
                              setLicenseQuantity(licenseQuantity - 1)
                            }
                          >
                            -
                          </QuantityButton>
                          <span className="w-4 text-center">
                            {licenseQuantity}
                          </span>
                          <QuantityButton
                            onClick={() =>
                              setLicenseQuantity(licenseQuantity + 1)
                            }
                          >
                            +
                          </QuantityButton>
                        </div>
                      </div>
                    </div>
                  </div>
                </CardHeader>
                <Card className="bg-transparent border-0">
                  <Button
                    onClick={openCommercialCheckout}
                    className="w-full"
                    size="lg"
                    disabled={commercialLoading}
                  >
                    {commercialLoading
                      ? "Loading..."
                      : licenseQuantity > 1
                      ? "Purchase Licenses"
                      : "Purchase License"}
                  </Button>
                </Card>
                <CardFooter>
                  <div className="space-y-8">
                    <div>
                      <ul className="p-0 space-y-3 list-none">
                        {commercialList.map((item, index) => (
                          <li
                            key={index}
                            className="flex justify-start items-center"
                          >
                            <div className="w-5 h-5 m-0 p-0 flex items-center border-[2px] border-green-500 justify-center rounded-full">
                              <Check className="w-3 h-3 stroke-[4px] stroke-green-500" />
                            </div>
                            <span className="ml-1.5 font-bold text-gray-12">
                              {item.text}
                            </span>
                          </li>
                        ))}
                      </ul>
                    </div>
                  </div>
                </CardFooter>
              </div>
            </Card>

            <Card
              className={`bg-gray-1 rounded-xl min-h-[600px] flex-grow border-blue-500 border-4 ${
                initialRender ? "fade-in-up animate-delay-2" : ""
              }`}
            >
              <div className="space-y-3">
                <CardHeader>
                  <CardTitle className="text-2xl font-medium">
                    App + Commercial License +{" "}
                    <span className="text-2xl font-bold text-blue-500">
                      Cap Pro
                    </span>
                  </CardTitle>
                  <CardDescription className="text-lg">
                    For professional use + cloud features like shareable links,
                    transcriptions, comments, & more. Perfect for teams or
                    sharing with clients.
                  </CardDescription>
                  <div>
                    <div className="flex items-center space-x-3">
                      <h3 className="text-4xl">
                        {isAnnual
                          ? `$${6 * proQuantity}/mo`
                          : `$${9 * proQuantity}/mo`}
                      </h3>
                      <div>
                        <p className="text-sm font-medium">
                          {isAnnual
                            ? proQuantity === 1
                              ? "per user, billed annually."
                              : `for ${proQuantity} users, billed annually.`
                            : proQuantity === 1
                            ? "per user, billed monthly."
                            : `for ${proQuantity} users, billed monthly.`}
                        </p>
                        {isAnnual && (
                          <p className="text-sm">
                            or, ${9 * proQuantity}/month,{" "}
                            {proQuantity === 1
                              ? "per user, "
                              : `for ${proQuantity} users, `}
                            billed monthly.
                          </p>
                        )}
                      </div>
                    </div>
                    <div className="flex justify-between items-center pt-4 mt-2 border-t border-gray-200">
                      <div className="flex items-center">
                        <span className="mr-2 text-xs">
                          Switch to {isAnnual ? "monthly" : "annually"}
                        </span>
                        <Switch
                          checked={!isAnnual}
                          onCheckedChange={() => setIsAnnual(!isAnnual)}
                        />
                      </div>
                      <div className="flex items-center">
                        <span className="mr-2 text-xs">Users:</span>
                        <div className="flex gap-2 items-center">
                          <QuantityButton
                            onClick={() =>
                              proQuantity > 1 && setProQuantity(proQuantity - 1)
                            }
                          >
                            -
                          </QuantityButton>
                          <span className="w-4 text-center">{proQuantity}</span>
                          <QuantityButton
                            onClick={() => setProQuantity(proQuantity + 1)}
                          >
                            +
                          </QuantityButton>
                        </div>
                      </div>
                    </div>
                  </div>
                </CardHeader>
                <Card className="bg-transparent border-0">
                  <Button
                    variant="primary"
                    onClick={() => planCheckout()}
                    className="w-full"
                    size="lg"
                    disabled={proLoading}
                  >
                    {proLoading ? "Loading..." : "Upgrade to Cap Pro"}
                  </Button>
                </Card>
                <CardFooter>
                  <div className="space-y-8">
                    <div>
                      <ul className="p-0 space-y-3 list-none">
                        {proList.map((item, index) => (
                          <li
                            key={index}
                            className="flex justify-start items-center"
                          >
                            <div className="w-5 h-5 m-0 p-0 flex items-center border-[2px] border-green-500 justify-center rounded-full">
                              <Check className="w-3 h-3 stroke-[4px] stroke-green-500" />
                            </div>
                            <span className="ml-1.5 font-bold text-gray-12">
                              {item.text}
                            </span>
                          </li>
                        ))}
                      </ul>
                    </div>
                  </div>
                </CardFooter>
              </div>
            </Card>
          </div>
        </div>
        <div>
          <img
            className="mx-auto w-full h-auto"
            src="/illustrations/comparison.png"
            alt="Cap vs Competitors Table"
          />
        </div>
      </div>
    </div>
  );
};
