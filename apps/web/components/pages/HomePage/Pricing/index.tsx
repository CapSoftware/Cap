import { faHeart } from "@fortawesome/free-solid-svg-icons";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { homepageCopy } from "../../../../data/homepage-copy";
import { CommercialCard } from "./CommercialCard";
import { ProCard } from "./ProCard";

export { CommercialCard } from "./CommercialCard";
export { ProCard } from "./ProCard";

const Pricing = () => {
  return (
    <div className="w-full max-w-[1100px] mx-auto px-5">
      <div className="px-5 mb-16 text-center">
        <h2 className="mb-3 w-full">{homepageCopy.pricing.title}</h2>
        <p className="text-lg max-w-[800px] mx-auto leading-[1.75rem] w-full">
          {homepageCopy.pricing.subtitle}
        </p>
        <div className="flex justify-center items-center px-5 py-2.5 gap-2 mx-auto mt-6 rounded-full border bg-gray-1 border-gray-5 w-fit">
          <FontAwesomeIcon className="text-red-500 size-3.5" icon={faHeart} />
          <p className="font-medium text-gray-12">
            {homepageCopy.pricing.lovedBy}
          </p>
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
