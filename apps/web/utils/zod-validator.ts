import { zValidator as honoZValidator } from "@hono/zod-validator";
import type { Context, Env, MiddlewareHandler, ValidationTargets } from "hono";
import type { z } from "zod";
import { apiErrorBody } from "@/lib/api-errors";

type Validator<
	T extends z.ZodType,
	Target extends keyof ValidationTargets,
	E extends Env,
	P extends string,
> = ReturnType<typeof honoZValidator<T, Target, E, P>>;

// zod 4 serialises a ZodError as { name, message }; clients have always
// received { issues, name } in the 400 body, so keep that shape.
export const zValidator = <
	T extends z.ZodType,
	Target extends keyof ValidationTargets,
	E extends Env = Env,
	P extends string = string,
>(
	target: Target,
	schema: T,
) =>
	honoZValidator(target, schema, (result, c) => {
		if (!result.success)
			return c.json(
				{
					success: false,
					error: { issues: result.error.issues, name: "ZodError" },
				},
				400,
			);
	}) as unknown as Validator<T, Target, E, P>;

const JSON_CONTENT_TYPE =
	/^application\/([a-z-.]+\+)?json(;\s*[a-zA-Z0-9-]+=([^;]+))*$/i;

const JSON_BODY_HINT =
	'Send a JSON object in the request body with the header "Content-Type: application/json".';

// Hono's json validator reads a body without a JSON content type as {}, so a
// request whose fields are all optional would succeed with every field dropped.
async function jsonBodyRefusal(c: Context) {
	const contentType = c.req.header("Content-Type");
	if (contentType && JSON_CONTENT_TYPE.test(contentType)) {
		try {
			await c.req.json();
			return null;
		} catch {
			return c.json(
				apiErrorBody(
					"invalid_json",
					"Malformed JSON in request body",
					JSON_BODY_HINT,
				),
				400,
			);
		}
	}
	if ((await c.req.text()).trim() === "") return null;
	return c.json(
		apiErrorBody(
			"unsupported_media_type",
			"Request body must be sent as application/json",
			JSON_BODY_HINT,
		),
		415,
	);
}

const issueSummary = (issues: readonly z.core.$ZodIssue[]) =>
	issues
		.slice(0, 5)
		.map((issue) =>
			issue.path.length > 0
				? `${issue.path.join(".")}: ${issue.message}`
				: issue.message,
		)
		.join("; ");

export const developerZValidator = <
	T extends z.ZodType,
	Target extends keyof ValidationTargets,
	E extends Env = Env,
	P extends string = string,
>(
	target: Target,
	schema: T,
) => {
	const validate = honoZValidator(target, schema, (result, c) => {
		if (!result.success)
			return c.json(
				{
					...apiErrorBody(
						"invalid_request",
						`Invalid request: ${issueSummary(result.error.issues)}`,
						"Fix the fields listed in issues, then send the request again.",
					),
					issues: result.error.issues,
				},
				400,
			);
	}) as unknown as MiddlewareHandler;
	const handler: MiddlewareHandler = async (c, next) => {
		if (target === "json") {
			const refusal = await jsonBodyRefusal(c);
			if (refusal) return refusal;
		}
		return validate(c, next);
	};
	return handler as unknown as Validator<T, Target, E, P>;
};
