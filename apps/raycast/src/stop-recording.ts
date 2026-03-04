import { fireSimpleAction } from './utils';

export default async function stopRecording() {
  await fireSimpleAction('stop_recording', 'Recording stopped');
}
