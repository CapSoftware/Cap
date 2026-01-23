import { HttpApiBuilder, HttpApiError } from "@effect/platform";
import { CurrentUser, Http, Policy } from "@inflight/web-domain";
import { Effect } from "effect";

import { handleDomainError } from "../Http/Errors.ts";
import { OrganisationsPolicy } from "../Organisations/OrganisationsPolicy.ts";
import * as Workflows from "../Workflows.ts";

export const LoomHttpLive = HttpApiBuilder.group(
	Http.ApiContract,
	"loom",
	(handlers) =>
		Effect.gen(function* () {
			const _workflows = yield* Effect.serviceOption(Workflows.RpcClient);
			const orgPolicy = yield* OrganisationsPolicy;

			return handlers.handle("importVideo", ({ payload }) =>
				Effect.gen(function* () {
					const workflows = yield* _workflows.pipe(
						Effect.catchAll(() => new HttpApiError.ServiceUnavailable()),
					);

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
