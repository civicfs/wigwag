import type { RenderItem } from '../broker/render.js';
import type { Agent, SessionRow } from '../store/sessions.js';

export interface Transport {
  readonly kind: 'claude-channel' | 'codex-queue';
  push(
    session: SessionRow,
    items: RenderItem[],
    options?: { signal?: AbortSignal; onPushed?: (items: RenderItem[]) => void },
  ): Promise<void>;
  /** False when the live session cannot take this transport's pushes at all (Claude without the channel, E-3); absent means it can. */
  hasChannel?(session: SessionRow): boolean;
  /** Why this item can never be pushed by this transport (deterministic, so not worth retrying); null if it can. */
  tooLarge?(item: RenderItem): string | null;
}

export interface TransportRegistry {
  claude: Transport;
  codex: Transport;
}

/** Iteration-2 provision (spec §16 P4). No implementations in v1. */
export interface LaunchSpec {
  agent: Agent;
  name: string;
  cwd: string;
  prompt: string;
  model?: string;
  worktree?: boolean;
}

/** Iteration-2 provision (spec §16 P4). No implementations in v1. */
export interface Launcher {
  launch(spec: LaunchSpec): Promise<{ agent_session_id: string; attach_hint: string }>;
  stop(agentSessionId: string): Promise<void>;
}
