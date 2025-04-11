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