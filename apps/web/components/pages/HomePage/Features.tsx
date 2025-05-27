import clsx from "clsx";


type Feature = {
  title: string;
  description: string;
  img: string;
  imageClass?: string;
};

const features: Feature[] = [
  {
    title: "Flexible Storage Options",
    img: "/illustrations/storageoptions.svg",
    imageClass: "w-full max-w-[340px]",
    description:
      "Choose how and where you store your recordings. Cap offers both local and cloud storage options to suit your needs. Save space on your device or keep your entire content library accessible from anywhere – ideal for freelancers and growing teams with varied content creation needs.",
  },
  {
    title: "Privacy-first",
    img: "/illustrations/privacyfirst.svg",
    description:
      "Own your content with Cap’s privacy-focused approach. Keep your sensitive information secure and maintain complete control over who can access your recordings – perfect for confidential client communications and internal team sharing.",
  },
  {
    title: "Seamless Team Collaboration",
    img: "/illustrations/teamcollab.svg",
    description:
      "Share knowledge effortlessly with your team or clients. Cap’s intuitive sharing features make it easy to organize content, provide access to specific people, and track engagement. Perfect for small businesses and growing teams who need simple yet powerful collaboration tools.",
  },
  {
    title: "Multi-Platform Support",
    img: "/illustrations/platformsupport.svg",
    description:
      "Cap works seamlessly across macOS and Windows, giving you the flexibility to create content on any device. Capture, share, and collaborate regardless of which platform you or your team prefers, ensuring smooth workflows and consistent experience everywhere.",
  },
  {
    title: "High-Quality Video Capture",
    img: "/illustrations/videocapture.svg",
    imageClass: "w-full max-w-[360px] mt-6",
    description:
      "Deliver crystal-clear recordings that showcase your professionalism. Cap ensures exceptional quality for client presentations, tutorials, and team communications – making your content stand out whether you’re a solo creator or a small business owner.",
  },
  {
    title: "Built for everyone",
    img: "/illustrations/everyone.svg",
    imageClass: "w-full max-w-[350px]",
    description:
      "For creators, teams, and educators alike, this screen recorder is designed to adapt to different needs and workflows—whether you’re capturing lessons, product demos, or quick updates. It’s a simple, customizable tool that makes screen recording accessible to everyone.",
  },
];

const Features = () => {
  return (
    <div className="text-center max-w-[1200px] mx-auto mb-8 px-5">
      <h2 className="mb-3">Crafted for simplicity</h2>
      <p className="text-lg leading-[1.75rem] w-full max-w-[800px] mx-auto">
        We believe great tools should make your life easier, not more
        complicated. Cap is crafted to streamline your workflow, so you can
        record, edit, and share without jumping through hoops.
      </p>
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2 mt-[52px]">
        {features.map((feature) => (
          <FeatureCard
            key={feature.title}
            title={feature.title}
            description={feature.description}
            imagePath={feature.img}
            imageAlt={feature.title}
            imageClass={feature.imageClass}
          />
        ))}
      </div>
    </div>
  );
};

const FeatureCard = ({
  title,
  description,
  imagePath,
  imageAlt,
  imageClass,
}: {
    title: string;
    description: string;
    imagePath: string;
    imageAlt: string;
    imageClass?: string;
}) => {
  return (
    <div className="flex flex-col gap-10 justify-between p-5 text-left rounded-xl border bg-gray-1 border-gray-5">
      <div className="flex-1 flex-grow justify-center content-center">
      <img src={imagePath} alt={imageAlt} className={clsx("m-auto",imageClass)} />
      </div>
      <div className="flex flex-col gap-2 justify-end h-fit">
      <h3 className="text-xl font-medium">{title}</h3>
      <p className="text-lg text-gray-10">{description}</p>
      </div>
    </div>
  );
};

export default Features;
