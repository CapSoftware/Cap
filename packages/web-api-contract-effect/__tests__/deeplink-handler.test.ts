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

      const result = await handler.handle('cap://