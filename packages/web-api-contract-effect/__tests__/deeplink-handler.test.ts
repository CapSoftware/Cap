import { describe, it, expect, vi, beforeEach } from 'vitest';
import { DeeplinkHandler, DeeplinkHandlerError } from '../deeplink-handler';

describe('DeeplinkHandler', () => {
  describe('initialization', () => {
    it('should throw if context is not provided', () => {
      expect(() => new DeeplinkHandler(null as any)).toThrow();
    });

    it('should accept empty context object', () => {
      const handler = new DeeplinkHandler({});
      expect(handler).toBeDefined();
    });
  });

  describe('handle valid actions', () => {
    it('should handle record action', async () => {
      const onStartRecording = vi.fn();
      const handler = new DeeplinkHandler({ onStartRecording });

      const result = await handler.handle('cap://record');

      expect(result).toBe(true);
      expect(onStartRecording).toHaveBeenCalledOnce();
    });

    it('should handle stop action', async () => {
      const onStopRecording = vi.fn();
      const handler = new DeeplinkHandler({ onStopRecording });

      const result = await handler.handle('cap://stop');

      expect(result).toBe(true);
      expect(onStopRecording).toHaveBeenCalledOnce();
    });

    it('should handle pause action', async () => {
      const onPauseRecording = vi.fn();
      const handler = new DeeplinkHandler({ onPauseRecording });

      const result = await handler.handle('cap://pause');

      expect(result).toBe(true);
      expect(onPauseRecording).toHaveBeenCalledOnce();
    });

    it('should handle resume action', async () => {
      const onResumeRecording = vi.fn();
      const handler = new DeeplinkHandler({ onResumeRecording });

      const result = await handler.handle('cap://resume');

      expect(result).toBe(true);
      expect(onResumeRecording).toHaveBeenCalledOnce();
    });

    it('should handle switch-microphone with deviceId', async () => {
      const onSwitchMicrophone = vi.fn();
      const handler = new DeeplinkHandler({ onSwitchMicrophone });

      const result = await handler.handle('cap://switch-microphone?deviceId=mic-1');

      expect(result).toBe(true);
      expect(onSwitchMicrophone).toHaveBeenCalledWith('mic-1');
    });

    it('should handle switch-camera with deviceId', async () => {
      const onSwitchCamera = vi.fn();
      const handler = new DeeplinkHandler({ onSwitchCamera });

      const result = await handler.handle('cap://switch-camera?deviceId=cam-1');

      expect(result).toBe(true);
      expect(onSwitchCamera).toHaveBeenCalledWith('cam-1');
    });
  });

  describe('error handling', () => {
    it('should return false for invalid URL', async () => {
      const onError = vi.fn();
      const handler = new DeeplinkHandler({ onError });

      const result = await handler.handle('invalid-url');

      expect(result).toBe(false);
      expect(onError).toHaveBeenCalled();
    });

    it('should return false for empty string', async () => {
      const onError = vi.fn();
      const handler = new DeeplinkHandler({ onError });

      const result = await handler.handle('');

      expect(result).toBe(false);
      expect(onError).toHaveBeenCalled();
    });

    it('should throw for switch-microphone without deviceId', async () => {
      const onError = vi.fn();
      const handler = new DeeplinkHandler({ onError });

      const result = await handler.handle('cap://switch-microphone');

      expect(result).toBe(false);
      expect(onError).toHaveBeenCalled();
    });

    it('should return false for unknown action', async () => {
      const onError = vi.fn();
      const handler = new DeeplinkHandler({ onError });

      const result = await handler.handle('cap://unknown-action');

      expect(result).toBe(false);
      expect(onError).toHaveBeenCalled();
    });
  });
});
