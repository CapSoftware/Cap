import React from "react";

interface LogoMarqueeProps {
  className?: string;
}

export const LogoMarquee: React.FC<LogoMarqueeProps> = ({ className = "" }) => {
  const logos = [
    {
      src: "/logos/microsoft.svg",
      alt: "Microsoft Logo",
      width: 98,
      height: 24,
    },
    {
      src: "/logos/amazon.svg",
      alt: "Amazon Logo",
      width: 100,
      height: 30,
    },
    {
      src: "/logos/berkeley.svg",
      alt: "Berkeley Logo",
      width: 100,
      height: 30,
    },
    {
      src: "/logos/figma.svg",
      alt: "Figma Logo",
      width: 30,
      height: 10,
    },
    {
      src: "/logos/coinbase.svg",
      alt: "Coinbase Logo",
      width: 139,
      height: 32,
    },
    { src: "/logos/ibm.svg", alt: "IBM Logo", width: 80, height: 20 },
    { src: "/logos/dropbox.svg", alt: "Dropbox Logo", width: 115, height: 50 },
    { src: "/logos/tesla.svg", alt: "Tesla Logo", width: 100, height: 30 },
  ];

  return (
    <div className={`overflow-hidden relative w-full ${className}`}>
      {/* Fade gradient on the left side */}
      <div className="absolute top-0 left-0 z-10 w-12 h-full bg-gradient-to-r from-[#F2F2F2] to-transparent"></div>

      <div className="flex animate-marquee">
        {/* First set of logos */}
        {logos.map((logo, index) => (
          <div
            key={`logo-1-${index}`}
            className="flex justify-center items-center mx-5 shrink-0"
          >
            <img
              alt={logo.alt}
              loading="lazy"
              width={logo.width}
              height={logo.height}
              decoding="async"
              style={{ color: "transparent", opacity: 0.5 }}
              src={logo.src}
            />
          </div>
        ))}

        {/* Duplicate set of logos for seamless looping */}
        {logos.map((logo, index) => (
          <div
            key={`logo-2-${index}`}
            className="flex justify-center items-center mx-5 shrink-0"
          >
            <img
              alt={logo.alt}
              loading="lazy"
              width={logo.width}
              height={logo.height}
              decoding="async"
              style={{ color: "transparent", opacity: 0.5 }}
              src={logo.src}
            />
          </div>
        ))}
      </div>

      {/* Fade gradient on the right side */}
      <div className="absolute top-0 right-0 z-10 w-12 h-full bg-gradient-to-l from-[#F2F2F2] to-transparent"></div>
    </div>
  );
};
