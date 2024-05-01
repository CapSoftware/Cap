import Image from "next/image";
import { useMDXComponent } from "next-contentlayer2/hooks";

const mdxComponents = {
  Image,
};

interface MdxProps {
  code: string;
}

export function Mdx({ code }: MdxProps) {
  const MDXContent = useMDXComponent(code);

  return <MDXContent components={mdxComponents} />;
}
