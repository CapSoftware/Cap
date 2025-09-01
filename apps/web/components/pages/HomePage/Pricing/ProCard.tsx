import { Button, Switch } from "@cap/ui";
import { getProPlanId } from "@cap/utils";
import { faCheck, faMinus, faPlus } from "@fortawesome/free-solid-svg-icons";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import NumberFlow from "@number-flow/react";
import clsx from "clsx";
import { useRouter } from "next/navigation";
import { useRef, useState } from "react";
import { toast } from "sonner";
import { homepageCopy } from "../../../../data/homepage-copy";
import { ProArt, type ProArtRef } from "./ProArt";

export const ProCard = () => {
  const [users, setUsers] = useState(1);
  const [isAnnually, setIsAnnually] = useState(true);
  const [proLoading, setProLoading] = useState(false);
  const [guestLoading, setGuestLoading] = useState(false);
  const proArtRef = useRef<ProArtRef>(null);
  const { push } = useRouter();

  const CAP_PRO_ANNUAL_PRICE_PER_USER = homepageCopy.pricing.pro.pricing.annual;
  const CAP_PRO_MONTHLY_PRICE_PER_USER =
    homepageCopy.pricing.pro.pricing.monthly;

  const currentTotalPricePro =
    users *
    (isAnnually
      ? CAP_PRO_ANNUAL_PRICE_PER_USER
      : CAP_PRO_MONTHLY_PRICE_PER_USER);
  const billingCycleTextPro = isAnnually
    ? "per user, billed annually"
    : "per user, billed monthly";

  const incrementUsers = () => setUsers((prev) => prev + 1);
  const decrementUsers = () => setUsers((prev) => (prev > 1 ? prev - 1 : 1));

  const guestCheckout = async (planId: string) => {
    setGuestLoading(true);

    try {
      const response = await fetch(`/api/settings/billing/guest-checkout`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ priceId: planId, quantity: users }),
      });
      const data = await response.json();

      if (data.url) {
        window.location.href = data.url;
      } else {
        toast.error("Failed to create checkout session");
      }
    } catch (error) {
      toast.error("An error occurred. Please try again.");
    } finally {
      setGuestLoading(false);
    }
  };

  const planCheckout = async (planId?: string) => {
    setProLoading(true);

    if (!planId) {
      planId = getProPlanId(isAnnually ? "yearly" : "monthly");
    }

    const response = await fetch(`/api/settings/billing/subscribe`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ priceId: planId, quantity: users }),
    });
    const data = await response.json();

    if (data.auth === false) {
      // User not authenticated, do guest checkout
      setProLoading(false);
      await guestCheckout(planId);
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

  return (
    <div
      onMouseEnter={() => {
        proArtRef.current?.playHoverAnimation();
      }}
      onMouseLeave={() => {
        proArtRef.current?.playDefaultAnimation();
      }}
      className="flex relative flex-col flex-1 justify-between p-8 text-white rounded-2xl shadow-2xl bg-gray-12"
    >
      <div>
        <div className="absolute top-0 left-1/2 transform -translate-x-1/2 -translate-y-1/2">
          <span className="rounded-full font-mono bg-blue-500 px-4 py-1.5 text-xs uppercase text-gray-1">
            {homepageCopy.pricing.pro.badge}
          </span>
        </div>
        <div className="md:h-[300px]">
          <ProArt ref={proArtRef} />
          <h3 className="mb-2 text-2xl text-center">
            {homepageCopy.pricing.pro.title}
          </h3>
          <p className="mb-6 text-base text-center text-gray-8">
            {homepageCopy.pricing.pro.description}
          </p>
        </div>

        <div className="mb-6 text-center">
          <span className="mr-2 text-5xl tabular-nums text-gray-1">
            $<NumberFlow suffix="/mo" value={currentTotalPricePro} />
          </span>
          <span className="text-lg tabular-nums text-gray-8">
            {" "}
            {billingCycleTextPro}
          </span>
          {isAnnually ? (
            <p className="text-lg text-gray-8">
              or,{" "}
              <NumberFlow
                value={CAP_PRO_MONTHLY_PRICE_PER_USER * users}
                className="text-lg tabular-nums"
                format={{
                  notation: "compact",
                  style: "currency",
                  currency: "USD",
                }}
                suffix="/mo"
              />{" "}
              {users === 1 ? (
                "per user, "
              ) : (
                <>
                  for{" "}
                  <NumberFlow value={users} className="text-lg tabular-nums" />{" "}
                  users,{" "}
                </>
              )}
              billed monthly
            </p>
          ) : (
            <p className="text-lg text-gray-8">
              or,{" "}
              <NumberFlow
                value={CAP_PRO_ANNUAL_PRICE_PER_USER * users}
                className="text-lg tabular-nums"
                format={{
                  notation: "compact",
                  style: "currency",
                  currency: "USD",
                }}
                suffix="/mo"
              />{" "}
              {users === 1 ? (
                "per user, "
              ) : (
                <>
                  for{" "}
                  <NumberFlow value={users} className="text-lg tabular-nums" />{" "}
                  users,{" "}
                </>
              )}
              billed annually
            </p>
          )}
        </div>

        <div className="flex flex-wrap gap-5 justify-center items-center p-5 my-8 w-full rounded-xl border xs:gap-3 xs:p-3 xs:rounded-full xs:justify-between bg-zinc-700/50 border-zinc-700">
          <div className="flex gap-3 justify-center items-center">
            <p className="text-base text-gray-1">
              {homepageCopy.pricing.pro.labels.users}
            </p>
            <div className="flex items-center">
              <Button
                onClick={decrementUsers}
                className="px-1.5 py-1.5 bg-gray-1 hover:bg-gray-3 min-w-fit h-fit"
                aria-label="Decrease user count"
              >
                <FontAwesomeIcon
                  icon={faMinus}
                  className="text-gray-12 size-3"
                />
              </Button>
              <span className="w-8 font-medium tabular-nums text-center text-white">
                <NumberFlow value={users} />
              </span>
              <Button
                onClick={incrementUsers}
                className="px-1.5 py-1.5 bg-gray-1 hover:bg-gray-3 min-w-fit h-fit"
                aria-label="Increase user count"
              >
                <FontAwesomeIcon
                  icon={faPlus}
                  className="text-gray-12 size-3"
                />
              </Button>
            </div>
          </div>

          <div className="flex justify-center items-center">
            <div className="flex gap-2 items-center">
              <span
                className={clsx(
                  "text-md",
                  !isAnnually ? "text-white" : "text-gray-8"
                )}
              >
                {homepageCopy.pricing.pro.labels.monthly}
              </span>
              <Switch
                checked={isAnnually}
                onCheckedChange={setIsAnnually}
                aria-label="Billing Cycle For Pro"
                id="billing-cycle-cap-pro"
              />
              <span
                className={clsx(
                  "text-md",
                  isAnnually ? "text-white" : "text-gray-8"
                )}
              >
                {homepageCopy.pricing.pro.labels.annually}
              </span>
            </div>
          </div>
        </div>

        <ul className="mb-8 space-y-3 text-base">
          {homepageCopy.pricing.pro.features.map((feature) => (
            <li key={feature} className="flex items-center text-gray-1">
              <FontAwesomeIcon icon={faCheck} className="mr-2 text-gray-1" />
              {feature}
            </li>
          ))}
        </ul>
      </div>

      <Button
        variant="blue"
        size="lg"
        onClick={() => planCheckout()}
        disabled={proLoading || guestLoading}
        className="w-full font-medium"
        aria-label="Purchase Cap Pro License"
      >
        {proLoading || guestLoading
          ? "Loading..."
          : homepageCopy.pricing.pro.cta}
      </Button>
    </div>
  );
};
