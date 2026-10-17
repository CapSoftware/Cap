import { Button } from "@cap/ui-solid";

import type { ComponentProps } from "solid-js";
import { createSignInMutation } from "~/utils/auth";

export function SignInButton(
	props: Omit<ComponentProps<typeof Button>, "onClick">,
) {
	const signIn = createSignInMutation();

	return (
		<Button
			size="md"
			class="flex grow justify-center items-center"
			{...props}
			variant={signIn.isPending ? "gray" : "primary"}
			onClick={() => {
				if (signIn.isPending) {
					signIn.variables.abort();
					signIn.reset();
				} else {
					signIn.mutate(new AbortController());
				}
			}}
		>
			{signIn.isPending ? "取消登录" : (props.children ?? "登录")}
		</Button>
	);
}
