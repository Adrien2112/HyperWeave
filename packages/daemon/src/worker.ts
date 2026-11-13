import { parentPort, workerData } from 'node:worker_threads';
import { Archive } from '../../core/src/index.js';
import { ArchiveError, now } from '../../protocol/src/index.js';
import { dispatch } from './dispatch.js';
const port = parentPort!;
const archive = new Archive(workerData.directory);
const snapshot = () => ({ value: archive.status(), observed_at: now() });
port.postMessage({ type: 'ready', snapshot: snapshot() });
// The parent submits only one operation at a time. This is also serialized here
// so asynchronous backup cannot overlap a later write or shutdown.
let queue = Promise.resolve();
port.on('message', message => {
  queue = queue.then(async () => {
    if (message.type === 'close') { archive.close(); port.postMessage({ type: 'closed' }); port.close(); return; }
    let response: unknown;
    try { response = { ok: true, result: await dispatch(archive, message.method, message.params) }; }
    catch (error) { response = { ok: false, error: error instanceof ArchiveError ? error.toJSON() : new ArchiveError('INVALID_REQUEST', error instanceof Error ? error.message : 'Operation failed').toJSON() }; }
    // If computing the status fails, do not mask the operation's committed result.
    let current;
    try { current = snapshot(); } catch { current = undefined; }
    port.postMessage({ type: 'result', id: message.id, response, snapshot: current });
  });
});
