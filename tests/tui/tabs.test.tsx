/** @jsxImportSource react */
import { describe, expect, it } from 'vitest';
import { until } from '../helpers.js';
import { mount } from './harness.js';

const LABELS = ['1 Feed', '2 Deliveries', '3 Requests', '4 KV', '5 Streams', '6 Blobs', '7 Links'];

describe('tab bar layout', () => {
  for (const columns of [200, 80, 60]) {
    it(`shows all 7 tabs with their number keys at ${columns} columns, untruncated`, async () => {
      const ui = mount({ sessions: [], feed: [], deliveries: [], throttles: [] }, () => ({}), columns, 24);
      await until(() => ui.frame().includes('1 Feed'));
      const frame = ui.frame();
      for (const label of LABELS) expect(frame, label).toContain(label);
      expect(frame).not.toContain('…');
      ui.app.unmount();
    });
  }
});
