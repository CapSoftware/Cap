import Link from "next/link";

export const LogoSection = () => {
  return (
    <div className="pb-32 wrapper md:pb-40">
      <div className="mb-4">
        <Link href="/" aria-label="Cap Home" className="inline-block w-[250px] h-auto mx-auto">
          <svg
            aria-label="Cap Logo"
            xmlns="http://www.w3.org/2000/svg"
            className="w-[250px] h-auto mx-auto"
            fill="none"
            viewBox="0 0 255 30"
          >
            <path />
          </svg>
        </Link>
      </div>
      <div className="text-center max-w-[800px] mx-auto mb-8">
        <h2 className="mb-3 text-2xl">
          Used by employees at leading tech companies
        </h2>
      </div>
      <div className="flex flex-col items-center text-center lg:flex-row lg:items-center lg:justify-between lg:text-left">
        <div className="grid grid-cols-2 gap-6 mx-auto md:grid-cols-5 lg:max-w-4xl lg:gap-10">
          <div className="flex justify-center items-center mt-8 lg:mt-0">
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
          <div className="flex justify-center items-center mt-8 lg:mt-0">
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
          <div className="flex justify-center items-center mt-8 lg:mt-0">
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
          <div className="flex justify-center items-center mt-8 lg:mt-0">
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
          <div className="flex justify-center items-center mt-8 lg:mt-0">
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
  );
};
