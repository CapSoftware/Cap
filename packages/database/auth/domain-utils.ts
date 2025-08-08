import { z } from "zod";

export function isEmailAllowedForSignup(
  email: string,
  allowedDomainsConfig?: string
): boolean {
  // If no domain restrictions are configured, allow all signups
  if (!allowedDomainsConfig || allowedDomainsConfig.trim() === "") {
    return true;
  }

  const emailDomain = extractDomainFromEmail(email);
  if (!emailDomain) {
    return false;
  }

  const allowedDomains = parseAllowedDomains(allowedDomainsConfig);
  return allowedDomains.includes(emailDomain.toLowerCase());
}

function extractDomainFromEmail(email: string): string | null {
  const emailValidation = z.email().safeParse(email);
  if (!emailValidation.success) {
    return null;
  }

  // Extract domain from validated email
  const atIndex = email.lastIndexOf("@");
  return atIndex !== -1 ? email.substring(atIndex + 1) : null;
}

function parseAllowedDomains(allowedDomainsConfig: string): string[] {
  return allowedDomainsConfig
    .split(",")
    .map(domain => domain.trim().toLowerCase())
    .filter(domain => domain.length > 0 && isValidDomain(domain));
}

function isValidDomain(domain: string): boolean {
  return z.hostname().safeParse(domain).success;
}
