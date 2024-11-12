export const seoMetadata = {
  'screen-recorder': {
    title: "Screen Recorder | Cap - Beautiful Screen Recording Software",
    description: "Cap is a powerful, user-friendly screen recorder that offers high-quality recordings completely free. Perfect for creating tutorials, capturing gameplay, or recording professional presentations.",
    keywords: ["screen recorder", "screen recording", "video capture", "free screen recorder"],
    ogImage: "/og/screen-recorder.png",
  },
  // Add more page metadata here
};

export const getMetadataBySlug = (slug: string) => seoMetadata[slug as keyof typeof seoMetadata]; 