const faqContent = [
  {
    title: "What is Cap?",
    answer:
      "Cap is an open source and privacy focused alternative to Loom. It's a video messaging tool that allows you to record, edit and share videos in seconds.",
  },
  {
    title: "How do I use it?",
    answer:
      "Cap is currently in development. You can follow along live either via Twitter (X), our growing Discord community, or over on the Cap GitHub repository.",
  },
  {
    title: "Who is it for?",
    answer:
      "Cap is for anyone who wants to record and share videos. It's a great tool for creators, educators, marketers, and anyone who wants to communicate more effectively.",
  },
  {
    title: "How much does it cost?",
    answer:
      "Cap is free to use. We will also offer a paid plan for teams and larger organisations.",
  },
  {
    title: "What makes you different to Loom?",
    answer:
      "Apart from being open source and privacy focused, Cap is also a lot more lightweight and faster to use. We also focus strongly on design and user experience.",
  },
  {
    title: "When will v1.0.0 launch?",
    answer:
      "We're aiming to launch v1.0.0 by Q1 2024, if not sooner. However, there'll be regular Alpha builds available to download on our GitHub before then.",
  },
];

export const FaqPage = () => {
  return (
    <div className="wrapper wrapper-sm py-20">
      <div className="text-center page-intro mb-14">
        <h1>FAQ</h1>
      </div>
      <div className="space-y-8 mb-10">
        {faqContent.map((section, index) => {
          return (
            <div key={index} className="max-w-2xl mx-auto">
              <h2 className="text-xl mb-2">{section.title}</h2>
              <p className="text-lg">{section.answer}</p>
            </div>
          );
        })}
      </div>
    </div>
  );
};
