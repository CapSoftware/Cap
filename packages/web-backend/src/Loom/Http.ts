import { CurrentUser, Http, Policy } from "@cap/web-domain";
import { HttpApiBuilder } from "@effect/platform";
import { Effect } from "effect";

import { handleDomainError } from "../Http/Errors.ts";
import { OrganisationsPolicy } from "../Organisations/OrganisationsPolicy.ts";
import * as Workflows from "../Workflows.ts";

export const LoomHttpLive = HttpApiBuilder.group(
	Http.ApiContract,
	"loom",
	(handlers) =>
		Effect.gen(function* () {
			const workflows = yield* Workflows.RpcClient;
			const orgPolicy = yield* OrganisationsPolicy;

			return handlers.handle("importVideo", ({ payload }) =>
				Effect.gen(function* () {
					const user = yield* CurrentUser;
					if (!user.email.endsWith("@cap.so"))
						return yield* Effect.die("Internal access only");

					const result = yield* workflows
						.LoomImportVideo({
							cap: { userId: user.id, orgId: user.activeOrganizationId },
							loom: payload.loom,
						})
						.pipe(
							Effect.catchTag(
								"RpcClientError",
								() => new Http.InternalServerError({ cause: "unknown" }),
							),
						);

					return { videoId: result.videoId };
				}).pipe(
					Policy.withPolicy(orgPolicy.isMember(payload.cap.orgId)),
					handleDomainError,
				),
			);
		}),
);
