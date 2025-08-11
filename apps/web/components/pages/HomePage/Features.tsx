import { Fit, Layout, useRive } from "@rive-app/react-canvas";
import clsx from "clsx";
import { memo } from "react";
import { homepageCopy } from "../../../data/homepage-copy";
import { Button } from "@cap/ui";

type Feature = {
  title: string;
  description: string;
  rive: JSX.Element;
  relative?: {
    top?: number;
    bottom?: number;
    left?: number;
    right?: number;
  };
};

const VideoCaptureArt = memo(() => {
  const { RiveComponent: VideoCaptureRive } = useRive({
    src: "/rive/bento.riv",
    artboard: "videocapture",
    animations: ["in"],
    autoplay: true,
    layout: new Layout({
      fit: Fit.Contain,
    }),
  });
  return (
    <VideoCaptureRive className="w-full max-w-[420px] mx-auto h-[244px]" />
  );
});

const StorageOptionsArt = memo(() => {
  const { RiveComponent: StorageOptionsRive } = useRive({
    src: "/rive/bento.riv",
    artboard: "storageoptions",
    animations: ["in"],
    autoplay: true,
    layout: new Layout({
      fit: Fit.Contain,
    }),
  });
  return (
    <StorageOptionsRive className="w-full max-w-[350px] mx-auto h-[275px]" />
  );
});

const CollabArt = memo(() => {
  const { RiveComponent: CollabRive } = useRive({
    src: "/rive/bento.riv",
    artboard: "collab",
    animations: ["in"],
    autoplay: true,
    layout: new Layout({
      fit: Fit.Contain,
    }),
  });
  return <CollabRive className="w-full max-w-[500px] mx-auto h-[280px]" />;
});

const PrivacyFirstArt = memo(() => {
  const { RiveComponent: PrivacyFirstRive } = useRive({
    src: "/rive/bento.riv",
    artboard: "privacyfirst",
    animations: ["in"],
    autoplay: true,
    layout: new Layout({
      fit: Fit.Contain,
    }),
  });
  return (
    <PrivacyFirstRive className="w-full max-w-[560px] mx-auto h-[250px]" />
  );
});

const PlatformSupportArt = memo(() => {
  const { RiveComponent: PlatformSupportRive } = useRive({
    src: "/rive/bento.riv",
    artboard: "platformsupport",
    animations: ["in"],
    autoplay: true,
    layout: new Layout({
      fit: Fit.Contain,
    }),
  });
  return (
    <PlatformSupportRive className="w-full max-w-[500px] mx-auto h-[280px]" />
  );
});

const EveryoneArt = memo(() => {
  const { RiveComponent: EveryoneRive } = useRive({
    src: "/rive/bento.riv",
    artboard: "everyone",
    animations: ["in"],
    autoplay: true,
    layout: new Layout({
      fit: Fit.Contain,
    }),
  });
  return <EveryoneRive className="w-full max-w-[600px] mx-auto h-[300px]" />;
});

const CapAIArt = memo(() => {
  const { RiveComponent: CapAIArt } = useRive({
    src: "/rive/bento.riv",
    artboard: "capai",
    animations: ["in"],
    autoplay: true,
    layout: new Layout({
      fit: Fit.Contain,
    }),
  });
  return <CapAIArt className="w-full max-w-[550px] mx-auto h-[300px]" />;
});

const features: Feature[] = homepageCopy.features.features.map(
  (feature, index) => {
    const riveComponents: JSX.Element[] = [
      <StorageOptionsArt key="storage" />,
      <PrivacyFirstArt key="privacy" />,
      <CollabArt key="collab" />,
      <PlatformSupportArt key="platform" />,
      <VideoCaptureArt key="video" />,
      <EveryoneArt key="everyone" />,
      <CapAIArt key="capai" />,
    ];

    const relatives = [
      { top: 25 },
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
    ];

    return {
      title: feature.title,
      description: feature.description,
      rive: riveComponents[index] || <div key={`placeholder-${index}`} />,
      relative: relatives[index],
    };
  }
);

const Features = () => {
  return (
    <div className="text-center max-w-[1440px] mx-auto px-5">
      <h2 className="mb-3">{homepageCopy.features.title}</h2>
      <p className="text-lg leading-[1.75rem] w-full max-w-[600px] mx-auto">
        {homepageCopy.features.subtitle}
      </p>
      <div className="flex flex-col gap-4 mt-[52px]">
        {/* Second row - 2 features */}
        <div className="grid grid-cols-1 gap-4 mx-auto w-full md:grid-cols-2">
          {features.slice(3, 5).map((feature) => (
            <FeatureCard
              key={feature.title}
              title={feature.title}
              className="flex-1 min-w-full"
              description={feature.description}
              rive={feature.rive}
              imageAlt={feature.title}
              relative={feature.relative}
            />
          ))}
        </div>

        {/* First row - 3 features */}
        <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
          {features.slice(0, 3).map((feature) => (
            <FeatureCard
              key={feature.title}
              title={feature.title}
              description={feature.description}
              rive={feature.rive}
              imageAlt={feature.title}
              relative={feature.relative}
            />
          ))}
        </div>

        {/* Third row - 2 features */}
        <div className="grid grid-cols-1 gap-4 mx-auto w-full md:grid-cols-2">
          {features.slice(5, 7).map((feature) => (
            <FeatureCard
              key={feature.title}
              title={feature.title}
              description={feature.description}
              rive={feature.rive}
              imageAlt={feature.title}
              relative={feature.relative}
            />
          ))}
        </div>
      </div>

      <div className="mt-10">
        {/* View all features button */}
        <Button
          href="/features"
          variant="primary"
          size="lg"
          className="inline-flex"
        >
          View all features
        </Button>
      </div>
    </div>
  );
};

const FeatureCard = ({
  title,
  description,
  rive,
  relative,
  className,
}: {
  title: string;
  description: string;
  rive?: JSX.Element;
  img?: string;
  className?: string;
  imageAlt: string;
  imageClass?: string;
  relative?: {
    top?: number;
    bottom?: number;
    left?: number;
    right?: number;
  };
}) => {
  return (
    <div
      className={clsx(
        "flex flex-col gap-10 justify-evenly p-6 text-left rounded-xl border md:p-8 bg-gray-1 border-gray-5",
        className
      )}
    >
      <div
        style={{
          top: relative?.top,
          bottom: relative?.bottom,
          left: relative?.left,
          right: relative?.right,
        }}
        className="relative flex-1 flex-grow justify-center content-center"
      >
        {rive}
      </div>
      <div className="flex flex-col gap-2 justify-end h-fit">
        <h3 className="text-lg font-medium">{title}</h3>
        <p className="text-base text-gray-10">{description}</p>
      </div>
    </div>
  );
};

export default Features;
