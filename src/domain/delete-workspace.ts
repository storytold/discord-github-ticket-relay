import { rm } from 'node:fs/promises';
import { filePathFor } from './files.js';
import { listLinked } from './linked.js';
import { UserFacingError, type Deps } from './types.js';
import { getWorkspace } from './workspaces.js';

/**
 * Deletes a workspace and everything in it. Its rows go with it (every table that belongs to a
 * workspace cascades); outside the database, the messages the bot keeps up to date in Discord (the
 * ticket panel, contributor roles panel, known-issues board, update-pings panel) are taken down,
 * since their buttons would stop working, and its stored files are removed from disk. Release posts
 * stay in Discord and the issues stay on GitHub. A main with linked workspaces can't be deleted
 * until they are.
 */
export async function deleteWorkspace(deps: Deps, workspaceId: string): Promise<void> {
  const ws = await getWorkspace(deps.db, workspaceId);
  if (!ws) return;
  const linked = await listLinked(deps.db, workspaceId);
  if (linked.length) throw new UserFacingError(`Delete its linked workspaces first: ${linked.map((l) => l.name).join(', ')}.`);

  // Read before the rows are gone, cleaned up after, so a failed delete leaves everything in place.
  const { rows: messages } = await deps.db.query<{ channel_id: string; message_id: string }>(
    `SELECT channel_id, message_id FROM panels WHERE workspace_id = $1
     UNION ALL SELECT channel_id, message_id FROM contributor_panels WHERE workspace_id = $1
     UNION ALL SELECT channel_id, message_id FROM known_issue_boards WHERE workspace_id = $1
     UNION ALL SELECT channel_id, message_id FROM announcement_panels WHERE workspace_id = $1`,
    [workspaceId],
  );
  const { rows: files } = await deps.db.query<{ id: string; ext: string }>(
    `SELECT id, ext FROM ticket_files WHERE workspace_id = $1 AND status = 'stored' AND ext IS NOT NULL`,
    [workspaceId],
  );

  await deps.db.query('DELETE FROM workspaces WHERE id = $1', [workspaceId]);

  if (deps.discord) {
    for (const m of messages) await deps.discord.deleteMessage(m.channel_id, m.message_id).catch(() => {});
  }
  for (const f of files) await rm(filePathFor(deps, f), { force: true }).catch(() => {});
  deps.log.info({ workspace: workspaceId, name: ws.name, messages: messages.length, files: files.length }, 'workspace deleted');
}
