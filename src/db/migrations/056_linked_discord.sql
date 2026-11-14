-- A linked workspace can connect a Discord server of its own (it used its main's until now). Then
-- it has its own ticket panel there, and its own contributor roles, announcements and bot features,
-- with only its own apps; its apps can stay on the main's panel too (on_main_panel).
-- own_discord: the workspace has a discord_connections row of its own (every connected main, and a
-- linked workspace with its own server). Kept in step by saveDiscordGuild and deleteDiscordConnection.
ALTER TABLE workspaces ADD COLUMN own_discord INTEGER NOT NULL DEFAULT 0;
UPDATE workspaces SET own_discord = 1 WHERE id IN (SELECT workspace_id FROM discord_connections);

-- A one-time link for whoever runs that server: they add the bot through it without an account here
-- (like the GitHub install link). Hashed for lookup, kept encrypted so admins can copy it again.
ALTER TABLE workspaces ADD COLUMN discord_link_hash TEXT;
ALTER TABLE workspaces ADD COLUMN discord_link_enc TEXT;
ALTER TABLE workspaces ADD COLUMN discord_link_expires_at INTEGER;
CREATE INDEX workspaces_discord_link_idx ON workspaces(discord_link_hash);
