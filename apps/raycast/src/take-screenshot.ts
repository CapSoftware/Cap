import { dispatchAction } from './utils';
import { showToast, Toast } from '@raycast/api';

export default async function takeScreenshot() {
  await showToast({ style: Toast.Style.Animated, title: 'Taking screenshot...' });

  await dispatchAction({
    take_screenshot: {
      capture_mode: null,
    },
  });

  await showToast({ style: Toast.Style.Success, title: 'Screenshot taken' });
}
