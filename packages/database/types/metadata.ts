/**
 * Type definitions for JSON metadata fields
 */

/**
 * Video metadata structure
 */
export interface VideoMetadata {
  /**
   * Custom created date that can be edited by the user
   * This overrides the display of the actual createdAt timestamp
   */
  customCreatedAt?: string;
  /**
   * Custom logo configuration for share pages
   */
  customLogo?: {
    /** URL of the custom logo */
    url?: string;
    /** Width of the logo in pixels */
    width?: number;
    /** Whether to use the owner's workspace logo */
    useOrganization?: boolean;
  } | null;
  [key: string]: any;
}

/**
 * Space metadata structure
 */
export interface SpaceMetadata {
  [key: string]: any;
}

/**
 * User metadata structure
 */
export interface UserMetadata {
  [key: string]: any;
}
