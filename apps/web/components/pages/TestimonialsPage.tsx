"use client";

import Image from "next/image";

const testimonials = [
  {
    name: "Steven Tey",
    handle: "Dub.co",
    image: "/testimonials/steven_tey.png",
    content:
      "Cap is one of my favorite pieces of software I've used in the recent years – best part is you get to own your data since they're fully open-source + via their S3 integration. Incredibly excited for this launch!",
    url: "https://www.producthunt.com/products/cap-3?comment=4174427#cap-4",
  },
  {
    name: "Guillermo Rauch",
    handle: "Vercel",
    image: "/testimonials/guillermo_rauch.png",
    content: "Congrats on shipping!",
    url: "https://www.producthunt.com/products/cap-3?comment=4174563#cap-4",
  },
  {
    name: "Olivia",
    handle: "@olivialawson.co",
    image: "/testimonials/olivialawson.png",
    content:
      "I've been testing Cap.so for no other reason than some old habits die hard for this former software analyst. Whew that UI is so polished and crispy. Between the open source code, self hosted vids, editing features and price point -- gone give Loom some competition 🤞🏽",
    url: "https://www.threads.com/@olivialawson.co/post/DIj1kOfpPgX",
  },
  {
    name: "Livvux",
    handle: "@livvux",
    image: "/testimonials/livvux.png",
    content: "One of my favorite Open Source projects",
    url: "https://x.com/Livvux/status/1910227928056558042",
  },
  {
    name: "Roger Mattos",
    handle: "@_rogermattos",
    image: "/testimonials/_rogermattos.png",
    content:
      "Tip for people that need to make screen recordings: Cap is the open source alternative to Loom. Lightweight, powerful, and stunning. Record and share in seconds.",
    url: "https://x.com/_rogermattos/status/1844398522650722596",
  },
  {
    name: "Greg_Ld",
    handle: "@Greg__LD",
    image: "/testimonials/Greg__LD.png",
    content:
      "No brainer instant purchase this morning: was looking for a solid screen recorder, for my new MacBook Pro,  gave @cap a try, got myself a license within 10 mins — flawless UX sometimes speaks louder than lengthy marketer's words !",
    url: "https://x.com/Greg__LD/status/1913515902139523366",
  },
  {
    name: "JoséPablo*",
    handle: "@jdomito_",
    image: "/testimonials/jdomito_.png",
    content: "@Cap is actually way better than loom",
    url: "https://x.com/jdomito_/status/1900395567550742956",
  },
  {
    name: "CJ",
    handle: "@cjkihl",
    image: "/testimonials/cjkihl.png",
    content: "Such a great Open source project. I will never install OBS again",
    url: "https://x.com/cjkihl/status/1850367930464379226",
  },
  {
    name: "Rohith Gilla",
    handle: "@gillarohith",
    image: "/testimonials/gillarohith.png",
    content:
      "Used @cap. Holy smokes this product delivers and it delivers hard The whole experience from recording to the editor part is pretty sweet",
    url: "https://x.com/gillarohith/status/1843895676142530789",
  },
  {
    name: "Bilal Budhani",
    handle: "@BilalBudhani",
    image: "/testimonials/BilalBudhani.png",
    content:
      "Tried @Cap v 0.3.beta and found an issue while exporting video.\n\nWrote to @richiemcilroy about the problem and ~40 mins later the issue is fixed.\n\nI'm sold. Checkout Cap.so",
    url: "https://x.com/BilalBudhani/status/1842198507756675104",
  },
  {
    name: "Hrushi",
    handle: "@BorhadeHrushi",
    image: "/testimonials/BorhadeHrushi.png",
    content:
      "hey @richiemcilroy , cap is hands down one of the best oss i've used, so much so i've uninstalled loom and screen studio  :)  can you please bring up the video cut and  playback speed adjust feature soon , can't wait to try it on, you guys are doing great cheers!",
    url: "https://x.com/BorhadeHrushi/status/1915477348549615816",
  },
  {
    name: "Minimal Nerd",
    handle: "@minimalnerd",
    image: "/testimonials/minimalnerd.png",
    content: "This is the Best Open-Source Loom alternative for Mac",
    url: "https://x.com/minimalnerd/status/1909263024180904368",
  },
  {
    name: "Prayag",
    handle: "@prayagtushar",
    image: "/testimonials/prayagtushar.png",
    content:
      "I think I just found my go to screen recording app which is free @Cap",
    url: "https://x.com/prayagtushar/status/1910037657482113272",
  },
  {
    name: "Omar McAdam",
    handle: "UnInbox",
    image: "/testimonials/omar_mcadam.png",
    content:
      "Been following since the first announcement tweet Proud to say i've been a user since pre-beta, and can see the epic trajectory of this product",
    url: "https://www.producthunt.com/products/cap-3?comment=4174563#cap-4",
  },
  {
    name: "Emeka Onu",
    handle: "Postly",
    image: "/testimonials/emekaonu.png",
    content:
      "Congratulations on the launch! I tried Cap some time ago, and it's such a great product.",
    url: "https://www.producthunt.com/products/cap-3?comment=4174570#cap-4",
  },
  {
    name: "Tony Tong",
    handle: "muku.ai",
    image: "/testimonials/tony_tong.png",
    content: "Wow this is a beautiful product! Congratulations on the launch!",
    url: "https://www.producthunt.com/products/cap-3?comment=4179706#cap-4",
  },
  {
    name: "Geet Khosla",
    handle: "proem.ai",
    image: "/testimonials/geet_khosla.png",
    content: "I tried Cap sometime ago, great product - well executed.",
    url: "https://www.producthunt.com/products/cap-3?comment=4172443#cap-4",
  },
  {
    name: "diana",
    handle: "@pixelswithin",
    image: "/testimonials/pixelswithin.png",
    content: "Self-hosted Loom. The future is awesome 👉🏽",
    url: "https://x.com/pixelswithin/status/1883344509121257704",
  },
  {
    name: "Dozie",
    handle: "@dozibe",
    image: "/testimonials/dozibe.png",
    content: "Came at the right time. Cap.so was well needed.",
    url: "https://x.com/dozibe/status/1842653324635455914",
  },
  {
    name: "Azzam",
    handle: "@azrrow_s",
    image: "/testimonials/azrrow_s.png",
    content: "you can try http://cap.so, it's just better!",
    url: "https://x.com/azrrow_s/status/1863202543725121586",
  },
  {
    name: "Jaisal Rathee",
    handle: "@RatheeJaisal",
    image: "/testimonials/RatheeJaisal.png",
    content: "Best dash I've ever seen 🤌",
    url: "https://x.com/RatheeJaisal/status/1913458774175604784",
  },
  {
    name: "Elie Steinbock",
    handle: "@elie2222",
    image: "/testimonials/elie2222.png",
    content: "Open source 💪",
    url: "https://x.com/elie2222/status/1909281075014119559",
  },
  {
    name: "Rohan",
    handle: "@rohannrk",
    image: "/testimonials/rohannrk.png",
    content: "Love the product using it regulary for sharing work updates.",
    url: "https://x.com/rohannrk/status/1909263024180904368",
  },
  {
    name: "abdul🪐",
    handle: "@NerdyProgramme2",
    image: "/testimonials/NerdyProgramme2.png",
    content:
      "thanks for creating this @richiemcilroy. Cap is so good especially the zoom effects still playing around and figuring things out tho... you guys need to try it out @cap - an opensource alternative to loom",
    url: "https://x.com/NerdyProgramme2/status/1913593977124671956",
  },
  {
    name: "Christopher Sybico",
    handle: "Holoholo App",
    image: "/testimonials/christophersybico.png",
    content: "Sold on owning your own data 👍",
    url: "https://www.producthunt.com/products/cap-3?comment=4175688#cap-4",
  },
  {
    name: "Cam Pak",
    handle: "",
    image: "/testimonials/campak.png",
    content: "Thank you for Cap!",
    url: "https://www.producthunt.com/products/cap-3?comment=4174238#cap-4",
  },
];

export const TestimonialsPage = () => {
  return (
    <div className="py-20 wrapper wrapper-sm">
      <h1 className="text-4xl mt-10 text-center md:text-5xl tracking-[-.05em] font-medium text-[--text-primary]">
        What our users say about Cap after hitting record
      </h1>

      <p className="mx-auto mt-4 max-w-2xl text-center text-gray-400">
        Don't just take our word for it. Here's what our users are saying about
        their experience with Cap.
      </p>

      <div className="mt-12 columns-1 md:columns-2 lg:columns-3 gap-3 space-y-3">
        {testimonials.map((testimonial, i) => (
          <div key={i} className="break-inside-avoid mb-3">
            <TestimonialCard testimonial={testimonial} />
          </div>
        ))}
      </div>
    </div>
  );
};

interface TestimonialCardProps {
  testimonial: {
    name: string;
    handle: string;
    image: string;
    content: string;
    url: string;
  };
}

const TestimonialCard = ({ testimonial }: TestimonialCardProps) => {
  return (
    <a
      href={testimonial.url}
      target="_blank"
      rel="noopener noreferrer"
      className="p-6 bg-gray-100 rounded-xl border border-gray-200 w-full h-auto hover:scale-[1.015] hover:border-gray-400 hover:shadow-lg transition-all duration-300 cursor-pointer block"
    >
      <div className="flex items-center mb-4">
        <div className="overflow-hidden relative mr-2 w-12 h-12 rounded-full border-2 border-gray-100">
          <Image
            src={testimonial.image}
            alt={testimonial.name}
            width={48}
            height={48}
            className="object-cover"
            loading="lazy"
          />
        </div>
        <div>
          <h3 className="text-sm font-medium text-gray-900">
            {testimonial.name}
          </h3>
          <p className="text-sm font-medium text-gray-400 transition-colors duration-200">
            {testimonial.handle}
          </p>
        </div>
      </div>

      <p className="text-gray-500">{testimonial.content}</p>
    </a>
  );
};
