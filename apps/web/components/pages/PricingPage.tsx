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
import { parseAsBoolean, parseAsInteger, useQueryState } from "nuqs";

export const PricingPage = () => {
  const [proLoading, setProLoading] = useState(false);
  const [commercialLoading, setCommercialLoading] = useState(false);
  const [selfHostedLoading, setSelfHostedLoading] = useState(false);
  const [isAnnual, setIsAnnual] = useQueryState(
    "proAnnual",
    parseAsBoolean.withDefault(true)
  );
  const [isCommercialAnnual, setIsCommercialAnnual] = useQueryState(
    "commercialAnnual",
    parseAsBoolean.withDefault(false)
  );
  const [isSelfHostedAnnual, setIsSelfHostedAnnual] = useQueryState(
    "selfHostedAnnual",
    parseAsBoolean.withDefault(true)
  );
  const [proQuantity, setProQuantity] = useQueryState(
    "users",
    parseAsInteger.withDefault(1)
  );
  const [licenseQuantity, setLicenseQuantity] = useQueryState(
    "licenses",
    parseAsInteger.withDefault(1)
  );
  const [selfHostedQuantity, setSelfHostedQuantity] = useQueryState(
    "seats",
    parseAsInteger.withDefault(10)
  );
  const [initialRender, setInitialRender] = useState(true);
  const [deploymentType, setDeploymentType] = useQueryState("deploy", {
    defaultValue: "cloud",
    parse: (value) => value as "cloud" | "selfhosted",
  });
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

  const openSelfHostedCheckout = async () => {
    setSelfHostedLoading(true);
    try {
      const requestData = {
        type: isSelfHostedAnnual ? "yearly" : "monthly",
        quantity: selfHostedQuantity,
      };

      console.log("Self-hosted checkout request data:", requestData);
      console.log(
        "Self-hosted checkout JSON payload:",
        JSON.stringify(requestData)
      );

      const response = await fetch(`/api/selfhosted/checkout`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify(requestData),
      });

      console.log("Self-hosted checkout response status:", response.status);

      // Try to get the raw response text first
      const responseText = await response.text();
      console.log("Self-hosted checkout raw response:", responseText);

      // Then parse it as JSON if possible
      let data;
      try {
        data = JSON.parse(responseText);
        console.log("Self-hosted checkout parsed response data:", data);
      } catch (parseError) {
        console.error("Error parsing response JSON:", parseError);
        toast.error("Invalid response format from server");
        setSelfHostedLoading(false);
        return;
      }

      if (response.status === 200) {
        console.log("Redirecting to:", data.url);
        window.location.href = data.url;
      } else {
        console.error("Error response from server:", data.message);
        window.alert(data.message);
      }
    } catch (error) {
      console.error("Error during self-hosted checkout:", error);
      toast.error("Failed to start checkout process");
    } finally {
      setSelfHostedLoading(false);
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

  const selfHostedList = [
    {
      text: "Self-hosted on your own infrastructure",
      available: true,
    },
    {
      text: "Full control over your data",
      available: true,
    },
    {
      text: "White labeling with custom branding",
      available: true,
    },
    {
      text: "Customizable UI and domain",
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
      text: "Custom branding options",
      available: true,
    },
    {
      text: "Priority support",
      available: true,
    },
    {
      text: "Dedicated onboarding",
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
              className={`text-4xl md:text-5xl ${
                initialRender ? "fade-in-down" : ""
              }mb-6 }`}
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

            <div className="flex justify-center mt-5 mb-8">
              <div className="inline-flex bg-gray-100 p-1 rounded-full border border-blue-300">
                <div
                  className={`rounded-full z-10 relative transition-all duration-300 min-w-[120px] py-2 px-6 mx-0.5 text-center cursor-pointer border ${
                    deploymentType === "cloud"
                      ? "bg-white text-blue-600 font-medium shadow-sm border-blue-300"
                      : "bg-transparent text-gray-700 border-transparent"
                  }`}
                  onClick={() => setDeploymentType("cloud")}
                >
                  Cloud
                </div>
                <div
                  className={`rounded-full z-10 relative transition-all duration-300 min-w-[120px] py-2 px-6 mx-0.5 text-center cursor-pointer border ${
                    deploymentType === "selfhosted"
                      ? "bg-white text-blue-600 font-medium shadow-sm border-blue-300"
                      : "bg-transparent text-gray-700 border-transparent"
                  }`}
                  onClick={() => setDeploymentType("selfhosted")}
                >
                  Self-hosted
                </div>
              </div>
            </div>
          </div>

          {deploymentType === "cloud" ? (
            <div className="grid grid-cols-1 gap-3 items-stretch md:grid-cols-2">
              <Card
                className={`bg-gray-100 rounded-xl min-h-[600px] flex-grow ${
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
                      <div className="flex items-center justify-between pt-4 mt-2 border-t border-gray-200">
                        <div className="flex items-center">
                          <span className="mr-2 text-xs">
                            Switch to{" "}
                            {isCommercialAnnual ? "lifetime" : "yearly"}
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
                            <Button
                              variant="secondary"
                              size="sm"
                              onClick={() =>
                                licenseQuantity > 1 &&
                                setLicenseQuantity(licenseQuantity - 1)
                              }
                              className="px-2 py-0 h-6"
                            >
                              -
                            </Button>
                            <span className="w-4 text-center">
                              {licenseQuantity}
                            </span>
                            <Button
                              variant="secondary"
                              size="sm"
                              onClick={() =>
                                setLicenseQuantity(licenseQuantity + 1)
                              }
                              className="px-2 py-0 h-6"
                            >
                              +
                            </Button>
                          </div>
                        </div>
                      </div>
                    </div>
                  </CardHeader>
                  <CardContent>
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
                  </CardContent>
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
                              <span className="ml-1.5 font-bold text-gray-500">
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
                className={`bg-gray-100 rounded-xl min-h-[600px] flex-grow border-blue-500 border-4 ${
                  initialRender ? "fade-in-up animate-delay-2" : ""
                }`}
              >
                <div className="space-y-3">
                  <CardHeader>
                    <CardTitle className="text-2xl  font-medium">
                      App + Commercial License +{" "}
                      <span className="text-blue-500 text-2xl font-bold">
                        Cap Pro
                      </span>
                    </CardTitle>
                    <CardDescription className="text-lg">
                      For professional use + cloud features like shareable
                      links, transcriptions, comments, & more. Perfect for teams
                      or sharing with clients.
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
                      <div className="flex items-center justify-between pt-4 mt-2 border-t border-gray-200">
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
                            <Button
                              variant="secondary"
                              size="sm"
                              onClick={() =>
                                proQuantity > 1 &&
                                setProQuantity(proQuantity - 1)
                              }
                              className="px-2 py-0 h-6"
                            >
                              -
                            </Button>
                            <span className="w-4 text-center">
                              {proQuantity}
                            </span>
                            <Button
                              variant="secondary"
                              size="sm"
                              onClick={() => setProQuantity(proQuantity + 1)}
                              className="px-2 py-0 h-6"
                            >
                              +
                            </Button>
                          </div>
                        </div>
                      </div>
                    </div>
                  </CardHeader>
                  <CardContent>
                    <Button
                      variant="primary"
                      onClick={() => planCheckout()}
                      className="w-full"
                      size="lg"
                      disabled={proLoading}
                    >
                      {proLoading ? "Loading..." : "Upgrade to Cap Pro"}
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
                    </div>
                  </CardFooter>
                </div>
              </Card>
            </div>
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
              <Card
                className={`bg-gray-100 rounded-xl min-h-[600px] flex-grow border-blue-500 border-4 ${
                  initialRender ? "fade-in-up animate-delay-2" : ""
                }`}
              >
                <div className="space-y-3">
                  <CardHeader>
                    <CardTitle className="text-2xl font-medium">
                      <span className="text-black text-2xl font-medium">
                        Self-hosted
                      </span>{" "}
                      <span className="text-blue-500 text-2xl font-bold">
                        Cap Pro
                      </span>
                    </CardTitle>
                    <CardDescription className="text-lg">
                      Deploy Cap on your own infrastructure with full control
                      over your data. Ideal for enterprises and organizations
                      with specific security requirements or those wanting to
                      white label the platform.
                    </CardDescription>
                    <div>
                      <div className="flex items-center space-x-3">
                        <h3 className="text-4xl">
                          {isSelfHostedAnnual
                            ? `$${6 * selfHostedQuantity}/mo`
                            : `$${9 * selfHostedQuantity}/mo`}
                        </h3>
                        <div>
                          <p className="text-sm font-medium">
                            {`for ${selfHostedQuantity} users, billed ${
                              isSelfHostedAnnual ? "annually" : "monthly"
                            }.`}
                          </p>
                          {isSelfHostedAnnual && (
                            <p className="text-sm">
                              or, ${9 * selfHostedQuantity}/month, for{" "}
                              {selfHostedQuantity} users, billed monthly.
                            </p>
                          )}
                        </div>
                      </div>
                      <div className="flex items-center justify-between pt-4 mt-2 border-t border-gray-200">
                        <div className="flex items-center">
                          <span className="mr-2 text-xs">
                            Switch to{" "}
                            {isSelfHostedAnnual ? "monthly" : "annually"}
                          </span>
                          <Switch
                            checked={!isSelfHostedAnnual}
                            onCheckedChange={() =>
                              setIsSelfHostedAnnual(!isSelfHostedAnnual)
                            }
                          />
                        </div>
                        <div className="flex items-center">
                          <span className="mr-2 text-xs">Users:</span>
                          <div className="flex gap-2 items-center">
                            <Button
                              variant="secondary"
                              size="sm"
                              onClick={() =>
                                selfHostedQuantity > 10 &&
                                setSelfHostedQuantity(selfHostedQuantity - 1)
                              }
                              className="px-2 py-0 h-6"
                            >
                              -
                            </Button>
                            <span className="w-4 text-center">
                              {selfHostedQuantity}
                            </span>
                            <Button
                              variant="secondary"
                              size="sm"
                              onClick={() =>
                                setSelfHostedQuantity(selfHostedQuantity + 1)
                              }
                              className="px-2 py-0 h-6"
                            >
                              +
                            </Button>
                          </div>
                        </div>
                      </div>
                    </div>
                  </CardHeader>
                  <CardContent>
                    <Button
                      variant="primary"
                      onClick={openSelfHostedCheckout}
                      className="w-full"
                      size="lg"
                      disabled={selfHostedLoading}
                    >
                      {selfHostedLoading
                        ? "Loading..."
                        : "Get Self-hosted Cap Pro"}
                    </Button>
                  </CardContent>
                  <CardFooter>
                    <div className="space-y-8">
                      <div>
                        <ul className="p-0 space-y-3 list-none">
                          {selfHostedList.map((item, index) => (
                            <li
                              key={index}
                              className="flex justify-start items-center"
                            >
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
                    </div>
                  </CardFooter>
                </div>
              </Card>
              <div>
                <div className="grid gap-6">
                  {faqContent.map((section, index) => {
                    return (
                      <div key={index} className="pb-4">
                        <h3 className="mb-2 text-xl font-medium">
                          {section.title}
                        </h3>
                        <p className="text-gray-700">{section.answer}</p>
                      </div>
                    );
                  })}
                </div>
              </div>
            </div>
          )}
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
