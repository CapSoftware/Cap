import { describe, it, expect } from 'vitest';
import {
  parseDeeplink,
  createDeeplink,
  DeeplinkBuilder,
  DeeplinkActions,
  DEEPLINK_PREFIX,
} from '../deeplinks';

describe('parseDeeplink', () => {
  describe('valid deeplinks', () => {
    it('should parse simple action deeplink', () => {
      const result = parseDeeplink('cap://record');
      expect(result).toEqual({ action: 'record' });
    });

    it('should parse deeplink with query parameters', () => {
      const result = parseDeeplink('cap://switch-microphone?deviceId=mic-123');
      expect(result).toEqual({
        action: 'switch-microphone',
        deviceId: 'mic-123',
      });
    });

    it('should parse deeplink with multiple parameters', () => {
      const result = parseDeeplink('cap://switch-camera?deviceId=cam-456&format=1080p');
      expect(result).toEqual({
        action: 'switch-camera',
        deviceId: 'cam-456',
        format: '1080p',
      });
    });

    it('should handle URL-encoded parameters', () => {
      const result = parseDeeplink('cap://record?name=My%20Recording');
      expect(result).toEqual({
        action: 'record',
        name: 'My Recording',
      });
    });

    it('should ignore empty query values', () => {
      const result = parseDeeplink('cap://record?empty=');
      expect(result).toEqual({ action: 'record' });
    });

    it('should trim whitespace from URL', () => {
      const result = parseDeeplink('  cap://pause  ');
      expect(result).toEqual({ action: 'pause' });
    });
  });

  describe('invalid deeplinks', () => {
    it('should return null for wrong prefix', () => {
      expect(parseDeeplink('http://example.com')).toBeNull();
    });

    it('should return null for empty string', () => {
      expect(parseDeeplink('')).toBeNull();
    });

    it('should return null for null/undefined', () => {
      expect(parseDeeplink(null as unknown as string)).toBeNull();
      expect(parseDeeplink(undefined as unknown as string)).toBeNull();
    });

    it('should return null for invalid action', () => {
      expect(parseDeeplink('cap://invalid-action')).toBeNull();
    });

    it('should return null for malformed URL', () => {
      expect(parseDeeplink('cap://')).toBeNull();
    });

    it('should handle malformed query string gracefully', () => {
      // Invalid percent encoding should not throw
      const result = parseDeeplink('cap://record?name=%ZZ');
      expect(result?.action).toBe('record');
    });

    it('should return null for non-string input', () => {
      expect(parseDeeplink(123 as unknown as string)).toBeNull();
    });
  });
});

describe('createDeeplink', () => {
  it('should create simple deeplink', () => {
    expect(createDeeplink('record')).toBe('cap://record');
  });

  it('should create deeplink with parameters', () => {
    expect(createDeeplink('switch-microphone', { deviceId: 'mic-123' }))
      .toBe('cap://switch-microphone?deviceId=mic-123');
  });

  it('should filter out undefined parameters', () => {
    const result = createDeeplink('switch-camera', {
      deviceId: 'cam-456',
      unused: undefined,
    });
    expect(result).toBe('cap://switch-camera?deviceId=cam-456');
  });

  it('should filter out empty string parameters', () => {
    const result = createDeeplink('record', { name: '' });
    expect(result).toBe('cap://record');
  });

  it('should URL-encode special characters', () => {
    const result = createDeeplink('record', { name: 'My Recording' });
    expect(result).toBe('cap://record?name=My+Recording');
  });

  it('should handle no parameters', () => {
    expect(createDeeplink('stop')).toBe('cap://stop');
  });
});

describe('DeeplinkBuilder', () => {
  it('should build simple deeplink', () => {
    const result = new DeeplinkBuilder('record').build();
    expect(result).toBe('cap://record');
  });

  it('should build deeplink with parameters', () => {
    const result = new DeeplinkBuilder('switch-microphone')
      .withDeviceId('mic-789')
      .build();
    expect(result).toBe('cap://switch-microphone?deviceId=mic-789');
  });

  it('should chain multiple parameters', () => {
    const result = new DeeplinkBuilder('record')
      .withParam('name', 'Test')
      .withParam('format', 'mp4')
      .build();
    expect(result).toContain('cap://record?');
    expect(result).toContain('name=Test');
    expect(result).toContain('format=mp4');
  });

  it('should ignore empty parameters', () => {
    const result = new DeeplinkBuilder('record')
      .withParam('empty', '')
      .build();
    expect(result).toBe('cap://record');
  });
});

describe('DeeplinkActions', () => {
  it('should create startRecording deeplink', () => {
    expect(DeeplinkActions.startRecording()).toBe('cap://record');
  });

  it('should create stopRecording deeplink', () => {
    expect(DeeplinkActions.stopRecording()).toBe('cap://stop');
  });

  it('should create pauseRecording deeplink', () => {
    expect(DeeplinkActions.pauseRecording()).toBe('cap://pause');
  });

  it('should create resumeRecording deeplink', () => {
    expect(DeeplinkActions.resumeRecording()).toBe('cap://resume');
  });

  it('should create switchMicrophone deeplink with deviceId', () => {
    expect(DeeplinkActions.switchMicrophone('mic-123'))
      .toBe('cap://switch-microphone?deviceId=mic-123');
  });

  it('should throw error for switchMicrophone without deviceId', () => {
    expect(() => DeeplinkActions.switchMicrophone('')).toThrow();
  });

  it('should create switchCamera deeplink with deviceId', () => {
    expect(DeeplinkActions.switchCamera('cam-456'))
      .toBe('cap://switch-camera?deviceId=cam-456');
  });

  it('should throw error for switchCamera without deviceId', () => {
    expect(() => DeeplinkActions.switchCamera('')).toThrow();
  });
});