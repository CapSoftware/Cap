import Image from "next/image";
import Link from "next/link";
import { MDXRemote } from "next-mdx-remote/rsc";
import React, { type ReactNode } from "react";

interface TableData {
	headers: string[];
	rows: string[][];
}

function Table({ data }: { data: TableData }) {
	const headers = data.headers.map((header, index) => (
		<th key={index}>{header}</th>
	));
	const rows = data.rows.map((row, index) => (
		<tr key={index}>
			{row.map((cell, cellIndex) => (
				<td key={cellIndex}>{cell}</td>
			))}
		</tr>
	));

	return (
		<table>
			<thead>
				<tr>{headers}</tr>
			</thead>
			<tbody>{rows}</tbody>
		</table>
	);
}

interface CustomLinkProps {
	href: string;
	[key: string]: any;
}

function CustomLink({ href, ...rest }: CustomLinkProps) {
	if (href.startsWith("/")) {
		return (
			<Link href={href} {...rest}>
				{rest.children}
			</Link>
		);
	}

	if (href.startsWith("#")) {
		return <a {...rest} />;
	}

	return <a target="_blank" rel="noopener noreferrer" {...rest} />;
}

interface RoundedImageProps {
	src: string;
	alt: string;
	[key: string]: any;
}

function RoundedImage(props: RoundedImageProps) {
	return <Image src={props.src} alt={props.alt} className="rounded-lg" />;
}

interface CalloutProps {
	emoji: string;
	children: ReactNode;
}

function Callout(props: CalloutProps) {
	return (
		<div className="px-4 py-3 border border-neutral-200 bg-neutral-50 rounded p-1 text-sm flex items-center text-neutral-900 mb-8">
			<div className="flex items-center w-4 mr-4">{props.emoji}</div>
			<div className="w-full callout">{props.children}</div>
		</div>
	);
}

interface WarningProps {
	title?: string;
	children: ReactNode;
}

function Warning(props: WarningProps) {
	return (
		<div className="px-4 py-3 border-2 border-red-300 bg-red-50 rounded-lg text-sm mb-8 dark:bg-red-950 dark:border-red-800">
			<div className="flex items-center gap-2 font-semibold text-red-700 dark:text-red-400 mb-2">
				<svg
					xmlns="http://www.w3.org/2000/svg"
					viewBox="0 0 20 20"
					fill="currentColor"
					className="w-5 h-5"
				>
					<path
						fillRule="evenodd"
						d="M8.485 2.495c.673-1.167 2.357-1.167 3.03 0l6.28 10.875c.673 1.167-.17 2.625-1.516 2.625H3.72c-1.347 0-2.189-1.458-1.515-2.625L8.485 2.495zM10 5a.75.75 0 01.75.75v3.5a.75.75 0 01-1.5 0v-3.5A.75.75 0 0110 5zm0 9a1 1 0 100-2 1 1 0 000 2z"
						clipRule="evenodd"
					/>
				</svg>
				{props.title || "Warning"}
			</div>
			<div className="text-red-700 dark:text-red-300 [&>p]:m-0 [&>ul]:m-0 [&>ul]:mt-2">
				{props.children}
			</div>
		</div>
	);
}

function slugify(str: string) {
	return str
		.toString()
		.toLowerCase()
		.trim() // Remove whitespace from both ends of a string
		.replace(/\s+/g, "-") // Replace spaces with -
		.replace(/&/g, "-and-") // Replace & with 'and'
		.replace(/[^\w-]+/g, "") // Remove all non-word characters except for -
		.replace(/--+/g, "-"); // Replace multiple - with single -
}

function createHeading(level: number) {
	return ({ children }: { children: string }) => {
		const slug = slugify(children);
		return React.createElement(
			`h${level}`,
			{ id: slug },
			[
				React.createElement("a", {
					href: `#${slug}`,
					key: `link-${slug}`,
					className: "anchor",
				}),
			],
			children,
		);
	};
}

const components = {
	h1: createHeading(1),
	h2: createHeading(2),
	h3: createHeading(3),
	h4: createHeading(4),
	h5: createHeading(5),
	h6: createHeading(6),
	Image: RoundedImage,
	a: CustomLink,
	Callout,
	Warning,
	Table,
};

export function CustomMDX(props: any) {
	return (
		<MDXRemote
			{...props}
			components={{ ...components, ...(props.components || {}) }}
		/>
	);
}
