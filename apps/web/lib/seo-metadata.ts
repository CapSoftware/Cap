export const seoMetadata = {
  "screen-recorder": {
    title: "Screen Recorder | OPAVC - Beautiful Screen Recording Software",
    description:
      "OPAVC is a powerful, user-friendly screen recorder that offers high-quality recordings completely free. Perfect for creating tutorials, capturing gameplay, or recording professional presentations.",
    keywords: [
      "screen recorder",
      "video capture",
      "screen recording software",
      "free screen recorder",
    ],
    ogImage: "/og.png",
  },
  "screen-recorder-mac": {
    title: "Screen Record on Mac | OPAVC - Best Screen Recorder for macOS",
    description:
      "OPAVC is a powerful, user-friendly screen recorder for Mac, offering high-quality video capture with seamless functionality. Perfect for creating tutorials, presentations, and educational content on macOS.",
    keywords: [
      "mac screen recorder",
      "macos screen capture",
      "screen recording mac",
      "screen capture mac",
    ],
    ogImage: "/og.png",
  },
  "screen-recorder-windows": {
    title: "Screen Record on Windows | OPAVC - Best Screen Recorder for Windows",
    description:
      "OPAVC is a powerful, user-friendly screen recorder for Windows, offering high-quality video capture with seamless functionality. Perfect for creating tutorials, presentations, and educational content on Windows.",
    keywords: [
      "windows screen recorder",
      "windows screen capture",
      "screen recording windows",
      "screen capture windows",
    ],
    ogImage: "/og.png",
  },
  "free-screen-recorder": {
    title: "Free Screen Recorder | OPAVC - High-Quality Recording at No Cost",
    description:
      "OPAVC offers a top-rated, free screen recorder with high-quality video capture, making it perfect for creating tutorials, educational content, and professional demos without any hidden fees.",
    keywords: [
      "free screen recorder",
      "free video capture",
      "free screen recording",
      "no cost screen recorder",
    ],
    ogImage: "/og.png",
  },
  "screen-recording-software": {
    title: "Screen Recording Software | OPAVC - Professional Video Capture Tool",
    description:
      "OPAVC is an all-in-one screen recording software offering high-quality video capture with an intuitive interface. Ideal for creating tutorials, presentations, and educational content.",
    keywords: [
      "screen recording software",
      "video capture software",
      "screen capture tool",
      "professional screen recorder",
    ],
    ogImage: "/og.png",
  },
};

export const getMetadataBySlug = (slug: string) =>
  seoMetadata[slug as keyof typeof seoMetadata];
