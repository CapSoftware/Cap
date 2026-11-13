// @vitest-environment jsdom

import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	search: "",
	marker: (name: string) => () => `[${name}]`,
}));

vi.mock("next/navigation", () => ({
	usePathname: () => "/dashboard/spaces/space-1",
	useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
	useSearchParams: () => new URLSearchParams(mocks.search),
}));
vi.mock("@cap/ui", () => ({ Button: () => null }));
vi.mock("@/components/FontAwesomeIcon", () => ({
	FontAwesomeIcon: () => null,
}));
vi.mock("@/components/VideoThumbnail", () => ({
	SeededThumbnailsProvider: ({ children }: { children: React.ReactNode }) =>
		React.createElement(React.Fragment, null, children),
}));
vi.mock("@/lib/Queries/Analytics", () => ({
	useVideosAnalyticsQuery: () => ({ data: {}, isLoading: false }),
}));
vi.mock("@/app/(org)/dashboard/Contexts", () => ({
	useDashboardContext: () => ({
		activeOrganization: {
			organization: { id: "org-1", name: "Org", ownerId: "owner-1" },
			ownerIsPro: true,
		},
	}),
}));
vi.mock("@/app/(org)/dashboard/_components/CollectionShareControl", () => ({
	CollectionShareControl: () => null,
}));
vi.mock("@/app/(org)/dashboard/_components/Navbar/SpaceDialog", () => ({
	default: () => null,
}));
vi.mock("@/app/(org)/dashboard/caps/components/CapPagination", () => ({
	CapPagination: mocks.marker("pagination"),
}));
vi.mock("@/app/(org)/dashboard/caps/components/FoldersSection", () => ({
	FoldersSection: () => null,
}));
vi.mock("@/app/(org)/dashboard/caps/components/NewFolderDialog", () => ({
	NewFolderDialog: () => null,
}));
vi.mock("@/app/(org)/dashboard/caps/components/SelectedCapsBar", () => ({
	SelectedCapsBar: () => null,
}));
vi.mock(
	"@/app/(org)/dashboard/spaces/[spaceId]/components/AddVideosDialog",
	() => ({ AddVideosDialog: () => null }),
);
vi.mock(
	"@/app/(org)/dashboard/spaces/[spaceId]/components/AddVideosToOrganizationDialog",
	() => ({ AddVideosToOrganizationDialog: () => null }),
);
vi.mock(
	"@/app/(org)/dashboard/spaces/[spaceId]/components/EmptySharedCapState",
	() => ({ EmptySharedCapState: mocks.marker("empty-state") }),
);
vi.mock(
	"@/app/(org)/dashboard/spaces/[spaceId]/components/MembersIndicator",
	() => ({ MembersIndicator: () => null }),
);
vi.mock(
	"@/app/(org)/dashboard/spaces/[spaceId]/components/OrganizationIndicator",
	() => ({ OrganizationIndicator: () => null }),
);
vi.mock(
	"@/app/(org)/dashboard/spaces/[spaceId]/components/SharedCapCard",
	() => ({ SharedCapCard: mocks.marker("cap") }),
);

import { SharedCaps } from "@/app/(org)/dashboard/spaces/[spaceId]/SharedCaps";

let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
	vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
	container = document.createElement("div");
	document.body.append(container);
	root = createRoot(container);
});
afterEach(async () => {
	await act(async () => root.unmount());
	container.remove();
});

const cap = (index: number) => ({
	id: `video-${index}`,
	ownerId: "owner-1",
	name: `Cap ${index}`,
	createdAt: new Date(0),
	totalComments: 0,
	totalReactions: 0,
	ownerName: "Owner",
});

const renderPage = async (
	search: string,
	count: number,
	caps: number,
	folderCount = 0,
) => {
	mocks.search = search;
	const props = {
		data: Array.from({ length: caps }, (_, index) => cap(index)),
		count,
		spaceId: "space-1",
		analyticsEnabled: false,
		folders: Array.from({ length: folderCount }, (_, index) => ({
			id: `folder-${index}`,
		})),
	} as unknown as Parameters<typeof SharedCaps>[0];
	await act(async () => root.render(React.createElement(SharedCaps, props)));
	const has = (name: string) =>
		container.textContent?.includes(`[${name}]`) ?? false;
	return { empty: has("empty-state"), pagination: has("pagination") };
};

describe("space page past its last page", () => {
	it("shows the empty state for a space with no videos", async () => {
		expect(await renderPage("", 0, 0)).toEqual({
			empty: true,
			pagination: false,
		});
	});

	it("shows pagination, not the empty state, when the page is past the end", async () => {
		expect(await renderPage("page=3", 20, 0)).toEqual({
			empty: false,
			pagination: true,
		});
	});

	it("shows pagination past the end of a space that also has folders", async () => {
		expect(await renderPage("page=3", 20, 0, 1)).toEqual({
			empty: false,
			pagination: true,
		});
	});

	it("still paginates a full page", async () => {
		expect(await renderPage("", 20, 15)).toEqual({
			empty: false,
			pagination: true,
		});
	});
});
