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
import { SimplePlans } from "../text/SimplePlans";
import { LogoSection } from "./_components/LogoSection";

export const PricingPage = () => {
  const [loading, setLoading] = useState(false);
  const [isAnnual, setIsAnnual] = useState(true);
  const [quantity, setQuantity] = useState(1);
  const [initialRender, setInitialRender] = useState(true);
  const { push } = useRouter();
  const searchParams = useSearchParams();

  useEffect(() => {
    const init = async () => {
      setInitialRender(false);
      const planFromUrl = searchParams.get("plan");
      const next = searchParams.get("next");
      const pendingPriceId = localStorage.getItem("pendingPriceId");
      const pendingQuantity = localStorage.getItem("pendingQuantity");

      if (pendingPriceId && pendingQuantity) {
        localStorage.removeItem("pendingPriceId");
        localStorage.removeItem("pendingQuantity");

        const response = await fetch(`/api/settings/billing/subscribe`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            priceId: pendingPriceId,
            quantity: parseInt(pendingQuantity),
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
    setLoading(true);

    if (!planId) {
      planId = getProPlanId(isAnnual ? "yearly" : "monthly");
    }

    const response = await fetch(`/api/settings/billing/subscribe`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ priceId: planId, quantity }),
    });
    const data = await response.json();

    if (data.auth === false) {
      localStorage.setItem("pendingPriceId", planId);
      localStorage.setItem("pendingQuantity", quantity.toString());
      push(`/login?next=/pricing`);
      return;
    }

    if (data.subscription === true) {
      toast.success("You are already on the Cap Pro plan");
    }

    if (data.url) {
      window.location.href = data.url;
    }

    setLoading(false);
  };

  const proList = [
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

  const plannedFeatures = [
    {
      text: "Custom scenes (branded videos, automatic zoom)",
      available: false,
    },
    {
      text: "Video editing",
      available: false,
    },
    {
      text: "Cap AI (generated description, title, etc)",
      available: false,
    },
    {
      text: "Password protected videos",
      available: false,
    },
    {
      text: "Custom domains",
      available: false,
    },
    {
      text: "Embeddable videos",
      available: false,
    },
    {
      text: "API access",
      available: false,
    },
  ];

  return (
    <div>
      <div className="py-12 mt-16 space-y-24 wrapper">
        <div className="space-y-12">
          <div className="text-center">
            <div className={`mb-4 ${initialRender ? "fade-in-down" : ""}`}>
              <SimplePlans />
            </div>
            <h1
              className={`text-4xl md:text-5xl ${
                initialRender ? "fade-in-down" : ""}mb-6 }`}
            >
              Early Adopter Pricing
            </h1>
            <p
              className={`max-w-[800px] mx-auto ${
                initialRender ? "fade-in-down animate-delay-1" : ""}`}
            >
              Cap is currently in public beta, and we're offering special early
              adopter pricing to our first users. This pricing will be locked in
              for the lifetime of your subscription.
            </p>
          </div>
          <div>
            <div className="text-center max-w-[800px] mx-auto mb-8 lg:mb-4">
              <h2 className="text-xl text-gray-400">
                Used by employees at leading tech companies
              </h2>
            </div>
            <div className="flex flex-col items-center pb-8 text-center lg:flex-row lg:items-center lg:justify-between lg:text-left lg:pb-0">
              <div className="grid grid-cols-2 gap-10 mx-auto md:grid-cols-5 lg:max-w-4xl lg:gap-10">
                <div className="flex justify-center items-center lg:mt-0">
                  <img
                    alt="Tesla Logo"
                    loading="lazy"
                    width={100}
                    height={30}
                    decoding="async"
                    style={{ color: "transparent" }}
                    src="/logos/tesla.svg"
                  />
                </div>
                <div className="flex justify-center items-center lg:mt-0">
                  <img
                    alt="Microsoft Logo"
                    loading="lazy"
                    width={98}
                    height={24}
                    decoding="async"
                    style={{ color: "transparent" }}
                    src="/logos/microsoft.svg"
                  />
                </div>
                <div className="flex justify-center items-center lg:mt-0">
                  <img
                    alt="Coinbase Logo"
                    loading="lazy"
                    width={139}
                    height={32}
                    decoding="async"
                    style={{ color: "transparent" }}
                    src="/logos/coinbase.svg"
                  />
                </div>
                <div className="flex justify-center items-center lg:mt-0">
                  <img
                    alt="IBM Logo"
                    loading="lazy"
                    width={80}
                    height={20}
                    decoding="async"
                    style={{ color: "transparent" }}
                    src="/logos/ibm.svg"
                  />
                </div>
                <div className="flex justify-center items-center lg:mt-0">
                  <img
                    alt="Dropbox Logo"
                    loading="lazy"
                    width={115}
                    height={50}
                    decoding="async"
                    style={{ color: "transparent" }}
                    src="/logos/dropbox.svg"
                  />
                </div>
              </div>
            </div>
          </div>
          <div className="grid grid-cols-1 gap-3 items-stretch md:grid-cols-3">
            <Card
              className={`bg-gray-100 rounded-xl min-h-[600px] flex-grow ${
                initialRender ? "fade-in-down animate-delay-2" : ""}`}
            >
              <div className="space-y-4">
                <CardHeader>
                  <CardTitle className="text-2xl">
                    Cap Lite (Open Source)
                  </CardTitle>
                  <CardDescription className="text-lg">
                    For personal and minimal use.
                  </CardDescription>
                  <h3 className="text-4xl">Free</h3>
                </CardHeader>
                <CardContent>
                  <Button
                    href="/download"
                    className="w-full hover:bg-gray-200"
                    variant="white"
                    size="lg"
                  >
                    Try for Free
                  </Button>
                </CardContent>
                <CardFooter>
                  <div className="space-y-2">
                    <div className="flex items-center">
                      <div className="w-5 h-5 m-0 p-0 flex items-center border-[2px] border-gray-500 justify-center rounded-full">
                        <Check className="w-3 h-3 stroke-[4px] stroke-gray-500" />
                      </div>
                      <p className="ml-1.5 text-gray-500">
                        Core features, including:
                      </p>
                    </div>
                    <p className="pl-8">
                      Screen & Window recording, Local video export, 5 min
                      shareable links, Powerful video editor (custom background
                      gradients, transitions, etc) + many more.
                    </p>
                  </div>
                </CardFooter>
              </div>
            </Card>
            <Card
              className={`bg-blue-300 rounded-xl min-h-[600px] flex-grow border-blue-500/20 ${
                initialRender ? "fade-in-up animate-delay-2" : ""}`}
            >
              <div className="space-y-3">
                <CardHeader>
                  <CardTitle className="text-3xl text-white">Cap Pro</CardTitle>
                  <CardDescription className="text-white/80">
                    For the best Cap experience.
                  </CardDescription>
                  <div>
                    <div>
                      <h3 className="text-4xl text-white">
                        {isAnnual
                          ? `$${6 * quantity}/mo`
                          : `$${9 * quantity}/mo`}
                      </h3>
                      <div>
                        <p className="text-sm font-medium text-white/80">
                          {isAnnual
                            ? quantity === 1
                              ? "per user, billed annually."
                              : `for ${quantity} users, billed annually.`
                            : quantity === 1
                            ? "per user, billed monthly."
                            : `for ${quantity} users, billed monthly.`}
                        </p>
                        {isAnnual && (
                          <p
                            className="text-sm transition-colors cursor-pointer text-white/80 hover:text-white"
                            onClick={() => setIsAnnual(false)}
                          >
                            or, ${9 * quantity}/month,{" "}
                            {quantity === 1
                              ? "per user, "
                              : `for ${quantity} users, `}
                            billed monthly.
                          </p>
                        )}
                      </div>
                    </div>
                    <div className="flex items-center pt-2 mt-2 border-t-2 border-white/20">
                      <span className="mr-2 text-xs text-white/80">
                        Number of users:
                      </span>
                      <div className="flex gap-2 items-center">
                        <Button
                          variant="secondary"
                          size="sm"
                          onClick={() =>
                            quantity > 1 && setQuantity(quantity - 1)
                          }
                          className="px-2 py-0 h-6"
                        >
                          -
                        </Button>
                        <span className="text-white min-w-[20px] text-center">
                          {quantity}
                        </span>
                        <Button
                          variant="secondary"
                          size="sm"
                          onClick={() => setQuantity(quantity + 1)}
                          className="px-2 py-0 h-6"
                        >
                          +
                        </Button>
                      </div>
                    </div>
                    <div className="flex flex-col gap-4 pt-4 mt-2 -mb-4 border-t-2 border-white/20">
                      <div className="flex items-center">
                        <span className="mr-2 text-xs text-white/80">
                          {isAnnual
                            ? "Switch to monthly"
                            : "Switch to annually"}
                        </span>
                        <Switch
                          checked={!isAnnual}
                          onCheckedChange={() => setIsAnnual(!isAnnual)}
                        />
                      </div>
                    </div>
                  </div>
                </CardHeader>
                <CardContent>
                  <Button
                    type="button"
                    spinner={loading}
                    onClick={() => planCheckout()}
                    className="-mb-4 w-full"
                    size="lg"
                    variant="white"
                  >
                    Get Started with Pro
                  </Button>
                </CardContent>
                <CardFooter>
                  <div className="space-y-8">
                    <div>
                      <ul className="p-0 space-y-3 list-none">
                        {proList.map((item, index) => (
                          <li
                            key={index}
                            className="flex justify-start items-center"
                          >
                            <div className="w-5 h-5 m-0 p-0 flex items-center border-[2px] border-white justify-center rounded-full">
                              <Check className="w-3 h-3 stroke-[4px] stroke-white" />
                            </div>
                            <span className="ml-1.5 text-white">
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
              className={`bg-gray-900 text-white rounded-xl min-h-[600px] flex-grow ${
                initialRender ? "fade-in-down animate-delay-2" : ""}`}
            >
              <div className="space-y-4">
                <CardHeader>
                  <CardTitle className="text-3xl">Custom</CardTitle>
                  <CardDescription className="text-white/80">
                    For teams and organizations who prioritize security.
                  </CardDescription>
                </CardHeader>
                <CardContent>
                  <Button
                    href="https://cap.link/sales"
                    className="w-full"
                    variant="white"
                    size="lg"
                  >
                    Schedule a Demo
                  </Button>
                </CardContent>
                <CardFooter>
                  <div className="space-y-8">
                    <div>
                      <ul className="p-0 space-y-3 list-none">
                        <li className="flex justify-start items-center">
                          <div className="w-5 h-5 m-0 p-0 flex items-center border-[2px] border-white justify-center rounded-full">
                            <Check className="w-3 h-3 stroke-[4px] stroke-white" />
                          </div>
                          <span className="ml-1.5 text-white">
                            Everything in Pro
                          </span>
                        </li>
                        <li className="flex justify-start items-center">
                          <div className="w-5 h-5 m-0 p-0 flex items-center border-[2px] border-white justify-center rounded-full">
                            <Check className="w-3 h-3 stroke-[4px] stroke-white" />
                          </div>
                          <span className="ml-1.5 text-white">
                            Custom deployment options
                          </span>
                        </li>
                        <li className="flex justify-start items-center">
                          <div className="w-5 h-5 m-0 p-0 flex items-center border-[2px] border-white justify-center rounded-full">
                            <Check className="w-3 h-3 stroke-[4px] stroke-white" />
                          </div>
                          <span className="ml-1.5 text-white">
                            Dedicated support
                          </span>
                        </li>
                        <li className="flex justify-start items-center">
                          <div className="w-5 h-5 m-0 p-0 flex items-center border-[2px] border-white justify-center rounded-full">
                            <Check className="w-3 h-3 stroke-[4px] stroke-white" />
                          </div>
                          <span className="ml-1.5 text-white">
                            SLA guarantees
                          </span>
                        </li>
                        <li className="flex justify-start items-center">
                          <div className="w-5 h-5 m-0 p-0 flex items-center border-[2px] border-white justify-center rounded-full">
                            <Check className="w-3 h-3 stroke-[4px] stroke-white" />
                          </div>
                          <span className="ml-1.5 text-white">
                            Custom integrations
                          </span>
                        </li>
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
