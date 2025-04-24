// million-ignore

"use client";

import { faXTwitter } from "@fortawesome/free-brands-svg-icons";
import { faHeart } from "@fortawesome/free-solid-svg-icons";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import Image from "next/image";
import Masonry, { ResponsiveMasonry } from "react-responsive-masonry";

// Fake testimonial data
const testimonials = [
  {
    name: "Steven Tey",
    xhandle: "Dub.co",
    image: "/testimonials/steven_tey.png",
    content:
      "Cap is one of my favorite pieces of software I've used in the recent years – best part is you get to own your data since they're fully open-source + via their S3 integration. Incredibly excited for this launch!",
    url: "https://www.producthunt.com/products/cap-3?comment=4174427#cap-4",
  },
  {
    name: "Guillermo Rauch",
    xhandle: "Vercel",
    image: "/testimonials/guillermo_rauch.png",
    content: "Congrats on shipping!",
    url: "https://www.producthunt.com/products/cap-3?comment=4174563#cap-4",
  },
  {
    name: "Livvux",
    xhandle: "@livvux",
    image: "/testimonials/livvux.png",
    content: "One of my favorite Open Source projects",
    url: "https://x.com/Livvux/status/1910227928056558042",
  },
  {
    name: "diana",
    xhandle: "@pixelswithin",
    image: "/testimonials/pixelswithin.png",
    content: "Self-hosted Loom. The future is awesome 👉🏽",
    url: "https://x.com/pixelswithin/status/1883344509121257704",
  },
  {
    name: "Azzam",
    xhandle: "@azrrow_s",
    image: "/testimonials/azrrow_s.png",
    content: "you can try http://cap.so, it's just better!",
    url: "https://x.com/azrrow_s/status/1863202543725121586",
  },
  {
    name: "Anuj Sharma",
    xhandle: "@waahbete",
    image: "/testimonials/waahbete.png",
    content:
      "Shoutout to @cap amazing screen recorder, go download it and star their repo",
    url: "https://x.com/waahbete/status/1845766742217306180",
  },
  {
    name: "Roger Mattos",
    xhandle: "@_rogermattos",
    image: "/testimonials/rogermattos.png",
    content:
      "Tip for people that need to make screen recordings: Cap is the open source alternative to Loom. Lightweight, powerful, and stunning. Record and share in seconds.",
    url: "https://x.com/_rogermattos/status/1844398522650722596",
  },
  {
    name: "Dozie",
    xhandle: "@dozibe",
    image: "/testimonials/dozibe.png",
    content: "Came at the right time. Cap.so was well needed.",
    url: "https://x.com/dozibe/status/1842653324635455914",
  },
  {
    name: "Bilal Budhani",
    xhandle: "@BilalBudhani",
    image: "/testimonials/BilalBudhani.png",
    content:
      "Tried @Cap v 0.3.beta and found an issue while exporting video.\n\nWrote to @richiemcilroy about the problem and ~40 mins later the issue is fixed.\n\nI'm sold. Checkout Cap.so",
    url: "https://x.com/BilalBudhani/status/1842198507756675104",
  },
  {
    name: "abdul🪐",
    xhandle: "@NerdyProgramme2",
    image: "/testimonials/NerdyProgramme2.png",
    content:
      "thanks for creating this @richiemcilroy. Cap is so good especially the zoom effects still playing around and figuring things out tho... you guys need to try it out @cap - an opensource alternative to loom",
    url: "https://x.com/NerdyProgramme2/status/1913593977124671956",
  },
  {
    name: "Greg_Ld",
    xhandle: "@Greg__LD",
    image: "/testimonials/Greg__LD.png",
    content:
      "No brainer instant purchase this morning: was looking for a solid screen recorder, for my new MacBook Pro,  gave @cap a try, got myself a license within 10 mins — flawless UX sometimes speaks louder than lengthy marketer's words !",
    url: "https://x.com/Greg__LD/status/1913515902139523366",
  },
  {
    name: "Jaisal Rathee",
    xhandle: "@RatheeJaisal",
    image: "/testimonials/RatheeJaisal.png",
    content: "Best dash I've ever seen 🤌",
    url: "https://x.com/RatheeJaisal/status/1913458774175604784",
  },
  {
    name: "Prayag",
    xhandle: "@prayagtushar",
    image: "/testimonials/prayagtushar.png",
    content:
      "I think I just found my go to screen recording app which is free @Cap",
    url: "https://x.com/prayagtushar/status/1910037657482113272",
  },
  {
    name: "Elie Steinbock",
    xhandle: "@elie2222",
    image: "/testimonials/elie2222.png",
    content: "Open source 💪",
    url: "https://x.com/elie2222/status/1909281075014119559",
  },
  {
    name: "Rohan",
    xhandle: "@rohannrk",
    image: "/testimonials/rohannrk.png",
    content: "Love the product using it regulary for sharing work updates.",
    url: "https://x.com/rohannrk/status/1909263024180904368",
  },
  {
    name: "JoséPablo*",
    xhandle: "@jdomito_",
    image: "/testimonials/jdomito_.png",
    content: "@Cap is actually way better than loom",
    url: "https://x.com/jdomito_/status/1900395567550742956",
  },
  {
    name: "Olivia",
    xhandle: "@olivialawson.co",
    image: "/testimonials/olivialawson.png",
    content:
      "I've been testing Cap.so for no other reason than some old habits die hard for this former software analyst. Whew that UI is so polished and crispy. Between the open source code, self hosted vids, editing features and price point -- gone give Loom some competition 🤞🏽",
    url: "https://www.threads.com/@olivialawson.co/post/DIj1kOfpPgX",
  },
  {
    name: "Minimal Nerd",
    xhandle: "@minimalnerd",
    image: "/testimonials/minimalnerd.png",
    content: "This is the Best Open-Source Loom alternative for Mac",
    url: "https://x.com/minimalnerd/status/1909263024180904368",
  },
  {
    name: "Tony Tong",
    xhandle: "muku.ai",
    image: "/testimonials/tony_tong.png",
    content: "Wow this is a beautiful product! Congratulations on the launch!",
    url: "https://www.producthunt.com/products/cap-3?comment=4179706#cap-4",
  },
  {
    name: "Geet Khosla",
    xhandle: "proem.ai",
    image: "/testimonials/geet_khosla.png",
    content: "I tried Cap sometime ago, great product - well executed.",
    url: "https://www.producthunt.com/products/cap-3?comment=4172443#cap-4",
  },
  {
    name: "Omar McAdam",
    xhandle: "UnInbox",
    image: "/testimonials/omar_mcadam.png",
    content:
      "Been following since the first announcement tweet Proud to say i've been a user since pre-beta, and can see the epic trajectory of this product",
    url: "https://www.producthunt.com/products/cap-3?comment=4174563#cap-4",
  },
  {
    name: "Hrushi",
    xhandle: "@BorhadeHrushi",
    image: "/testimonials/BorhadeHrushi.png",
    content:
      "hey @richiemcilroy , cap is hands down one of the best oss i've used, so much so i've uninstalled loom and screen studio  :)  can you please bring up the video cut and  playback speed adjust feature soon , can't wait to try it on, you guys are doing great cheers!",
    url: "https://x.com/BorhadeHrushi/status/1915477348549615816",
  },
  {
    name: "Cam Pak",
    xhandle: "",
    image: "/testimonials/campak.png",
    content: "Thank you for Cap!",
    url: "https://www.producthunt.com/products/cap-3?comment=4174238#cap-4",
  },
  {
    name: "Emeka Onu",
    xhandle: "Postly",
    image: "/testimonials/emekaonu.png",
    content:
      "Congratulations on the launch! I tried Cap some time ago, and it's such a great product.",
    url: "https://www.producthunt.com/products/cap-3?comment=4174570#cap-4",
  },
  {
    name: "Christopher Sybico",
    xhandle: "Holoholo App",
    image: "/testimonials/christophersybico.png",
    content: "Sold on owning your own data 👍",
    url: "https://www.producthunt.com/products/cap-3?comment=4175688#cap-4",
  },
  {
    name: "Rohith Gilla",
    xhandle: "@gillarohith",
    image: "/testimonials/gillarohith.png",
    content:
      "Used @cap. Holy smokes this product delivers and it delivers hard The whole experience from recording to the editor part is pretty sweet",
    url: "https://x.com/gillarohith/status/1843895676142530789",
  },
  {
    name: "CJ",
    xhandle: "@cjkihl",
    image: "/testimonials/cjkihl.png",
    content: "Such a great Open source project. I will never install OBS again",
    url: "https://x.com/cjkihl/status/1850367930464379226",
  },
];

export const TestimonialsPage = () => {
  return (
    <div className="py-20 wrapper wrapper-sm">
      <h1 className="text-4xl mt-10 text-center md:text-5xl tracking-[-.05em] font-medium text-[--text-primary]">
        We all{" "}
        <span>
          <FontAwesomeIcon
            icon={faHeart}
            className="mx-2 text-red-500 size-10"
          />
        </span>
        Cap
      </h1>

      <p className="mx-auto mt-4 max-w-2xl text-center text-gray-400">
        Don't just take our word for it. Here's what people are saying about
        their experience with Cap.
      </p>

      <ResponsiveMasonry
        columnsCountBreakPoints={{ 350: 1, 750: 2, 900: 3 }}
        gutterBreakpoints={{ 350: "12px", 750: "16px", 900: "24px" }}
        className="mt-12"
      >
        <Masonry gutter="24px">
          {testimonials.map((testimonial, i) => (
            <TestimonialCard key={i} testimonial={testimonial} />
          ))}
        </Masonry>
      </ResponsiveMasonry>
    </div>
  );
};

interface TestimonialCardProps {
  testimonial: {
    name: string;
    xhandle: string;
    image: string;
    content: string;
  };
}

const TestimonialCard = ({ testimonial }: TestimonialCardProps) => {
  return (
    <div className="p-6 bg-gray-100 rounded-xl border border-gray-200 h-full flex flex-col w-full">
      <div className="flex items-center mb-4">
        <div className="overflow-hidden relative mr-2 w-12 h-12 rounded-full border-2 border-gray-100">
          <Image
            src={testimonial.image}
            alt={testimonial.name}
            width={48}
            height={48}
            className="object-cover"
          />
        </div>
        <div>
          <h3 className="text-sm font-medium text-gray-900">
            {testimonial.name}
          </h3>
          <a
            href={`https://x.com/${testimonial.xhandle}`}
            target="_blank"
            rel="noopener noreferrer"
          >
            <div className="flex gap-0.5 items-center mt-1 duration-300 group cursor-pointer">
              <FontAwesomeIcon
                icon={faXTwitter}
                className="size-3.5 group-hover:text-blue-300 text-gray-500 transition-colors duration-200"
              />
              <p className="text-xs font-medium text-gray-500 transition-colors duration-200 group-hover:text-blue-300">
                {testimonial.xhandle}
              </p>
            </div>
          </a>
        </div>
      </div>

      <p className="text-sm text-gray-500 flex-grow">{testimonial.content}</p>
    </div>
  );
};
