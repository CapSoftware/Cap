/**
 * Validates if an email address is allowed to sign up based on configured domain restrictions.
 * 
 * @param email - The email address to validate
 * @param allowedDomainsConfig - Comma-separated list of allowed domains (e.g., "company.com,partner.org")
 * @returns true if signup is allowed, false otherwise
 */
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

  // Parse allowed domains from config
  const allowedDomains = parseAllowedDomains(allowedDomainsConfig);
  
  // Check if email domain is in the allowed list
  return allowedDomains.includes(emailDomain.toLowerCase());
}

/**
 * Extracts the domain part from an email address.
 * 
 * @param email - The email address
 * @returns The domain part or null if invalid
 */
function extractDomainFromEmail(email: string): string | null {
  if (!email || typeof email !== "string") {
    return null;
  }

  const emailRegex = /^[^\s@]+@([^\s@]+\.[^\s@]+)$/;
  const match = email.match(emailRegex);
  
  return match ? match[1] : null;
}

/**
 * Parses the comma-separated allowed domains configuration.
 * 
 * @param allowedDomainsConfig - Comma-separated domain list
 * @returns Array of normalized domain names
 */
function parseAllowedDomains(allowedDomainsConfig: string): string[] {
  return allowedDomainsConfig
    .split(",")
    .map(domain => domain.trim().toLowerCase())
    .filter(domain => domain.length > 0 && isValidDomain(domain));
}

/**
 * Basic validation for domain format.
 * 
 * @param domain - Domain to validate
 * @returns true if domain format is valid
 */
function isValidDomain(domain: string): boolean {
  // Basic domain validation - must contain at least one dot and valid characters
  const domainRegex = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/;
  return domainRegex.test(domain) && domain.includes(".");
}
