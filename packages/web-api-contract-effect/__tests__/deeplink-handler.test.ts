import { describe, it, expect, vi, beforeEach } from 'vitest';
import { CapDeeplinkHandler } from '../deeplink-handler';
import { parseCapDeeplink } from '@cap/utils';

vi.mock('@cap/utils', () => ({
  parseCapDeeplink: vi.fn(),
}));

describe('CapDeeplinkHandler', () => {
  let handler: CapDeeplinkHandler;
  const mockPause = vi.fn();

  beforeEach(() => {
    handler = new CapDeeplinkHandler();
    handler.registerAction('pause', mockPause);
    vi.clearAllMocks();
  });

  it('should handle valid pause deeplink', () => {
    const deeplink = { action: 'pause', params: {} };
    vi.mocked(parseCapDeeplink).mockReturnValue(deeplink);

    handler.handle('cap://pause');

    expect(parseCapDeeplink).toHaveBeenCalledWith('cap://pause');
    expect(mockPause).toHaveBeenCalledWith({});
  });

  it('should not call action for invalid deeplink', () => {
    vi.mocked(parseCapDeeplink).mockReturnValue(null);

    handler.handle('invalid://link');

    expect(mockPause).not.toHaveBeenCalled();
  });

  it('should not call action for unregistered action', () => {
    const deeplink = { action: 'unknown', params: {} };
    vi.mocked(parseCapDeeplink).mockReturnValue(deeplink);

    handler.handle('cap://unknown');

    expect(mockPause).not.toHaveBeenCalled();
  });
});
