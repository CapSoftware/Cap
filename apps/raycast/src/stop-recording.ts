import { fireSimpleAction } from './utils';

export default async function stopRecording() {
  await fireSimpleAction('stop_recording', 'Stopping recording…', 'Recording stopped');
}
