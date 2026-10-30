import { readFileSync } from "node:fs";
import { join } from "node:path";
import React from "react";
import { describe, expect, it } from "vitest";
import { CapPagination } from "@/app/(org)/dashboard/caps/components/CapPagination";
import {
	Pagination,
	PaginationContent,
	PaginationItem,
	PaginationLink,
	PaginationNext,
	PaginationPrevious,
} from "@cap/ui";

describe("CapPagination and Client Navigation (Issue #2305)", () => {
	it("verifies CapPagination imports Link from next/link and passes asChild", () => {
		const filePath = join(
			process.cwd(),
			"app/(org)/dashboard/caps/components/CapPagination.tsx",
		);
		const content = readFileSync(filePath, "utf-8");

		expect(content).toContain('import Link from "next/link";');
		expect(content).toContain("asChild");
		expect(content).toContain("scroll={false}");
	});

	it("verifies @cap/ui Pagination.tsx supports asChild via Radix Slot", () => {
		const filePath = join(
			process.cwd(),
			"../../packages/ui/src/components/Pagination.tsx",
		);
		const content = readFileSync(filePath, "utf-8");

		expect(content).toContain('import { Slot } from "@radix-ui/react-slot";');
		expect(content).toContain("asChild?: boolean;");
		expect(content).toContain('const Comp = asChild ? Slot : "a";');
	});

	it("renders client Link elements inside PaginationPrevious, PaginationLink, and PaginationNext", () => {
		const element = CapPagination({
			currentPage: 2,
			totalPages: 5,
		}) as React.ReactElement<{ children: React.ReactElement<{ children: React.ReactNode[] }> }>;

		expect(element).toBeDefined();
		expect(element.type).toBe(Pagination);

		const content = element.props.children;
		expect(content.type).toBe(PaginationContent);

		const items = React.Children.toArray(content.props.children) as React.ReactElement[];
		expect(items.length).toBeGreaterThan(0);

		// First item should be PaginationPrevious with asChild
		const prevItem = items[0].props.children as React.ReactElement<{ asChild?: boolean; children: React.ReactElement<{ href: string; scroll: boolean }> }>;
		expect(prevItem.type).toBe(PaginationPrevious);
		expect(prevItem.props.asChild).toBe(true);
		expect(prevItem.props.children.props.href).toBe("/dashboard/caps?page=1");
		expect(prevItem.props.children.props.scroll).toBe(false);

		// Last item should be PaginationNext with asChild
		const nextItem = items[items.length - 1].props.children as React.ReactElement<{ asChild?: boolean; children: React.ReactElement<{ href: string; scroll: boolean }> }>;
		expect(nextItem.type).toBe(PaginationNext);
		expect(nextItem.props.asChild).toBe(true);
		expect(nextItem.props.children.props.href).toBe("/dashboard/caps?page=3");
		expect(nextItem.props.children.props.scroll).toBe(false);
	});

	it("respects custom hrefForPage generator with client navigation", () => {
		const customHref = (page: number) => `/custom/route?p=${page}`;
		const element = CapPagination({
			currentPage: 1,
			totalPages: 3,
			hrefForPage: customHref,
		}) as React.ReactElement<{ children: React.ReactElement<{ children: React.ReactNode[] }> }>;

		const content = element.props.children;
		const items = React.Children.toArray(content.props.children) as React.ReactElement[];

		// On page 1, first link is page 1 (no Previous)
		const firstLink = items[0].props.children as React.ReactElement<{ asChild?: boolean; children: React.ReactElement<{ href: string; scroll: boolean }> }>;
		expect(firstLink.type).toBe(PaginationLink);
		expect(firstLink.props.asChild).toBe(true);
		expect(firstLink.props.children.props.href).toBe("/custom/route?p=1");
		expect(firstLink.props.children.props.scroll).toBe(false);
	});
});
