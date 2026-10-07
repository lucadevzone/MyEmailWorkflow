import { EventEmitter } from 'node:events';
import type { ServerEvent } from '@mmw/shared';

// Bus degli eventi interni, inoltrati all'interfaccia via SSE.
class EventBus extends EventEmitter {
  publish(event: ServerEvent) {
    this.emit('event', event);
  }
  subscribe(fn: (e: ServerEvent) => void): () => void {
    this.on('event', fn);
    return () => this.off('event', fn);
  }
}

export const bus = new EventBus();
bus.setMaxListeners(100);
