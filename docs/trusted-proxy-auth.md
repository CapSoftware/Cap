# Trusted reverse-proxy authentication

This opt-in provider lets an authenticating reverse proxy sign requests into one
existing Cap account. It is intended for single-owner self-hosted instances, not
multi-user SSO: every successful sign-in uses the configured account.

## Configuration and security boundary

Set all three variables in the Cap web server's environment:

```dotenv
TRUSTED_PROXY_AUTH_HEADER=x-openhost-is-owner
TRUSTED_PROXY_AUTH_EMAIL=owner@example.com
TRUSTED_PROXY_AUTH_SECRET=<a-long-random-secret-shared-only-with-the-proxy>
```

Create the Cap account through a normal login first. This provider does not create
users. It is absent unless the header, email and a non-blank secret are configured;
ordinary email/OAuth login remains available. Restart Cap after changing its env.

Configure the proxy to:

- Authenticate the owner before forwarding requests to Cap, including `/api/auth/*`.
  Do not accept any authenticated proxy user as the owner.
- Strip client-sent copies of **both** the configured trust header and
  `x-trusted-proxy-secret`. On owner-authenticated requests only, set the trust
  header to the literal string `true` and the secret header to the configured
  secret. Never forward a client-provided value for either header.
- Keep the Cap origin private or firewalled so clients cannot bypass the proxy
  through a published container port, alternative hostname or ingress. Use HTTPS
  on the public endpoint and a protected connection between the proxy and Cap.

Choose a trust-header name distinct from `x-trusted-proxy-secret`. Keep the secret
out of browser code, URLs, responses and logs. It is required even when the origin
is private; a direct request with only the trust header must not authenticate.

## Triggering sign-in

There is no built-in Reverse Proxy button yet. A custom Cap client component can
trigger the provider with NextAuth's client helper:

```tsx
"use client";

import { signIn } from "next-auth/react";

export function ReverseProxySignIn() {
  return (
    <button onClick={() => void signIn("trusted-proxy", { callbackUrl: "/" })}>
      Sign in through proxy
    </button>
  );
}
```

The helper handles NextAuth's CSRF cookie/token and posts to the credentials
callback. The proxy, not the component, supplies both trust headers. Do not pass
the secret to `signIn`.

For an existing deployment without a custom button, authenticate through the proxy,
open Cap's `/login` page **at its public proxied URL**, then run this in that page's
browser developer console. It obtains a CSRF token and submits a same-origin form;
no secret is entered in the browser:

```js
(async () => {
  const response = await fetch("/api/auth/csrf", {
    credentials: "same-origin",
    cache: "no-store",
  });
  if (!response.ok) throw new Error("Could not fetch the Cap CSRF token");
  const { csrfToken } = await response.json();
  if (typeof csrfToken !== "string" || !csrfToken) {
    throw new Error("Missing Cap CSRF token; check the proxy login");
  }
  const form = document.createElement("form");
  form.method = "POST";
  form.action = "/api/auth/callback/trusted-proxy";
  for (const [name, value] of Object.entries({
    csrfToken,
    callbackUrl: `${location.origin}/`,
  })) {
    const input = document.createElement("input");
    input.type = "hidden";
    input.name = name;
    input.value = value;
    form.appendChild(input);
  }
  document.body.appendChild(form);
  form.submit();
})();
```

A plain GET link to `/api/auth/signin/trusted-proxy` does not complete a credentials
sign-in. Use the helper or the CSRF-protected POST above. Missing/incorrect proxy
headers or a nonexistent configured account reject the login; check the server's
configuration and proxy rules rather than exposing the origin or weakening the
secret requirement.
