import { open, showToast, Toast } from '@raycast/api';

const DEEPLINK_SCHEME = 'cap-desktop://action';

export async function dispatchAction(action: string | Record<string, unknown>) {
  const valueJson = JSON.stringify(action);
  const url = `${DEEPLINK_SCHEME}?value=${encodeURIComponent(valueJson)}`;
  await open(url);
}

export async function fireSimpleAction(action: string, label: string) {
  await showToast({ style: Toast.Style.Animated, title: `${label}...` });
  try {
    await dispatchAction(action);
    await showToast({ style: Toast.Style.Success, title: label });
  } catch {
    await showToast({
      style: Toast.Style.Failure,
      title: 'Failed to communicate with Cap',
      message: 'Make sure Cap is running.',
    });
  }
}
