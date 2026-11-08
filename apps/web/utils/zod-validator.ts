import { zValidator as honoZValidator } from "@hono/zod-validator";
import type { Env, ValidationTargets } from "hono";
import type { z } from "zod";

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
