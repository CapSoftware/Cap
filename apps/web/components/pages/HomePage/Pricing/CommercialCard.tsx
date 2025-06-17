import { Button, Switch } from "@cap/ui";
import {
  faCheck,
  faMinus,
  faPlus,
} from "@fortawesome/free-solid-svg-icons";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import NumberFlow from "@number-flow/react";
import clsx from "clsx";
import { useRef, useState } from "react";
import { toast } from "sonner";
import { CommercialArt, CommercialArtRef } from "./CommercialArt";

export const CommercialCard = () => {
  const [licenses, setLicenses] = useState(1);
  const [isYearly, setIsYearly] = useState(false);
  const [commercialLoading, setCommercialLoading] = useState(false);
  const commercialArtRef = useRef<CommercialArtRef>(null);

  const COMMERCIAL_LICENSE_YEARLY_PRICE = 29;
  const COMMERCIAL_LICENSE_LIFETIME_PRICE = 58;

  const currentPrice = isYearly
    ? licenses * COMMERCIAL_LICENSE_YEARLY_PRICE
    : licenses * COMMERCIAL_LICENSE_LIFETIME_PRICE;
  const billingCycleText = isYearly ? "year" : "lifetime";

  const incrementLicenses = () => setLicenses((prev) => prev + 1);
  const decrementLicenses = () =>
    setLicenses((prev) => (prev > 1 ? prev - 1 : 1));

  const openCommercialCheckout = async () => {
    setCommercialLoading(true);
    try {
      const response = await fetch(`/api/commercial/checkout`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          type: isYearly ? "yearly" : "lifetime",
          quantity: licenses,
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

  return (
    <div
      onMouseEnter={() => commercialArtRef.current?.playHoverAnimation()}
      onMouseLeave={() => commercialArtRef.current?.playDefaultAnimation()}
      className="flex flex-col flex-1 justify-between p-8 rounded-2xl border shadow-lg bg-gray-1 border-gray-5"
    >
      <div>
        <div className="md:h-[300px]">
        <CommercialArt ref={commercialArtRef} />
        <h3 className="mb-2 text-2xl text-center text-gray-12">
          App + Commercial License
        </h3>
        <p className="mb-6 text-base text-center text-gray-10 w-full max-w-[285px] mx-auto">
          For professional use of the desktop app, without cloud features.
        </p>
        </div>

        <div className="mb-6 text-center">
          <span className="text-5xl tabular-nums text-gray-12">
            $<NumberFlow value={currentPrice} />
          </span>
          <span className="text-lg tabular-nums text-gray-10">
            {" "}
            / {billingCycleText}
          </span>
          {isYearly ? (
            <p className="text-lg tabular-nums text-gray-10">
              or, $
              <NumberFlow value={licenses * COMMERCIAL_LICENSE_LIFETIME_PRICE} />{" "}
              one-time payment
            </p>
          ) : (
            <p className="text-lg tabular-nums text-gray-10">
              or, $
              <NumberFlow value={licenses * COMMERCIAL_LICENSE_YEARLY_PRICE} />{" "}
              / year
            </p>
          )}
        </div>

        <div className="flex flex-wrap gap-5 justify-center items-center p-5 my-8 w-full rounded-xl border xs:gap-3 xs:p-3 xs:rounded-full xs:justify-between bg-gray-3 border-gray-4">

        <div className="flex gap-3 justify-center items-center">
          <p className="text-base text-gray-12">Licenses:</p>
          <div className="flex items-center">
          <Button
               onClick={decrementLicenses}
               className="px-1.5 py-1.5 bg-gray-12 hover:bg-gray-11 min-w-fit h-fit"
               aria-label="Decrease license count"
             >
               <FontAwesomeIcon icon={faMinus} className="text-gray-1 size-3" />
             </Button>
            <span className="w-8 font-medium tabular-nums text-center text-gray-12">
              <NumberFlow value={licenses} />
            </span>
            <Button
               onClick={incrementLicenses}
               className="px-1.5 py-1.5 bg-gray-12 hover:bg-gray-11 min-w-fit h-fit"
               aria-label="Increase license count"
             >
               <FontAwesomeIcon icon={faPlus} className="text-gray-1 size-3" />
             </Button>
          </div>
        </div>

        <div className="flex justify-center items-center">
          <div className="flex gap-2 items-center">
            <span
              className={clsx(
                "text-md",
                isYearly ? "font-medium text-gray-12" : "text-gray-10"
              )}
            >
              Yearly
            </span>
            <Switch
              checked={!isYearly}
              onCheckedChange={(checked) => setIsYearly(!checked)}
              aria-label="Billing Cycle For Commercial"
              id="billing-cycle-commercial"
            />
            <span
              className={clsx(
                "text-md",
                !isYearly ? "font-medium text-gray-12" : "text-gray-10"
              )}
            >
              Lifetime
            </span>
          </div>
        </div>
        
        </div>


        <ul className="mb-8 space-y-3 text-base">
          <li className="flex items-center text-gray-12">
            <FontAwesomeIcon icon={faCheck} className="mr-2 text-gray-12" />
            Commercial use of Cap Recorder + Editor
          </li>
          <li className="flex items-center text-gray-12">
            <FontAwesomeIcon icon={faCheck} className="mr-2 text-gray-12" />
            Community Support
          </li>
          <li className="flex items-center text-gray-12">
            <FontAwesomeIcon icon={faCheck} className="mr-2 text-gray-12" />
            Local-only features
          </li>
          <li className="flex items-center text-gray-12">
            <FontAwesomeIcon icon={faCheck} className="mr-2 text-gray-12" />
            Perpetual license option
          </li>
        </ul>
      </div>

      <Button
         disabled={commercialLoading}
         onClick={openCommercialCheckout}
         variant="primary"
         size="lg"
         className="w-full font-medium"
         aria-label="Purchase Commercial License"
       >
         {commercialLoading ? "Loading..." : "Purchase License"}
       </Button>
    </div>
  );
};
