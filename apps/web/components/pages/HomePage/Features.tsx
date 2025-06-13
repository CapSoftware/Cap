import { classNames } from "@cap/utils";
import { Fit, Layout, useRive } from "@rive-app/react-canvas";
import clsx from "clsx";
import { memo } from "react";

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
  return <EveryoneRive className="w-full max-w-[500px] mx-auto h-[250px]" />;
});

const features: Feature[] = [
  {
    title: "Flexible Storage Options",
    rive: <StorageOptionsArt />,
    relative: {
      top: 25,
    },
    description:
      "Choose how and where you store your recordings. Cap offers both local and cloud storage options to suit your needs. Save space on your device or keep your entire content library accessible from anywhere – ideal for freelancers and growing teams.",
  },
  {
    title: "Privacy-first",
    rive: <PrivacyFirstArt />,
    description:
      "Own your content with Cap’s privacy-focused approach. Keep your sensitive information secure and maintain complete control over who can access your recordings – perfect for confidential client communications and internal team sharing.",
  },
  {
    title: "Seamless Team Collaboration",
    rive: <CollabArt />,
    description:
      "Share knowledge effortlessly with your team or clients. Cap’s intuitive sharing features make it easy to organize content, provide access to specific people, and track engagement. Perfect for small businesses and growing teams who need simple yet powerful collaboration tools.",
  },
  {
    title: "Multi-Platform Support",
    rive: <PlatformSupportArt />,
    description:
      "Cap works seamlessly across macOS and Windows, giving you the flexibility to create content on any device. Capture, share, and collaborate regardless of which platform you or your team prefers, ensuring smooth workflows and consistent experience everywhere.",
  },
  {
    title: "High-Quality Video Capture",
    rive: <VideoCaptureArt />,
    description:
      "Deliver crystal-clear recordings that showcase your professionalism. Cap ensures exceptional quality for client presentations, tutorials, and team communications – making your content stand out whether you’re a solo creator or a small business owner.",
  },
  {
    title: "Built for everyone",
    rive: <EveryoneArt />,
    description:
      "For creators, teams, and educators alike, this screen recorder is designed to adapt to different needs and workflows—whether you’re capturing lessons, product demos, or quick updates. It’s a simple, customizable tool that makes screen recording accessible to everyone.",
  },
  {
    title: "Cap AI",
    rive: undefined,
    description:
      "Cap AI is a powerful tool that uses advanced AI to help you create better content. With features like automatic transcription, video editing, and content optimization, Cap AI makes it easy to create engaging and effective content for your audience.",
  },
];

const Features = () => {
  return (
    <div className="text-center max-w-[1440px] mx-auto mb-8 px-5">
      <h2 className="mb-3">Crafted for simplicity</h2>
      <p className="text-lg leading-[1.75rem] w-full max-w-[800px] mx-auto">
        We believe great tools should make your life easier, not more
        complicated. Cap is crafted to streamline your workflow, so you can
        record, edit, and share without jumping through hoops.
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
