import * as uuid from "uuid";
import posthog from "posthog-js";

export function initAnonymousUser() {
  const anonymousId = localStorage.getItem("anonymous_id") ?? uuid.v4();
  localStorage.setItem("anonymous_id", anonymousId);
  posthog.identify(anonymousId);
}

export function identifyUser(userId: string, properties?: Record<string, any>) {
  const currentId = posthog.get_distinct_id();
  const anonymousId = localStorage.getItem("anonymous_id");

  if (currentId !== userId) {
    if (anonymousId && currentId === anonymousId) {
      posthog.alias(userId, anonymousId);
    }
    posthog.identify(userId);
    if (properties) {
      posthog.people.set(properties);
    }
    localStorage.removeItem("anonymous_id");
  }
}

export function trackEvent(
  eventName: string,
  properties?: Record<string, any>
) {
  posthog.capture(eventName, { ...properties, platform: "web" });
}
