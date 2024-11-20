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

export const PricingPage = () => {
  const [loading, setLoading] = useState(false);
  const [isAnnual, setIsAnnual] = useState(true);
  const [initialRender, setInitialRender] = useState(true);
  const { push } = useRouter();
  const searchParams = useSearchParams();

  useEffect(() => {
    setInitialRender(false);
    const planFromUrl = searchParams.get("plan");
    if (planFromUrl) {
      planCheckout(planFromUrl);
    }
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
      body: JSON.stringify({ priceId: planId }),
    });
    const data = await response.json();

    if (data.auth === false) {
      localStorage.setItem("pendingPriceId", planId);
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
      <div className="wrapper py-20 space-y-24">
        <div className="space-y-12">
          <div className="text-center">
            <div className={`mb-4 ${initialRender ? "fade-in-down" : ""}`}>
              <SimplePlans />
            </div>
            <h1
              className={`text-4xl md:text-5xl ${
                initialRender ? "fade-in-down" : ""
              } mb-6`}
            >
              Early Adopter Pricing
            </h1>
            <p
              className={`max-w-[800px] mx-auto ${
                initialRender ? "fade-in-down animate-delay-1" : ""
              }`}
            >
              Cap is currently in public beta, and we're offering special early
              adopter pricing to our first users. This pricing will be locked in
              for the lifetime of your subscription.
            </p>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-3 items-stretch">
            <Card
              className={`bg-gray-100 rounded-xl min-h-[600px] flex-grow ${
                initialRender ? "fade-in-down animate-delay-2" : ""
              }`}
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
                      Screen & Window recording, Local video export, Powerful
                      video editor (custom background gradients, transitions,
                      etc) + many more.
                    </p>
                  </div>
                </CardFooter>
              </div>
            </Card>
            <Card
              className={`bg-blue-300 rounded-xl min-h-[600px] flex-grow border-blue-500/20 ${
                initialRender ? "fade-in-up animate-delay-2" : ""
              }`}
            >
              <div className="space-y-3">
                <CardHeader>
                  <CardTitle className="text-3xl text-white">Cap Pro</CardTitle>
                  <CardDescription className="text-white/80">
                    For professional use and teams.
                  </CardDescription>
                  <div>
                    <div>
                      <h3 className="text-4xl text-white">
                        {isAnnual ? "$6/mo" : "$9/mo"}
                      </h3>
                      <div>
                        <p className="text-sm font-medium text-white/80">
                          {isAnnual
                            ? "per user, billed annually."
                            : "per user, billed monthly."}
                        </p>
                        {isAnnual && (
                          <p className="text-sm text-white/80">
                            or, $9/month, billed monthly.
                          </p>
                        )}
                      </div>
                    </div>
                    <div className="flex items-center mt-4 -mb-3 pt-4 border-t-2 border-white/20">
                      <span className="text-xs text-white/80 mr-2">
                        {isAnnual ? "Switch to monthly" : "Switch to annually"}
                      </span>
                      <Switch
                        checked={!isAnnual}
                        onCheckedChange={() => setIsAnnual(!isAnnual)}
                      />
                    </div>
                  </div>
                </CardHeader>
                <CardContent>
                  <Button
                    type="button"
                    spinner={loading}
                    onClick={() => planCheckout()}
                    className="w-full"
                    size="lg"
                    variant="white"
                  >
                    Get Started with Pro
                  </Button>
                </CardContent>
                <CardFooter>
                  <div className="space-y-8">
                    <div>
                      <ul className="list-none p-0 space-y-3">
                        {proList.map((item, index) => (
                          <li
                            key={index}
                            className="flex items-center justify-start"
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
                initialRender ? "fade-in-down animate-delay-2" : ""
              }`}
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
                      <ul className="list-none p-0 space-y-3">
                        <li className="flex items-center justify-start">
                          <div className="w-5 h-5 m-0 p-0 flex items-center border-[2px] border-white justify-center rounded-full">
                            <Check className="w-3 h-3 stroke-[4px] stroke-white" />
                          </div>
                          <span className="ml-1.5 text-white">
                            Everything in Pro
                          </span>
                        </li>
                        <li className="flex items-center justify-start">
                          <div className="w-5 h-5 m-0 p-0 flex items-center border-[2px] border-white justify-center rounded-full">
                            <Check className="w-3 h-3 stroke-[4px] stroke-white" />
                          </div>
                          <span className="ml-1.5 text-white">
                            Custom deployment options
                          </span>
                        </li>
                        <li className="flex items-center justify-start">
                          <div className="w-5 h-5 m-0 p-0 flex items-center border-[2px] border-white justify-center rounded-full">
                            <Check className="w-3 h-3 stroke-[4px] stroke-white" />
                          </div>
                          <span className="ml-1.5 text-white">
                            Dedicated support
                          </span>
                        </li>
                        <li className="flex items-center justify-start">
                          <div className="w-5 h-5 m-0 p-0 flex items-center border-[2px] border-white justify-center rounded-full">
                            <Check className="w-3 h-3 stroke-[4px] stroke-white" />
                          </div>
                          <span className="ml-1.5 text-white">
                            SLA guarantees
                          </span>
                        </li>
                        <li className="flex items-center justify-start">
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
            className="w-full mx-auto h-auto"
            src="/illustrations/comparison.png"
            alt="Cap vs Competitors Table"
          />
        </div>
      </div>
    </div>
  );
};
