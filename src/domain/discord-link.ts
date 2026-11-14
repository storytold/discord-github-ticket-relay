/**
 * Discord links: a workspace's owner or admins send one to whoever runs a Discord server (often a
 * linked workspace's own community server), who adds the bot through it without an account here.
 * Discord still checks that they can manage the server they pick. One link per workspace at a time;
 * it works once and expires after 7 days. It's kept encrypted, so admins can copy it again until
 * it's used. Mirrors the GitHub install link (github-link.ts).
 */
import { unpublishPingPanel } from '../announcements/pings.js';
import { unpublishBoard } from '../bot-features/known-issues.js';
import type { Queryable } from '../db/database.js';
import { randomToken, sha256 } from '../lib/crypto.js';
import { unpublishContributorPanel } from './contributors.js';
import { setOnMainPanel, usesMainServer } from './linked.js';
import { unpublishPanel } from './panel.js';
import { deleteDiscordConnection, saveDiscordGuild } from './store.js';
import type { Deps, WorkspaceRow } from './types.js';
import { getWorkspace } from './workspaces.js';

export const DISCORD_LINK_DAYS = 7;

/** Makes a new link (the old one stops working) and returns its token. */
export async function createDiscordLink(deps: Pick<Deps, 'db' | 'box'>, workspaceId: string): Promise<string> {
  const token = randomToken(24);
  await deps.db.query(
    'UPDATE workspaces SET discord_link_hash = $2, discord_link_enc = $3, discord_link_expires_at = now_ms() + $4, updated_at = now_ms() WHERE id = $1',
    [workspaceId, sha256(token), deps.box.encrypt(token), DISCORD_LINK_DAYS * 86_400_000],
  );
  return token;
}

/** The workspace's link while it works: its token (for the address) and when it expires. */
export function currentDiscordLink(deps: Pick<Deps, 'box'>, ws: WorkspaceRow): { token: string; expiresAt: Date } | null {
  if (!ws.discord_link_enc || !ws.discord_link_expires_at || ws.discord_link_expires_at.getTime() <= Date.now()) return null;
  try {
    return { token: deps.box.decrypt(ws.discord_link_enc), expiresAt: ws.discord_link_expires_at };
  } catch {
    return null;
  }
}

export async function clearDiscordLink(q: Queryable, workspaceId: string): Promise<void> {
  await q.query('UPDATE workspaces SET discord_link_hash = NULL, discord_link_enc = NULL, discord_link_expires_at = NULL, updated_at = now_ms() WHERE id = $1', [workspaceId]);
}

/** The workspace a link belongs to, while it works. */
export async function findDiscordLink(q: Queryable, token: string): Promise<WorkspaceRow | null> {
  if (!token || token.length > 200) return null;
  const { rows } = await q.query<WorkspaceRow>('SELECT * FROM workspaces WHERE discord_link_hash = $1 AND discord_link_expires_at > now_ms()', [sha256(token)]);
  return rows[0] ?? null;
}

/** Whether a link (by its hash, as kept in the OAuth state) still belongs to this workspace and works. */
export async function discordLinkValid(q: Queryable, workspaceId: string, hash: unknown): Promise<boolean> {
  if (typeof hash !== 'string') return false;
  const { rows } = await q.query('SELECT 1 FROM workspaces WHERE id = $1 AND discord_link_hash = $2 AND discord_link_expires_at > now_ms()', [workspaceId, hash]);
  return rows.length > 0;
}

/**
 * Binds a server to the workspace. A linked workspace that used its main's server takes its own
 * panel down there (if it had one): from now on it's posted in its own server.
 */
export async function connectDiscordServer(deps: Deps, workspaceId: string, guild: { id: string; name: string; icon: string | null }, userId: string | null): Promise<void> {
  const ws = await getWorkspace(deps.db, workspaceId);
  const leavingMain = Boolean(ws && usesMainServer(ws));
  await saveDiscordGuild(deps.db, workspaceId, guild, userId);
  if (leavingMain) await unpublishPanel(deps, workspaceId);
}

/**
 * A linked workspace stops using its own server and goes back to its main's: what it posted there
 * comes down (the ticket panel, contributor roles panel, known-issues board and update-pings
 * message; their settings are kept), and its apps go on the main's panel so tickets keep coming.
 */
export async function leaveOwnServer(deps: Deps, workspaceId: string): Promise<void> {
  await unpublishPanel(deps, workspaceId);
  await unpublishContributorPanel(deps, workspaceId);
  await unpublishBoard(deps, workspaceId);
  await unpublishPingPanel(deps, workspaceId);
  await deleteDiscordConnection(deps.db, workspaceId);
  await setOnMainPanel(deps.db, workspaceId, true);
}
