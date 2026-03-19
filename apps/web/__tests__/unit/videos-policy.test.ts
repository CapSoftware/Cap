import { buildCanView, type VideosPolicyDeps } from "@cap/web-backend";
import {
	CurrentUser,
	type Organisation,
	type User,
	Video,
} from "@cap/web-domain";
import { Context, Effect, Option } from "effect";
import { describe, expect, it } from "vitest";

const TEST_VIDEO_ID = "test-video-1" as Video.VideoId;
const TEST_OWNER_ID = "owner-1" as User.UserId;
const TEST_ORG_ID = "org-1" as Organisation.OrganisationId;
const TEST_OTHER_USER_ID = "other-user-1" as User.UserId;

function makeVideo(
	overrides: Partial<{
		public: boolean;
		ownerId: string;
		orgId: string;
	}> = {},
) {
	return Video.Video.make({
		id: TEST_VIDEO_ID,
		ownerId: (overrides.ownerId ?? TEST_OWNER_ID) as User.UserId,
		orgId: (overrides.orgId ?? TEST_ORG_ID) as Organisation.OrganisationId,
		name: "Test Video",
		public: overrides.public ?? true,
		source: { type: "desktopMP4" },
		metadata: Option.none(),
		bucketId: Option.none(),
		folderId: Option.none(),
		transcriptionStatus: Option.none(),
		width: Option.none(),
		height: Option.none(),
		duration: Option.none(),
		createdAt: new Date(),
		updatedAt: new Date(),
	});
}

function makeDeps(config: {
	video: Video.Video | null;
	password?: Option.Option<string>;
	orgMembership?: boolean;
	spaceMembership?: boolean;
	allowedEmailDomain?: Option.Option<string>;
}): VideosPolicyDeps {
	const {
		video,
		password = Option.none<string>(),
		orgMembership = false,
		spaceMembership = false,
		allowedEmailDomain = Option.none<string>(),
	} = config;

	return {
		repo: {
			getById: () =>
				Effect.succeed(
					video ? Option.some([video, password] as const) : Option.none(),
				),
		},
		orgsRepo: {
			membershipForVideo: () =>
				Effect.succeed(orgMembership ? [{ membershipId: "mem-1" }] : []),
			allowedEmailDomain: () => Effect.succeed(allowedEmailDomain),
		},
		spacesRepo: {
			membershipForVideo: () =>
				Effect.succeed(
					spaceMembership
						? Option.some({ membershipId: "smem-1" })
						: Option.none(),
				),
		},
	};
}

function runCanView(
	deps: VideosPolicyDeps,
	user: Option.Option<CurrentUser["Type"]>,
): Promise<"allowed" | "denied"> {
	const policy = buildCanView(deps, TEST_VIDEO_ID);

	const program = Effect.zipRight(
		policy,
		Effect.succeed("allowed" as const),
	).pipe(
		Effect.catchTag("PolicyDenied", () => Effect.succeed("denied" as const)),
	);

	const withUser = user.pipe(
		Option.match({
			onNone: () => program,
			onSome: (u) => Effect.provideService(program, CurrentUser, u),
		}),
	);

	return Effect.runPromise(withUser);
}

function makeUser(
	email: string,
	id?: string,
): Option.Option<CurrentUser["Type"]> {
	return Option.some({
		id: (id ?? TEST_OTHER_USER_ID) as User.UserId,
		email,
		activeOrganizationId: TEST_ORG_ID,
		iconUrlOrKey: Option.none(),
	});
}

const noUser = Option.none<CurrentUser["Type"]>();

describe("VideosPolicy.canView", () => {
	describe("owner access", () => {
		it("allows the video owner regardless of restrictions", async () => {
			const deps = makeDeps({
				video: makeVideo({ public: false }),
				allowedEmailDomain: Option.some("restricted.com"),
			});
			const owner = makeUser("owner@anything.com", TEST_OWNER_ID);

			expect(await runCanView(deps, owner)).toBe("allowed");
		});

		it("allows owner even on private video with no membership", async () => {
			const deps = makeDeps({
				video: makeVideo({ public: false }),
			});
			const owner = makeUser("owner@anything.com", TEST_OWNER_ID);

			expect(await runCanView(deps, owner)).toBe("allowed");
		});
	});

	describe("explicit org membership", () => {
		it("allows org member on private video", async () => {
			const deps = makeDeps({
				video: makeVideo({ public: false }),
				orgMembership: true,
			});

			expect(await runCanView(deps, makeUser("member@company.com"))).toBe(
				"allowed",
			);
		});

		it("allows org member even when email does NOT match restriction", async () => {
			const deps = makeDeps({
				video: makeVideo({ public: true }),
				orgMembership: true,
				allowedEmailDomain: Option.some("restricted.com"),
			});

			expect(await runCanView(deps, makeUser("contractor@gmail.com"))).toBe(
				"allowed",
			);
		});

		it("allows org member on private video with email restriction", async () => {
			const deps = makeDeps({
				video: makeVideo({ public: false }),
				orgMembership: true,
				allowedEmailDomain: Option.some("restricted.com"),
			});

			expect(await runCanView(deps, makeUser("contractor@gmail.com"))).toBe(
				"allowed",
			);
		});
	});

	describe("explicit space membership", () => {
		it("allows space member on private video", async () => {
			const deps = makeDeps({
				video: makeVideo({ public: false }),
				spaceMembership: true,
			});

			expect(await runCanView(deps, makeUser("member@company.com"))).toBe(
				"allowed",
			);
		});

		it("allows space member even when email does NOT match restriction", async () => {
			const deps = makeDeps({
				video: makeVideo({ public: true }),
				spaceMembership: true,
				allowedEmailDomain: Option.some("restricted.com"),
			});

			expect(await runCanView(deps, makeUser("bob@gmail.com"))).toBe("allowed");
		});

		it("allows space member on private video with email restriction", async () => {
			const deps = makeDeps({
				video: makeVideo({ public: false }),
				spaceMembership: true,
				allowedEmailDomain: Option.some("restricted.com"),
			});

			expect(await runCanView(deps, makeUser("bob@gmail.com"))).toBe("allowed");
		});
	});

	describe("private video without membership", () => {
		it("denies logged-in user without membership", async () => {
			const deps = makeDeps({
				video: makeVideo({ public: false }),
			});

			expect(await runCanView(deps, makeUser("outsider@other.com"))).toBe(
				"denied",
			);
		});

		it("denies anonymous user", async () => {
			const deps = makeDeps({
				video: makeVideo({ public: false }),
			});

			expect(await runCanView(deps, noUser)).toBe("denied");
		});

		it("denies logged-in user with matching email domain but no membership", async () => {
			const deps = makeDeps({
				video: makeVideo({ public: false }),
				allowedEmailDomain: Option.some("company.com"),
			});

			expect(await runCanView(deps, makeUser("alice@company.com"))).toBe(
				"denied",
			);
		});
	});

	describe("public video WITHOUT email restriction", () => {
		it("allows anonymous user", async () => {
			const deps = makeDeps({
				video: makeVideo({ public: true }),
			});

			expect(await runCanView(deps, noUser)).toBe("allowed");
		});

		it("allows anonymous user when restriction is empty string", async () => {
			const deps = makeDeps({
				video: makeVideo({ public: true }),
				allowedEmailDomain: Option.some(""),
			});

			expect(await runCanView(deps, noUser)).toBe("allowed");
		});

		it("allows anonymous user when restriction is whitespace only", async () => {
			const deps = makeDeps({
				video: makeVideo({ public: true }),
				allowedEmailDomain: Option.some("  "),
			});

			expect(await runCanView(deps, noUser)).toBe("allowed");
		});

		it("allows any logged-in user", async () => {
			const deps = makeDeps({
				video: makeVideo({ public: true }),
			});

			expect(await runCanView(deps, makeUser("random@whatever.com"))).toBe(
				"allowed",
			);
		});
	});

	describe("public video WITH email restriction (single domain)", () => {
		it("denies anonymous user", async () => {
			const deps = makeDeps({
				video: makeVideo({ public: true }),
				allowedEmailDomain: Option.some("company.com"),
			});

			expect(await runCanView(deps, noUser)).toBe("denied");
		});

		it("allows user with matching domain", async () => {
			const deps = makeDeps({
				video: makeVideo({ public: true }),
				allowedEmailDomain: Option.some("company.com"),
			});

			expect(await runCanView(deps, makeUser("alice@company.com"))).toBe(
				"allowed",
			);
		});

		it("denies user with non-matching domain", async () => {
			const deps = makeDeps({
				video: makeVideo({ public: true }),
				allowedEmailDomain: Option.some("company.com"),
			});

			expect(await runCanView(deps, makeUser("alice@other.com"))).toBe(
				"denied",
			);
		});
	});

	describe("public video WITH email restriction (comma-separated)", () => {
		const restriction = "company.com, partner.org, vip@gmail.com";

		it("allows user matching first domain", async () => {
			const deps = makeDeps({
				video: makeVideo({ public: true }),
				allowedEmailDomain: Option.some(restriction),
			});

			expect(await runCanView(deps, makeUser("alice@company.com"))).toBe(
				"allowed",
			);
		});

		it("allows user matching second domain", async () => {
			const deps = makeDeps({
				video: makeVideo({ public: true }),
				allowedEmailDomain: Option.some(restriction),
			});

			expect(await runCanView(deps, makeUser("bob@partner.org"))).toBe(
				"allowed",
			);
		});

		it("allows specific email entry", async () => {
			const deps = makeDeps({
				video: makeVideo({ public: true }),
				allowedEmailDomain: Option.some(restriction),
			});

			expect(await runCanView(deps, makeUser("vip@gmail.com"))).toBe("allowed");
		});

		it("denies non-matching user from same email domain as specific entry", async () => {
			const deps = makeDeps({
				video: makeVideo({ public: true }),
				allowedEmailDomain: Option.some(restriction),
			});

			expect(await runCanView(deps, makeUser("notvip@gmail.com"))).toBe(
				"denied",
			);
		});

		it("denies user not matching any entry", async () => {
			const deps = makeDeps({
				video: makeVideo({ public: true }),
				allowedEmailDomain: Option.some(restriction),
			});

			expect(await runCanView(deps, makeUser("alice@random.com"))).toBe(
				"denied",
			);
		});

		it("denies anonymous user", async () => {
			const deps = makeDeps({
				video: makeVideo({ public: true }),
				allowedEmailDomain: Option.some(restriction),
			});

			expect(await runCanView(deps, noUser)).toBe("denied");
		});
	});

	describe("the contractor scenario", () => {
		it("contractor in space can access private video despite domain restriction", async () => {
			const deps = makeDeps({
				video: makeVideo({ public: false }),
				spaceMembership: true,
				allowedEmailDomain: Option.some("mycompany.com"),
			});

			expect(await runCanView(deps, makeUser("bob@gmail.com"))).toBe("allowed");
		});

		it("contractor in org can access private video despite domain restriction", async () => {
			const deps = makeDeps({
				video: makeVideo({ public: false }),
				orgMembership: true,
				allowedEmailDomain: Option.some("mycompany.com"),
			});

			expect(await runCanView(deps, makeUser("bob@gmail.com"))).toBe("allowed");
		});

		it("random person with public link is blocked by domain restriction", async () => {
			const deps = makeDeps({
				video: makeVideo({ public: true }),
				allowedEmailDomain: Option.some("mycompany.com"),
			});

			expect(await runCanView(deps, makeUser("random@outsider.com"))).toBe(
				"denied",
			);
		});

		it("employee with matching domain can access public link", async () => {
			const deps = makeDeps({
				video: makeVideo({ public: true }),
				allowedEmailDomain: Option.some("mycompany.com"),
			});

			expect(await runCanView(deps, makeUser("alice@mycompany.com"))).toBe(
				"allowed",
			);
		});

		it("anonymous user blocked from public video with restriction", async () => {
			const deps = makeDeps({
				video: makeVideo({ public: true }),
				allowedEmailDomain: Option.some("mycompany.com"),
			});

			expect(await runCanView(deps, noUser)).toBe("denied");
		});
	});

	describe("video not found", () => {
		it("allows access when video does not exist", async () => {
			const deps = makeDeps({ video: null });

			expect(await runCanView(deps, noUser)).toBe("allowed");
		});
	});

	describe("email restriction does NOT apply to private video access", () => {
		it("private video denied for non-member even if email matches restriction", async () => {
			const deps = makeDeps({
				video: makeVideo({ public: false }),
				allowedEmailDomain: Option.some("company.com"),
			});

			expect(await runCanView(deps, makeUser("alice@company.com"))).toBe(
				"denied",
			);
		});

		it("email restriction only gates the public link path", async () => {
			const deps = makeDeps({
				video: makeVideo({ public: false }),
				allowedEmailDomain: Option.some("company.com"),
			});

			expect(await runCanView(deps, noUser)).toBe("denied");

			const publicDeps = makeDeps({
				video: makeVideo({ public: true }),
				allowedEmailDomain: Option.some("company.com"),
			});

			expect(await runCanView(publicDeps, makeUser("alice@company.com"))).toBe(
				"allowed",
			);
			expect(await runCanView(publicDeps, makeUser("alice@other.com"))).toBe(
				"denied",
			);
		});
	});
});
