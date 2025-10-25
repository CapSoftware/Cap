export default function cloudflareLoader({ src, width, quality }: {
  src: string;
  width: number;
  quality?: number;
}) {
  if (process.env.NODE_ENV === "development") {
    return src;
  }

  const normalizedSrc = src.startsWith("/") ? src.slice(1) : src;

  const params = [
    `width=${width}`,
    `quality=${quality || 75}`,
    "format=auto",
  ];

  return `/cdn-cgi/image/${params.join(",")}/${normalizedSrc}`;
}
