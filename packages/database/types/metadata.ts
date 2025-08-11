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
   * Title of the captured monitor or window
   */
  sourceName?: string;
  /**
   * Duration of the video in seconds
   */
  duration?: string | number;
  /**
   * Resolution of the recording (e.g. 1920x1080)
   */
  resolution?: string;
  /**
   * Frames per second of the recording
   */
  fps?: number;
  /**
   * AI generated title for the video
   */
  aiTitle?: string;
  /**
   * AI generated summary of the content
   */
  summary?: string;
  /**
   * Chapter markers generated from the transcript
   */
  chapters?: { title: string; start: number }[];
  aiProcessing?: boolean;
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
