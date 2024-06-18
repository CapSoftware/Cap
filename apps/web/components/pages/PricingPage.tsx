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
} from "@cap/ui";
import { Check, Construction } from "lucide-react";
import { useState } from "react";
import { getProPlanId } from "@cap/utils";
import toast from "react-hot-toast";
import { useRouter } from "next/navigation";

export const PricingPage = () => {
  const [loading, setLoading] = useState(false);
  const { push } = useRouter();

  const planCheckout = async () => {
    setLoading(true);

    const planId = getProPlanId();

    setLoading(true);
    const response = await fetch(`/api/settings/billing/subscribe`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ priceId: planId }),
    });
    const data = await response.json();

    console.log(data);

    if (data.auth === false) {
      push("/login");
    }

    if (data.subscription === true) {
      toast.success("You are already on the Cap Pro plan");
    }

    if (data.url) {
      window.location.href = data.url;
    }

    setLoading(false);
  };

  const freeList = [
    {
      text: "Up to 25 videos",
      available: true,
    },
    {
      text: "Up to 5 mins/video",
      available: true,
    },
    {
      text: "Unlimited views",
      available: true,
    },
    {
      text: "Automatic audio transcriptions",
      available: true,
    },
    {
      text: "Basic analytics",
      available: true,
    },
    {
      text: "Community support via Discord",
      available: true,
    },
  ];

  const proList = [
    {
      text: "Unlimited videos",
      available: true,
    },
    {
      text: "Unlimited recording length",
      available: true,
    },
    {
      text: "Unlimited views",
      available: true,
    },
    {
      text: "Automatic audio transcriptions",
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
    <div className="custom-bg wrapper wrapper-sm py-20">
      <div className="space-y-12">
        <div className="text-center">
          <h1
            className={`text-4xl md:text-5xl ${
              loading === false && "fade-in-down"
            } mb-6`}
          >
            Early Adopter Pricing
          </h1>
          <p
            className={`text-lg text-gray-600 max-w-md mx-auto ${
              loading === false && "fade-in-down animate-delay-1"
            }`}
          >
            Cap is currently in public beta, and we're offering special early
            adopter pricing to our first users. This pricing will be locked in
            for the lifetime of your subscription.
          </p>
        </div>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4 items-stretch">
          <Card
            className={`bg-gradient-to-l from-primary to-primary-3 p-3 md:p-8 rounded-xl min-h-[600px] flex-grow border-primary-3 ${
              loading === false && "fade-in-up animate-delay-2"
            }`}
          >
            <div className="space-y-4">
              <CardHeader>
                <CardTitle className="text-3xl text-white">Cap Pro</CardTitle>
                <CardDescription className="text-lg text-white">
                  For professional use and teams
                </CardDescription>
                <h3 className="text-3xl text-white">$9/mo</h3>
              </CardHeader>
              <CardContent>
                <Button
                  type="button"
                  spinner={loading}
                  onClick={() => planCheckout()}
                  className="w-full bg-secondary-2 hover:bg-secondary-3"
                  size="lg"
                  variant="outline"
                >
                  <span className="text-white">Get started with Pro</span>
                </Button>
              </CardContent>
              <CardFooter>
                <div className="space-y-8">
                  <div>
                    <h3 className="text-base text-white mb-3">
                      What's included:
                    </h3>
                    <ul className="list-none p-0 space-y-3">
                      {proList.map((item, index) => (
                        <li
                          key={index}
                          className="flex items-center justify-start"
                        >
                          <div className="w-6 h-6 bg-white m-0 p-0 flex items-center justify-center rounded-full">
                            {item.available ? (
                              <Check className="w-4 h-4 text-black" />
                            ) : (
                              <Construction className="w-4 h-4 text-black" />
                            )}
                          </div>
                          <span className="ml-4 text-lg text-white">
                            {item.text}
                          </span>
                        </li>
                      ))}
                    </ul>
                  </div>
                  <div>
                    <h3 className="text-base text-white mb-3">Coming soon:</h3>
                    <ul className="list-none p-0 space-y-3 mb-6">
                      {plannedFeatures.map((item, index) => (
                        <li
                          key={index}
                          className="flex items-center justify-start"
                        >
                          <div className="w-6 h-6 bg-white m-0 p-0 flex items-center justify-center rounded-full">
                            {item.available ? (
                              <Check className="w-4 h-4 text-black" />
                            ) : (
                              <Construction className="w-4 h-4 text-black" />
                            )}
                          </div>
                          <span className="ml-4 text-lg text-white">
                            {item.text}
                          </span>
                        </li>
                      ))}
                    </ul>
                    <p className="text-white italic">
                      View the full Cap Roadmap{" "}
                      <a
                        href="/roadmap"
                        className="underline font-medium text-white"
                      >
                        here
                      </a>
                    </p>
                  </div>
                </div>
              </CardFooter>
            </div>
          </Card>
          <Card
            className={`bg-white p-3 md:p-8 rounded-xl min-h-[600px] flex-grow ${
              loading === false && "fade-in-down animate-delay-2"
            }`}
          >
            <div className="space-y-4">
              <CardHeader>
                <CardTitle className="text-2xl">Cap Lite</CardTitle>
                <CardDescription className="text-lg">
                  For personal and minimal use
                </CardDescription>
                <h3 className="text-3xl">$0</h3>
              </CardHeader>
              <CardContent>
                <Button
                  href="/login"
                  className="w-full hover:bg-gray-100"
                  variant="outline"
                >
                  Get started for free
                </Button>
              </CardContent>
              <CardFooter>
                <div>
                  <h3 className="text-base text-gray-600 mb-3">
                    What's included:
                  </h3>
                  <ul className="list-none p-0 space-y-3">
                    {freeList.map((item, index) => (
                      <li
                        key={index}
                        className="flex items-center justify-start"
                      >
                        <div className="w-6 h-6 bg-black m-0 p-0 flex items-center justify-center rounded-full">
                          {item.available ? (
                            <Check className="w-4 h-4 text-white" />
                          ) : (
                            <Construction className="w-4 h-4 text-white" />
                          )}
                        </div>
                        <span className="ml-4 text-lg text-gray-700">
                          {item.text}
                        </span>
                      </li>
                    ))}
                  </ul>
                </div>
              </CardFooter>
            </div>
          </Card>
        </div>
      </div>
    </div>
  );
};
