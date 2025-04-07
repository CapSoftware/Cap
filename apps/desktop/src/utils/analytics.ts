import { v4 as uuid } from "uuid";
import posthog from "posthog-js";

const key = import.meta.env.VITE_POSTHOG_KEY as string;
const host = import.meta.env.VITE_POSTHOG_HOST as string;

if (key && host) {
  posthog.init(key, { api_host: host });
}

export function initAnonymousUser() {
  if (!key || !host) return;
  const anonymousId = localStorage.getItem("anonymous_id") ?? uuid();
  localStorage.setItem("anonymous_id", anonymousId);
  posthog.identify(anonymousId);
}

export function identifyUser(userId: string, properties?: Record<string, any>) {
  if (!key || !host) return;
  const currentId = posthog.get_distinct_id();
  if (currentId && currentId !== userId) {
    posthog.alias(userId);
  }
  posthog.identify(userId);
  if (properties) {
    posthog.people.set(properties);
  }
}

export function trackEvent(
  eventName: string,
  properties?: Record<string, any>
) {
  if (!key || !host) return;
  posthog.capture(eventName, properties);
}
