import { EventEmitter } from 'node:events';

// One process, one bus. Every open SSE connection subscribes to it.
export const bus = new EventEmitter();

// Each open tab adds a listener, so the default cap of 10 would start warning
// once a few windows are open.
bus.setMaxListeners(0);

// `origin` is the id of the client that caused the change, so that client can
// ignore the echo of its own edit. Anything server-side (a Claude session
// POSTing over the API) has no id, so every browser hears it.
export function publish(type, payload, origin = null) {
  bus.emit('notes', { type, origin, ...payload });
}
