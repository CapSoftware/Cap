"use client";

import Intercom from "@intercom/messenger-js-sdk";
import { usePathname } from "next/navigation";
import { useEffect } from "react";
import { useCurrentUser } from "../AuthContext";

export function Client(props: { hash?: string }) {
	const user = useCurrentUser();
	const pathname = usePathname();
	const isSharePage = pathname?.startsWith("/s/");
	const isBlogPage = pathname?.startsWith("/blog");

	useEffect(() => {
		if (!isSharePage && !isBlogPage) {
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
