import Image from "next/image";
import { MDXRemote } from "next-mdx-remote/rsc";

const mdxComponents = {
	Image,
};

interface MdxProps {
	source: string;
}

// Updated to use next-mdx-remote/rsc for React 19 and Next.js 14 compatibility
export function Mdx({ source }: MdxProps) {
	return <MDXRemote source={source} components={mdxComponents} />;
}
