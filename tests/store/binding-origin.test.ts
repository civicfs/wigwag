import { join } from 'node:path';
import { expect, it } from 'vitest';
import { bindingOrigin, provenUntrustedBinding, recordBindingOrigin } from '../../src/store/binding-origin.js';
import { openDb } from '../../src/store/db.js';
import { adoptCanonical, recoveryCandidates } from '../../src/store/recovery.js';
import {
  bindAgentSession,
  claimName,
  createSession,
  getSession,
  type SessionRow,
  setState,
} from '../../src/store/sessions.js';
import { tmpHome } from '../helpers.js';

it('preserves positive origin evidence across restart without treating the default as proof', () => {
  const file = join(tmpHome(), 'state.db');
  let db = openDb(file);
  try {
    const s = createSession(db, { agent: 'claude', cwd: '/w', workspace: '/w', pid_chain: [], mcp_ppid: null });
    bindAgentSession(db, s.id, 'N');
    const current = () => getSession(db, s.id) as SessionRow;
    expect(current().bind_origin).toBe('unverified');
    expect(provenUntrustedBinding(db, current())).toBe(false);
    recordBindingOrigin(db, current(), 'raw-bind');
    db.close();
    db = openDb(file);
    expect(bindingOrigin(db, current())).toBe('raw-bind');
    expect(provenUntrustedBinding(db, current())).toBe(true);
    bindAgentSession(db, s.id, 'different-N');
    expect(bindingOrigin(db, current())).toBeNull();
    expect(provenUntrustedBinding(db, current())).toBe(false);
  } finally {
    db.close();
  }
});

it('revalidates positive raw provenance inside adoption and allows a later own-hook upgrade', () => {
  const db = openDb(join(tmpHome(), 'state.db'));
  try {
    const canonical = createSession(db, { agent: 'claude', cwd: '/w', workspace: '/w', pid_chain: [], mcp_ppid: null });
    claimName(db, canonical.id, 'old-worker', 'custom');
    bindAgentSession(db, canonical.id, 'N');
    setState(db, canonical.id, 'offline');
    const fresh = createSession(db, { agent: 'claude', cwd: '/w', workspace: '/w', pid_chain: [], mcp_ppid: null });
    const query = { agent: 'claude' as const, native: 'N', workspace: '/w', exceptId: fresh.id };
    expect(recoveryCandidates(db, query).map((s) => s.id)).toEqual([canonical.id]);
    recordBindingOrigin(db, getSession(db, canonical.id) as SessionRow, 'raw-bind');
    expect(recoveryCandidates(db, query)).toEqual([]);
    const input = {
      provisionalId: fresh.id,
      canonicalId: canonical.id,
      native: 'N',
      state: 'online-idle' as const,
      evidence: {},
    };
    expect(adoptCanonical(db, input)).toMatchObject({ ok: false, reason: 'canonical-changed' });
    recordBindingOrigin(db, getSession(db, canonical.id) as SessionRow, 'hook-verified');
    expect(adoptCanonical(db, input)).toMatchObject({ ok: true });
  } finally {
    db.close();
  }
});
