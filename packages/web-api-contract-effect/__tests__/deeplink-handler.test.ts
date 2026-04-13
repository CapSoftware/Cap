import { describe, it, expect, beforeEach, vi } from 'vitest';
import { CapDeeplinkHandler } from '../deeplink-handler';
import { parseCapDeeplink } from '@capsoftware/utils';

vi.mock('@capsoftware/utils', () => ({
  parseCapDeeplink: vi.fn(),
}));

describe('CapDeeplinkHandler', () => {
  let handler: CapDeeplinkHandler;

  beforeEach(() => {
    handler = new CapDeeplinkHandler();
    vi.clearAllMocks();
  });

  it('should handle pause action', () => {
    const mockDeeplink = { action: 'pause', payload: {} };
    (parseCapDeeplink as any).mockReturnValue(mockDeeplink);

    const result = handler.handle('cap://pause');

    expect(parseCapDeeplink).toHaveBeenCalledWith('cap://pause');
    expect(result).toEqual({ success: true, action: 'pause' });
  });

  it('should return error for invalid deeplink', () => {
    (parseCapDeeplink as any).mockReturnValue(null);

    const result = handler.handle('invalid://link');

    expect(result).toEqual({ success: false, error: 'Invalid deeplink format' });
  });

  it('should return error for unsupported action', () => {
    const mockDeeplink = { action: 'unknown', payload: {} };
    (parseCapDeeplink as any).mockReturnValue(mockDeeplink);

    const result = handler.handle('cap://unknown');

    expect(result).toEqual({ success: false, error: 'Unsupported action: unknown' });
  });
});
