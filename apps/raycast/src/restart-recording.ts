import { fireSimpleAction } from './utils';

export default async function restartRecording() {
  await fireSimpleAction('restart_recording', 'Restarting recording…', 'Recording restarted');
}
