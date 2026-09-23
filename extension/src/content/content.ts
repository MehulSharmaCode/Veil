// Content script entry (top frame only). Answers the side panel: ping, snapshot, inspect, execute.
// Holds no agent state and no values beyond the single call that uses them.

import { extensionVersion, onContentRequest } from '../platform/chrome';
import type { ContentRequest, ContentResponse } from '../shared/messages';
import { elementById } from './dom';
import { execute } from './execute';
import { describeElement, takeSnapshot } from './snapshot';

declare global {
  // eslint-disable-next-line no-var
  var __veilContentLoaded: boolean | undefined;
}

async function handle(msg: ContentRequest): Promise<ContentResponse> {
  switch (msg?.type) {
    case 'ping':
      return { ok: true, version: extensionVersion() };
    case 'snapshot':
      return { ok: true, snapshot: takeSnapshot() };
    case 'inspect': {
      const el = elementById(msg.id);
      if (!el) return { ok: true, exists: false };
      if (msg.scrollIntoView) {
        el.scrollIntoView({ block: 'center', inline: 'nearest' });
        await new Promise((r) => requestAnimationFrame(() => r(null)));
      }
      return { ok: true, exists: true, element: describeElement(el) };
    }
    case 'execute':
      return execute(msg.command, msg.expectedFingerprint);
    default:
      return { ok: false, error: 'unknown_request' };
  }
}

if (!globalThis.__veilContentLoaded) {
  globalThis.__veilContentLoaded = true;
  onContentRequest(handle);
}
