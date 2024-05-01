import Link from "next/link";
import Image from "next/image";
import { MDXRemote } from "next-mdx-remote/rsc";
import React from "react";
import { ReactNode } from "react";

interface TableData {
  headers: string[];
  rows: string[][];
}

function Table({ data }: { data: TableData }) {
  let headers = data.headers.map((header, index) => (
    <th key={index}>{header}</th>
  ));
  let rows = data.rows.map((row, index) => (
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

function slugify(str) {
  return str
    .toString()
    .toLowerCase()
    .trim() // Remove whitespace from both ends of a string
    .replace(/\s+/g, "-") // Replace spaces with -
    .replace(/&/g, "-and-") // Replace & with 'and'
    .replace(/[^\w\-]+/g, "") // Remove all non-word characters except for -
    .replace(/\-\-+/g, "-"); // Replace multiple - with single -
}

function createHeading(level) {
  return ({ children }) => {
    let slug = slugify(children);
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
      children
    );
  };
}

let components = {
  h1: createHeading(1),
  h2: createHeading(2),
  h3: createHeading(3),
  h4: createHeading(4),
  h5: createHeading(5),
  h6: createHeading(6),
  Image: RoundedImage,
  a: CustomLink,
  Callout,
  Table,
};

export function CustomMDX(props) {
  return (
    <MDXRemote
      {...props}
      components={{ ...components, ...(props.components || {}) }}
    />
  );
}
