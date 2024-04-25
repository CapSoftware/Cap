"use client";

const faqContent = [
  {
    title: "What is Cap?",
    answer:
      "Cap is an open source alternative to Loom. It's a video messaging tool that allows you to record, edit and share videos in seconds.",
  },
  {
    title: "How do I use it?",
    answer:
      "Simply download the Cap macOS app (or the Cap web app), and start recording. You can record your screen, your camera, or both at once. After your recording finishes, you will receive your shareable Cap link to share with anyone.",
  },
  {
    title: "Who is it for?",
    answer:
      "Cap is for anyone who wants to record and share videos. It's a great tool for creators, educators, marketers, and anyone who wants to communicate more effectively.",
  },
  {
    title: "How much does it cost?",
    answer:
      "Cap is free to use. However, you can upgrade to Cap Pro for just $9/month and unlock unlimited recordings, unlimited recording length, and much more.",
  },
  {
    title: "What makes you different to Loom?",
    answer:
      "Apart from being open source and privacy focused, Cap is also a lot more lightweight and faster to use. We also focus strongly on design and user experience, and our community is at the heart of everything we do.",
  },
];

export const FaqPage = () => {
  return (
    <div className="wrapper wrapper-sm py-20">
      <div className="text-center page-intro mb-14">
        <h1>FAQ</h1>
      </div>
      <div className="mb-10">
        {faqContent.map((section, index) => {
          return (
            <div key={index} className="max-w-2xl mx-auto my-8">
              <h2 className="text-xl mb-2">{section.title}</h2>
              <p className="text-lg">{section.answer}</p>
            </div>
          );
        })}
      </div>
    </div>
  );
};
