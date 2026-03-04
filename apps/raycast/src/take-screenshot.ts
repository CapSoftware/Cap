import { dispatchAction } from './utils';
import { showToast, Toast } from '@raycast/api';

export default async function takeScreenshot() {
  await showToast({ style: Toast.Style.Animated, title: 'Taking screenshot...' });

  try {
    await dispatchAction({
      take_screenshot: {
        capture_mode: null,
      },
    });
    await showToast({ style: Toast.Style.Success, title: 'Screenshot taken' });
  } catch {
    await showToast({
      style: Toast.Style.Failure,
      title: 'Failed to communicate with Cap',
      message: 'Make sure Cap is running.',
    });
  }
}
