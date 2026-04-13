import { describe, it, expect } from 'vitest';
import { DeeplinkHandler } from '../deeplink-handler';

describe('DeeplinkHandler', () => {
  const handler = new DeeplinkHandler();

  it('should handle pause action', () => {
    const result = handler.handle('cap://pause');
    expect(result).toEqual({ type: 'pause' });
  });

  it('should handle resume action', () => {
    const result = handler.handle('cap://resume');
    expect(result).toEqual({ type: 'resume' });
  });

  it('should handle unknown action', () => {
    const result = handler.handle('cap://unknown');
    expect(result).toEqual({ type: 'unknown', action: 'unknown' });
  });

  it('should handle invalid deeplink', () => {
    const result = handler.handle('invalid://link');
    expect(result).toEqual({ type: 'invalid' });
  });
});
