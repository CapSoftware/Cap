import { faHeart } from "@fortawesome/free-solid-svg-icons";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import React from "react";
import { CommercialCard } from "./CommercialCard";
import { ProCard } from "./ProCard";

export { CommercialCard } from "./CommercialCard";
export { ProCard } from "./ProCard";

const Pricing = () => {
  return (
    <div className="w-full max-w-[1000px] mx-auto my-[150px] md:my-[200px] lg:my-[250px] px-5">
      <div className="px-5 mb-16 text-center">
        <h2 className="mb-3 w-full">Pricing</h2>
        <p className="text-lg max-w-[800px] mx-auto leading-[1.75rem] w-full">
          Cap is currently in public beta, and we're offering special early
          adopter pricing to our first users. This pricing will be locked in for
          the lifetime of your subscription.
        </p>
        <div className="flex justify-center items-center px-5 py-2.5 gap-2 mx-auto mt-6 rounded-full border bg-gray-1 border-gray-5 w-fit">
          <FontAwesomeIcon className="text-red-500 size-3.5" icon={faHeart} />
          <p className="font-medium text-gray-12">Loved by 10k+ users</p>
        </div>
      </div>
      <div className="flex flex-col gap-8 justify-center items-stretch lg:flex-row">
        <CommercialCard />
        <ProCard />
      </div>
    </div>
  );
};

export default Pricing;
