import Stripe from "stripe";

export const stripe = new Stripe(
  process.env.STRIPE_SECRET_KEY_TEST ??
    process.env.STRIPE_SECRET_KEY_LIVE ??
    "",
  {
    apiVersion: "2023-10-16",
    appInfo: {
      name: "Cap",
      version: "0.1.0",
    },
  }
);
