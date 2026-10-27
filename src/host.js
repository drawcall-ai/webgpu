import { globals } from './globals.js';
import { installImages } from './image.js';
import { installWorkers } from './worker.js';

let host;
let closing;

// Only canvases need loader and animation support; compute leaves it untouched.
export async function acquireHost(native) {
  while (closing) await closing;
  host ??= install(native);
  const current = host;
  current.users++;
  let released = false;
  return async () => {
    if (released) return;
    released = true;
    if (--current.users) return;
    host = undefined;
    closing = current.close().finally(() => { closing = undefined; });
    await closing;
  };
}

function install(native) {
  const installed = globals();
  const frames = new Set();
  let restoreImages, restoreWorkers;
  async function close() {
    const failures = [];
    for (const action of [
      () => { for (const frame of frames) clearTimeout(frame); frames.clear(); },
      () => restoreWorkers?.(),
      () => restoreImages?.(),
      () => installed.restore(),
    ]) {
      try { await action(); } catch (error) { failures.push(error); }
    }
    if (failures.length) throw new AggregateError(failures, 'Canvas platform cleanup failed');
  }
  try {
    installed.set('self', globalThis);
    installed.set('ProgressEvent', class extends Event {
      constructor(type, values = {}) { super(type); Object.assign(this, values); }
    });
    installed.set('requestAnimationFrame', callback => {
      const frame = setTimeout(() => { frames.delete(frame); callback(performance.now()); });
      frames.add(frame);
      return frame;
    });
    installed.set('cancelAnimationFrame', frame => { clearTimeout(frame); frames.delete(frame); });
    restoreImages = installImages(native);
    restoreWorkers = installWorkers();
    return { users: 0, close };
  } catch (error) {
    // Installation is synchronous; these restorations do not need worker teardown
    // unless installWorkers completed, after which installation cannot fail.
    restoreImages?.();
    installed.restore();
    throw error;
  }
}
