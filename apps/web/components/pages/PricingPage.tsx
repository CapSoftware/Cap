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
import NumberFlow from "@number-flow/react";
import clsx from "clsx";
import { Check } from "lucide-react";
import { useRouter, useSearchParams } from "next/navigation";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { SimplePlans } from "../text/SimplePlans";
import { Testimonials } from "../ui/Testimonials";

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


  useEffect(() => {
    const init = async () => {
      setInitialRender(false);
      const planFromUrl = searchParams.get("plan");
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

  const scrollToTestimonials = (e: React.MouseEvent) => {
    e.preventDefault();
    const testimonials = document.getElementById("testimonials");
    if (testimonials) {
      const offset = 80;
      const topPos =
        testimonials.getBoundingClientRect().top + window.pageYOffset - offset;
      window.scrollTo({
        top: topPos,
        behavior: "smooth",
      });
    }
  };

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
          <div className="mb-8 text-center">
            <div
              className={clsx("mb-4", {
                "fade-in-down animate-delay-1": initialRender,
              })}
            >
              <SimplePlans />
            </div>
            <h1
              className={clsx("text-4xl md:text-5xl", {
                "fade-in-down animate-delay-1 text-gray-12": initialRender,
              })}
            >
              Early Adopter Pricing
            </h1>
            <p
              className={clsx("mx-auto mt-3 max-w-[800px]", {
                "mt-4 fade-in-down animate-delay-1 text-gray-10": initialRender,
              })}
            >
              Cap is currently in public beta, and we're offering special early
              adopter pricing to our first users. This pricing will be locked in
              for the lifetime of your subscription.
            </p>
            <a
              className="inline-flex mt-3 text-sm font-bold text-gray-10 hover:underline fade-in-down animate-delay-1"
              href="#testimonials"
              onClick={scrollToTestimonials}
            >
              Loved by 10k+ users
            </a>
          </div>

          <div className="grid grid-cols-1 gap-3 items-stretch md:grid-cols-2">
            <Card
              className={clsx("flex-grow rounded-xl bg-gray-1 min-h-[600px]", {
                "fade-in-down animate-delay-2": initialRender,
              })}
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
                      <NumberFlow
                        value={isCommercialAnnual
                          ? `${29 * licenseQuantity}`
                          : `${58 * licenseQuantity}`}
                        className="text-4xl tabular-nums"
                        format={{
                          notation: "compact",
                          style: "currency",
                          currency: "USD",                         
                        }}
                      />
                      <div>
                        <p className="text-sm font-medium">
                          {isCommercialAnnual
                            ? licenseQuantity === 1
                              ? "billed annually"
                              : <>for <NumberFlow value={licenseQuantity} className="text-sm font-medium tabular-nums" /> licenses, billed annually</>
                            : licenseQuantity === 1
                            ? "one-time payment"
                            : <>for <NumberFlow value={licenseQuantity} className="text-sm font-medium tabular-nums" /> licenses, one-time payment</>
                          }
                        </p>
                        {isCommercialAnnual && (
                          <p className="text-sm">
                            or, <NumberFlow value={58 * licenseQuantity} className="text-sm tabular-nums" format={{ notation: "compact", style: "currency", currency: "USD" }} /> one-time payment
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
                          <NumberFlow value={licenseQuantity} className="text-sm tabular-nums" />
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
                initialRender ? "fade-in-up animate-delay-2" : ""}`}
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
                      <NumberFlow
                        value={isAnnual
                          ? `${6 * proQuantity}`
                          : `${9 * proQuantity}`}
                        className="text-4xl tabular-nums"
                        format={{
                          notation: "compact",
                          style: "currency",
                          currency: "USD",
                        }}
                        suffix="/mo"
                     />
                      <div>
                        <p className="text-sm font-medium">
                          {isAnnual
                            ? (proQuantity === 1
                              ? "per user, billed annually."
                              : <>for <NumberFlow value={proQuantity} className="text-sm font-medium tabular-nums" /> users, billed annually.</>)
                            : (proQuantity === 1
                              ? "per user, billed monthly."
                              : <>for <NumberFlow value={proQuantity} className="text-sm font-medium tabular-nums" /> users, billed monthly.</>)
                          }
                        </p>
                        {isAnnual && (
                          <p className="text-sm">
                            or, <NumberFlow value={9 * proQuantity} className="text-sm tabular-nums" format={{ notation: "compact", style: "currency", currency: "USD", }} suffix="/mo" />{" "}
                            {proQuantity === 1
                              ? "per user, "
                              : <>for <NumberFlow value={proQuantity} className="text-sm tabular-nums" /> users, </>}
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
                          <NumberFlow value={proQuantity} className="text-sm tabular-nums" />
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
        <div className="mb-32 wrapper" id="testimonials">
          <Testimonials
            amount={24}
            title="What our users say about Cap after hitting record"
            subtitle="Don't just take our word for it. Here's what our users are saying about their experience with Cap."
          />
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
