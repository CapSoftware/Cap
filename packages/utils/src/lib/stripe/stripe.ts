import { serverEnv } from "@inflight/env";
import Stripe from "stripe";

const key = () => serverEnv().STRIPE_SECRET_KEY ?? "";
export const STRIPE_AVAILABLE = () => key() !== "";
export const stripe = () =>
	new Stripe(key(), {
		apiVersion: "2023-10-16",
		appInfo: {
			name: "Cap",
			version: "0.1.0",
		},
	});
