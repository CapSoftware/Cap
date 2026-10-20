import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	buildContentTransferFolderRows,
	findDuplicateTransferVideoIds,
	getContentTransferFolderSubtree,
	getContentTransferStorageBlockReason,
	getContentTransferSubtreeVideoCounts,
	planPersonalFolderDestinations,
} from "@/lib/content-transfer";

const folder = (id: string, name: string, parentId: string | null = null) => ({
	id,
	name,
	parentId,
	color: "normal" as const,
});

describe("content transfer planning", () => {
	it("builds paths and returns only the selected subtree", () => {
		const folders = [
			folder("root", "IT-team"),
			folder("user", "person@example.com", "root"),
			folder("child", "Projects", "user"),
			folder("other", "Other"),
		];

		expect(
			buildContentTransferFolderRows(folders).map(({ id, path, depth }) => ({
				id,
				path,
				depth,
			})),
		).toEqual([
			{ id: "root", path: "IT-team", depth: 0 },
			{ id: "user", path: "IT-team / person@example.com", depth: 1 },
			{
				id: "child",
				path: "IT-team / person@example.com / Projects",
				depth: 2,
			},
			{ id: "other", path: "Other", depth: 0 },
		]);
		expect(
			getContentTransferFolderSubtree(folders, "user").map(({ id }) => id),
		).toEqual(["user", "child"]);
	});

	it("reuses an existing personal folder and creates missing descendants", () => {
		let nextId = 0;
		const plans = planPersonalFolderDestinations({
			sourceFolders: [
				folder("source-root", "Person@example.com"),
				folder("source-child", "Projects", "source-root"),
			],
			sourceRootFolderId: "source-root",
			targetFolders: [folder("existing", "person@example.com")],
			makeId: () => `new-${++nextId}`,
		});

		expect(plans).toEqual([
			{
				sourceFolderId: "source-root",
				sourceParentId: null,
				sourcePublic: false,
				destinationFolderId: "existing",
				destinationParentId: null,
				name: "Person@example.com",
				color: "normal",
				create: false,
			},
			{
				sourceFolderId: "source-child",
				sourceParentId: "source-root",
				sourcePublic: false,
				destinationFolderId: "new-1",
				destinationParentId: "existing",
				name: "Projects",
				color: "normal",
				create: true,
			},
		]);
	});

	it("rejects cycles and ambiguous destination folders", () => {
		expect(() =>
			buildContentTransferFolderRows([
				folder("one", "One", "two"),
				folder("two", "Two", "one"),
			]),
		).toThrow("Invalid folder hierarchy");
		expect(() =>
			planPersonalFolderDestinations({
				sourceFolders: [folder("source", "Archive")],
				sourceRootFolderId: "source",
				targetFolders: [
					folder("target-1", "Archive"),
					folder("target-2", "archive"),
				],
				makeId: () => "unused",
			}),
		).toThrow('Multiple destination folders match "Archive"');
		expect(() =>
			planPersonalFolderDestinations({
				sourceFolders: [
					folder("source-1", "Archive"),
					folder("source-2", "archive"),
				],
				sourceRootFolderId: "source-1",
				targetFolders: [],
				makeId: () => "unused",
			}),
		).not.toThrow();
		expect(() =>
			planPersonalFolderDestinations({
				sourceFolders: [
					folder("root", "Root"),
					folder("source-1", "Archive", "root"),
					folder("source-2", "archive", "root"),
				],
				sourceRootFolderId: "root",
				targetFolders: [],
				makeId: () => "unused",
			}),
		).toThrow('Multiple source folders match "archive" at the same level');
	});

	it("aggregates direct video counts through each folder subtree", () => {
		const folders = [
			folder("root", "Root"),
			folder("child", "Child", "root"),
			folder("grandchild", "Grandchild", "child"),
			folder("other", "Other"),
		];
		const totals = getContentTransferSubtreeVideoCounts(
			folders,
			new Map([
				["root", 1],
				["child", 2],
				["grandchild", 3],
				["other", 4],
			]),
		);

		expect(Object.fromEntries(totals)).toEqual({
			root: 6,
			child: 5,
			grandchild: 3,
			other: 4,
		});
	});

	it("detects duplicate source memberships", () => {
		expect(
			findDuplicateTransferVideoIds([
				{ videoId: "one" },
				{ videoId: "two" },
				{ videoId: "one" },
			]),
		).toEqual(["one"]);
	});

	it("allows organization storage and blocks another user's personal storage", () => {
		const input = {
			sourceOwnerId: "source-user",
			targetUserId: "target-user",
			organizationId: "org",
			bucketId: "bucket",
			bucketOwnerId: "source-user",
			bucketOrganizationId: "org",
			storageIntegrationId: null,
			storageIntegrationOwnerId: null,
			storageIntegrationOrganizationId: null,
		};

		expect(getContentTransferStorageBlockReason(input)).toBeNull();
		expect(
			getContentTransferStorageBlockReason({
				...input,
				bucketOrganizationId: null,
			}),
		).toBe("The Cap uses a personal storage bucket owned by another user");
		expect(
			getContentTransferStorageBlockReason({
				...input,
				sourceOwnerId: "target-user",
				bucketOrganizationId: null,
			}),
		).toBeNull();
	});
});

describe("content transfer safety contract", () => {
	it("reauthorizes every server action and serializes transfer starts", () => {
		const source = readFileSync(
			join(process.cwd(), "actions/organization/content-transfer.ts"),
			"utf8",
		);
		expect(
			source.match(/const user = await requireContentManager\(\)/g),
		).toHaveLength(5);
		const startSource = source.slice(
			source.indexOf("export async function startContentTransfer"),
			source.indexOf("export async function getContentTransferOperations"),
		);
		expect(
			startSource.indexOf("state.previewToken !== input.previewToken"),
		).toBeLessThan(startSource.indexOf("tx.insert(agentApiOperations)"));
		expect(startSource).toContain('.for("update")');
		expect(startSource).toContain(
			'inArray(agentApiOperations.state, ["queued", "running"])',
		);
	});

	it("copies and verifies media before changing ownership", () => {
		const source = readFileSync(
			join(process.cwd(), "workflows/transfer-organization-content.ts"),
			"utf8",
		);
		const transferSource = source.slice(
			source.indexOf("async function transferOneVideo"),
			source.indexOf("async function cleanupSourceFolders"),
		);
		expect(transferSource.indexOf("copyAndVerifyObjects")).toBeLessThan(
			transferSource.indexOf(".update(Db.videos)"),
		);
		expect(transferSource.indexOf(".update(Db.videos)")).toBeLessThan(
			transferSource.indexOf(".deleteObjects("),
		);
		expect(transferSource).toContain(
			"sourceMembership.folderId !== item.sourceFolderId",
		);
		expect(transferSource).toContain("canManageContentTransfer");
		expect(transferSource).toContain("eq(Db.folders.public, false)");
	});

	it("revalidates the reviewed hierarchy before creating destination folders", () => {
		const source = readFileSync(
			join(process.cwd(), "workflows/transfer-organization-content.ts"),
			"utf8",
		);
		const workflowSource = source.slice(
			source.indexOf(
				"export async function transferOrganizationContentWorkflow",
			),
		);
		expect(workflowSource.indexOf("verifySourceSnapshot")).toBeLessThan(
			workflowSource.indexOf("createDestinationFolders"),
		);
		expect(source).toContain("current.uploadPhase !== item.sourceUploadPhase");
		expect(source).toContain("current.public !== plan.sourcePublic");
	});
});
