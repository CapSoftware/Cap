import { Folder, Organisation, Space } from "@cap/web-domain";
import { describe, expect, it } from "vitest";
import {
	buildMoveFolderDestinationRows,
	resolveMoveLocation,
} from "@/lib/move-items";

const folderId = Folder.FolderId.make;

describe("move item helpers", () => {
	it("resolves personal, organization, and space locations", () => {
		const organizationId = Organisation.OrganisationId.make("org-1");

		expect(resolveMoveLocation(null, organizationId)).toEqual({
			type: "personal",
		});
		expect(resolveMoveLocation(organizationId, organizationId)).toEqual({
			type: "organization",
		});
		expect(
			resolveMoveLocation(Space.SpaceId.make("space-1"), organizationId),
		).toEqual({ type: "space", spaceId: "space-1" });
	});

	it("builds searchable paths and disables a folder and its descendants", () => {
		const rows = buildMoveFolderDestinationRows(
			[
				{ id: folderId("child"), name: "Child", parentId: folderId("root") },
				{ id: folderId("other"), name: "Other", parentId: null },
				{ id: folderId("root"), name: "Root", parentId: null },
				{
					id: folderId("grandchild"),
					name: "Grandchild",
					parentId: folderId("child"),
				},
			],
			folderId("child"),
		);

		expect(
			rows.map(({ id, path, depth, disabled }) => ({
				id,
				path,
				depth,
				disabled,
			})),
		).toEqual([
			{ id: "other", path: "Other", depth: 0, disabled: false },
			{ id: "root", path: "Root", depth: 0, disabled: false },
			{ id: "child", path: "Root / Child", depth: 1, disabled: true },
			{
				id: "grandchild",
				path: "Root / Child / Grandchild",
				depth: 2,
				disabled: true,
			},
		]);
	});

	it("handles invalid cycles without looping", () => {
		const rows = buildMoveFolderDestinationRows([
			{ id: folderId("one"), name: "One", parentId: folderId("two") },
			{ id: folderId("two"), name: "Two", parentId: folderId("one") },
		]);

		expect(rows).toHaveLength(2);
	});
});
