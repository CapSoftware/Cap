"use client";

import Intercom from "@intercom/messenger-js-sdk";
import { usePathname } from "next/navigation";
import { use, useEffect } from "react";
import { useAuthContext } from "../AuthContext";

export function Client(props: { hash?: string }) {
	const user = use(useAuthContext().user);
	const pathname = usePathname();
	const isSharePage = pathname?.startsWith("/s/");

	useEffect(() => {
		if (!isSharePage) {
			if (props.hash && user) {
				Intercom({
					app_id: "efxq71cv",
					user_id: user.id,
					user_hash: props.hash,
					name: user.name ?? "",
					email: user.email,
					utm_source: "web",
				});
			} else {
				Intercom({
					app_id: "efxq71cv",
					utm_source: "web",
				});
			}
		}
	}, [props.hash, user]);

	return null;
}
