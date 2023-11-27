const roadmapContent = [
  {
    title: "Complete",
    items: [
      {
        title: "Basic recording functionality",
        description:
          "Choose webcam video and audio source, and choose between recording the entire screen or a specific application window.",
      },
    ],
  },
  {
    title: "In progress",
    items: [
      {
        title: "Editing and trimming",
        description:
          "Trim sections of your recording. Move and resize your webcam video. Add padding / gradients to the video background.",
      },
      {
        title: "Sharing",
        description:
          "Share your recording via a unique cookieless link. Share to Twitter, Discord, Slack, and more.",
      },
    ],
  },
  {
    title: "Backlog (for v1.0.0 / MVP)",
    items: [
      {
        title: "Basic analytics",
        description:
          "See how many views your recording has received, and where they came from.",
      },
      {
        title: "More recording features",
        description: "Choose exact dimensions for your recording windiow.",
      },
      {
        title: "Dynamically change video size",
        description:
          "Change the dimensions of your video after recording for different platforms, e.g. Twitter, YouTube, TikTok, etc.",
      },
      {
        title: "Comments on shared recordings",
        description:
          "Receive comments/reactions on your shared recordings, and reply to them.",
      },
      {
        title: "Video export types",
        description:
          "Export your recording as a GIF, MP4, or WebM, etc. Choose the quality of the export.",
      },
      {
        title: "Basic team spaces",
        description:
          "Create a team space and invite your team members to crate a shared library of recordings.",
      },
    ],
  },
  {
    title: "Future features",
    items: [
      {
        title: "More advanced analytics",
        description: "Different types of analytics, e.g. average watch time.",
      },
      {
        title: "Editing templates",
        description:
          "Create templates for your recordings, e.g. platform specific templates.",
      },
      {
        title: "Video recording filters",
        description:
          "Add filters to your recordings, such as a blurred background, green screen",
      },
    ],
  },
];

export const RoadmapPage = () => {
  return (
    <div className="wrapper wrapper-sm py-20">
      <div className="text-center page-intro mb-14">
        <h1>Roadmap</h1>
      </div>
      <div className="space-y-6 mb-10">
        {roadmapContent.map((section, index) => {
          return (
            <div key={index}>
              <h2 className="text-xl mb-2 underline">{section.title}</h2>
              <ul className="space-y-3">
                {section.items.map((item, index) => {
                  return (
                    <li className="text-lg">
                      <p>
                        <strong>{item.title} - </strong>
                        {item.description}
                      </p>
                    </li>
                  );
                })}
              </ul>
            </div>
          );
        })}
      </div>
      <p>
        Have a feature idea? Join the Cap{" "}
        <a
          href="https://discord.gg/y8gdQ3WRN3"
          className="font-semibold underline"
        >
          Discord community
        </a>{" "}
        and let us know!
      </p>
    </div>
  );
};
