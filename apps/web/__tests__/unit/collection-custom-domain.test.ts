import {
	Organisation,
	PublicCollection as PublicCollectionDomain,
} from "@cap/web-domain";
import { beforeEach, describe, expect, it, vi } from "vitest";
import PublicCollectionPage, { generateMetadata } from "@/app/c/[id]/page";
import type {
	PublicCollection,
	PublicCollectionPageData,
} from "@/lib/public-collections";

const mocks = vi.hoisted(() => ({
	host: "videos.customer.example",
	organizations: [] as { id: string; domainVerified: Date | null }[],
	lookup: vi.fn(),
	collection: null as PublicCollection | null,
	pageData: vi.fn<() => Promise<PublicCollectionPageData | null>>(),
}));

vi.mock("@cap/database", () => ({
	db: () => ({
		select: () => ({
			from: () => ({
				where: () => ({
					limit: () => {
						mocks.lookup();
						return Promise.resolve(mocks.organizations);
					},
				}),
			}),
		}),
	}),
}));
vi.mock("@cap/env", () => ({
	buildEnv: { NEXT_PUBLIC_WEB_URL: "https://cap.so" },
	serverEnv: () => ({ WEB_URL: "https://cap.so" }),
}));
vi.mock("@/lib/cap-analytics-access", () => ({
	videoBelongsToOrganization: vi.fn(),
}));
vi.mock("next/headers", () => ({
	headers: async () => new Headers({ host: mocks.host }),
}));
vi.mock("next/navigation", () => ({
	notFound: () => {
		throw new Error("NOT_FOUND");
	},
	redirect: (url: string) => {
		throw new Error(`REDIRECT ${url}`);
	},
}));
vi.mock("@/lib/public-collections", () => ({
	getPublicCollectionMetadata: async () => mocks.collection,
	getPublicCollectionPageData: mocks.pageData,
}));
vi.mock("@cap/ui", () => ({ Logo: () => null, buttonVariants: () => "" }));
vi.mock("@/components/PublicCapCard", () => ({ PublicCapCard: () => null }));
vi.mock("@/app/c/[id]/CollectionCopyLinkButton", () => ({
	CollectionCopyLinkButton: () => null,
}));
vi.mock("@/app/c/[id]/CollectionPasswordOverlay", () => ({
	CollectionPasswordOverlay: () => null,
}));
vi.mock("@/app/(org)/dashboard/caps/components/CapPagination", () => ({
	CapPagination: () => null,
}));

const props = () => ({
	params: Promise.resolve({ id: mocks.collection?.id ?? "missing" }),
	searchParams: Promise.resolve({ page: "2", tag: ["a", "b"] }),
});

beforeEach(() => {
	mocks.host = "videos.customer.example";
	mocks.organizations = [{ id: "domain-org", domainVerified: new Date() }];
	mocks.collection = {
		id: "collection-id",
		kind: "folder",
		name: "Public collection",
		color: null,
		description: null,
		spaceId: null,
		organizationId: Organisation.OrganisationId.make("other-org"),
		organizationName: "Other organization",
		allowedEmailDomain: null,
		passwordHash: null,
		publicPage: PublicCollectionDomain.resolvePublicPageSettings(null),
		organizationIconUrl: null,
		collectionLogoUrl: null,
	};
	mocks.pageData.mockImplementation(async () =>
		mocks.collection
			? {
					collection: mocks.collection,
					access: { state: "allowed" },
					folders: [],
					videos: [],
					currentPage: 2,
					totalCount: 0,
					totalPages: 0,
					viewerIsSignedIn: false,
				}
			: null,
	);
});

describe.each([
	["page", PublicCollectionPage],
	["metadata", generateMetadata],
] as const)("collection custom domain %s", (_name, load) => {
	it.each(["folder", "space"] as const)(
		"redirects a foreign %s before rendering its content",
		async (kind) => {
			if (!mocks.collection) throw new Error("Missing fixture");
			mocks.collection.kind = kind;
			await expect(load(props())).rejects.toThrow(
				"REDIRECT https://cap.so/c/collection-id?page=2&tag=a&tag=b",
			);
			expect(mocks.pageData).not.toHaveBeenCalled();
		},
	);

	it("keeps the domain organization's collection on its host", async () => {
		if (!mocks.collection) throw new Error("Missing fixture");
		mocks.collection.organizationId =
			Organisation.OrganisationId.make("domain-org");
		await expect(load(props())).resolves.toBeTruthy();
	});

	it.each(["cap.so", "cap.link", "localhost:3000"])(
		"serves collections on %s without a domain lookup",
		async (host) => {
			mocks.host = host;
			await expect(load(props())).resolves.toBeTruthy();
			expect(mocks.lookup).not.toHaveBeenCalled();
		},
	);

	it.each([
		["an unknown host", []],
		["an unverified host", [{ id: "domain-org", domainVerified: null }]],
	] as const)("leaves %s to the proxy", async (_label, organizations) => {
		mocks.organizations = [...organizations];
		await expect(load(props())).resolves.toBeTruthy();
	});

	it("keeps missing collections as not found", async () => {
		mocks.collection = null;
		await expect(load(props())).rejects.toThrow("NOT_FOUND");
	});
});
