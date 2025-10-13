import { DatabaseError, Http, S3Error } from "@cap/web-domain";
import { Effect, Schema } from "effect";
import { InvalidRpcAuth } from "../Workflows.ts";

export const handleDomainError = <A, E, R>(e: Effect.Effect<A, E, R>) =>
	e.pipe(
		Effect.catchIf(
			(e) => Schema.is(DatabaseError)(e),
			() => new Http.InternalServerError({ cause: "database" }),
		),
		Effect.catchIf(
			(e) => Schema.is(S3Error)(e),
			() => new Http.InternalServerError({ cause: "database" }),
		),
		Effect.catchIf(
			(e) => Schema.is(InvalidRpcAuth)(e),
			() => new Http.InternalServerError({ cause: "unknown" }),
		),
	);
