import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { DiscordGuildSummary } from '../../discord/client.js';
import { BOT_INSTALL_PERMISSIONS, canManageGuild, REQUIRED_CHANNEL_PERMISSIONS } from '../../discord/permissions.js';
import { inspectGuild } from '../../domain/discord-checks.js';
import { clearDiscordLink, connectDiscordServer, createDiscordLink, currentDiscordLink, DISCORD_LINK_DAYS, findDiscordLink, leaveOwnServer } from '../../domain/discord-link.js';
import { listLinked, mainOf, usesMainServer } from '../../domain/linked.js';
import { createState } from '../../domain/oauth-state.js';
import { unpublishPanel } from '../../domain/panel.js';
import { getContributorSettings, inspectRoles } from '../../domain/contributors.js';
import { deleteDiscordConnection, getDiscordConnection } from '../../domain/store.js';
import { UserFacingError } from '../../domain/types.js';
import { sha256 } from '../../lib/crypto.js';
import { html } from '../../lib/html.js';
import { botIdentity } from '../discord-preview.js';
import { simplePage } from '../layout.js';
import { avatar, copyField, empty, icon, linkBtn, menu, notice, pageHeader, pill, postBtn, setting, tag, timeAgo } from '../ui.js';
import { checklist } from './panel.js';
import { setFlash } from '../session.js';
import type { Web } from '../server.js';

function guildIcon(g: { id: string; icon: string | null }): string | null {
  return g.icon ? `https://cdn.discordapp.com/icons/${g.id}/${g.icon}.png?size=64` : null;
}

export function registerDiscordRoutes(app: FastifyInstance, web: Web): void {
  const { deps } = web;
  const discordRedirect = web.publicUrl('/oauth/discord/callback');

  /** Servers the signed-in admin can manage, using the token from their Discord sign-in. */
  async function manageableGuilds(req: FastifyRequest): Promise<DiscordGuildSummary[] | null> {
    const s = req.auth!.session;
    if (!deps.discord || !s.discord_access_token_enc || !s.discord_token_expires_at || s.discord_token_expires_at < new Date()) return null;
    try {
      const guilds = await deps.discord.listUserGuilds(deps.box.decrypt(s.discord_access_token_enc));
      return guilds.filter(canManageGuild);
    } catch {
      return null;
    }
  }

  app.get('/w/:wid/setup/discord', async (req, reply) => {
    const ctx = await web.requireWorkspace(req, reply);
    if (!ctx) return reply;
    const b = ctx.base;
    const wid = ctx.workspace.id;
    const conn = await getDiscordConnection(deps.db, wid);
    const main = await mainOf(deps.db, ctx.workspace);
    const changing = (req.query as { change?: string }).change === '1';
    // A linked workspace using its main's server: shown here, changed there. Or it connects its own.
    if (main && usesMainServer(ctx.workspace) && !changing) {
      const canOpenMain = (ctx.memberships ?? []).some((x) => x.workspace.id === main.id);
      const own = !ctx.workspace.on_main_panel;
      const name = ctx.workspace.name;
      const link = currentDiscordLink(deps, ctx.workspace);
      const publicBot = 'Discord only lets them add the bot while Public Bot is on (Developer Portal › your app › Bot).';
      const body = html`
        ${pageHeader({ eyebrow: 'Setup · Step 2 of 3', title: 'Discord', after: !conn ? pill('Not connected', 'neutral') : conn.status === 'active' ? pill('Connected', 'ok') : pill('Bot removed', 'danger'), description: `${name} uses ${main.name}’s Discord server. It’s connected and changed there.` })}
        ${!deps.discord ? notice('warn', 'The Discord application isn’t registered for this deployment yet', 'Whoever runs the server needs to finish the deployment setup first.') : ''}
        <div class="card">
          <div class="card-h"><div><h2>Connection</h2><div class="desc">From ${main.name}.</div></div>${canOpenMain ? linkBtn(`/w/${main.id}/setup/discord`, `Open in ${main.name}`, { size: 'sm', variant: 'ghost', trail: 'arrow-right' }) : ''}</div>
          ${conn
            ? setting('Server', null, html`<span class="row">${avatar(conn.guild_name, 32, { src: guildIcon({ id: conn.guild_id, icon: conn.guild_icon }), square: true, letters: 2 })}<span class="name">${conn.guild_name}</span></span>`)
            : html`<div class="card-b"><p class="small muted">${main.name} hasn’t connected a Discord server yet.</p></div>`}
          ${setting('Ticket panel', null, html`<span class="value">${own ? (conn?.tickets_channel_name ? `Its own, in #${conn.tickets_channel_name}` : 'Its own, no channel chosen yet') : `On ${main.name}’s panel`}</span>${linkBtn(`${b}/tickets/panel`, 'Open', { variant: 'ghost', size: 'sm', trail: 'arrow-right' })}`)}
        </div>
        <div class="card" id="own-server">
          <div class="card-h"><div><h2>Its own Discord server</h2><div class="desc">For a community with a server of its own. ${name} gets a ticket panel there that lists only its apps, and its own contributor roles, announcements and bot features. Nothing there reaches ${main.name}’s server. Its apps can stay on ${main.name}’s panel too.</div></div>
            ${deps.discord ? linkBtn(`${b}/setup/discord?change=1`, 'Choose a server you manage', { size: 'sm', variant: 'ghost', trail: 'arrow-right' }) : ''}</div>
          ${link
            ? html`<div class="card-b"><div class="field"><label for="discord-link-url">Link for the server’s admin</label>${copyField('discord-link-url', web.publicUrl(`/discord/connect/${link.token}`), 'Discord link')}
                <div class="hint">Expires ${timeAgo(link.expiresAt)}. Send it privately, for example in a Discord DM. ${publicBot}</div></div></div>
              <div class="card-f plain"><span></span><div class="end">
                ${postBtn(`${b}/setup/discord/share/revoke`, 'Stop this link', ctx.csrf, { variant: 'ghost', icon: 'link-2-off' })}
                ${postBtn(`${b}/setup/discord/share`, 'Make a new link', ctx.csrf, { icon: 'refresh-cw', disabled: !deps.discord })}
              </div></div>`
            : html`<div class="card-f plain"><span class="small muted">Someone else runs the server? Send them a link: they add the bot and pick their server, without an account here. It works once and expires after ${DISCORD_LINK_DAYS} days.</span>
                <div class="end">${postBtn(`${b}/setup/discord/share`, 'Create a link', ctx.csrf, { icon: 'link', disabled: !deps.discord })}</div></div>`}
        </div>`;
      return web.render(reply, ctx, 'Discord', 'discord', body);
    }
    const status = !conn ? pill('Not connected', 'neutral') : conn.status === 'active' ? pill('Connected', 'ok') : pill('Bot removed', 'danger');
    const perms = REQUIRED_CHANNEL_PERMISSIONS.map((p) => p.name).join(', ');

    // ---- Server picker (first connection, or "Change server")
    let picker = html``;
    if (deps.discord && (!conn || changing)) {
      const [mine, botGuilds] = await Promise.all([manageableGuilds(req), deps.discord.listBotGuilds().catch(() => null)]);
      const botIn = new Set((botGuilds ?? []).map((g) => g.id));
      let claimed = new Map<string, string>();
      if (mine?.length) {
        const { rows } = await deps.db.query<{ guild_id: string; workspace_id: string }>(
          'SELECT guild_id, workspace_id FROM discord_connections WHERE guild_id IN (SELECT value FROM json_each($1)) AND workspace_id <> $2',
          [mine.map((g) => g.id), wid],
        );
        claimed = new Map(rows.map((r) => [r.guild_id, r.workspace_id]));
      }
      picker = html`<div class="card">
        <div class="card-h"><div><h2>${main ? `Choose ${ctx.workspace.name}’s own server` : 'Choose your Discord server'}</h2><div class="desc">You need the Manage Server permission. Adding the bot opens Discord, where you confirm the server and the bot’s permissions.</div></div>${changing && conn ? linkBtn(`${b}/setup/discord`, 'Cancel', { size: 'sm', variant: 'ghost' }) : ''}</div>
        ${mine === null
          ? html`<div class="card-b">${notice('info', 'Your server list isn’t available right now', 'Sign out and in again to refresh it. You can still add the bot and pick the server in Discord.')}</div>`
          : mine.length === 0
            ? empty('message-circle', 'No servers found', 'You don’t manage any Discord servers with this account. Ask a server admin to sign in here, or add the bot directly.')
            : html`<div>${mine.map((g) => {
                const action = claimed.has(g.id)
                  ? tag(main && claimed.get(g.id) === main.id ? `${main.name}’s server` : 'Used by another workspace')
                  : botIn.has(g.id)
                    ? postBtn(`${b}/setup/discord/server`, 'Use this server', ctx.csrf, { variant: 'primary', size: 'sm', fields: { guild_id: g.id } })
                    : postBtn(`${b}/setup/discord/install`, 'Add bot', ctx.csrf, { size: 'sm', icon: 'plus', fields: { guild_id: g.id } });
                return html`<div class="line">${avatar(g.name, 32, { src: guildIcon(g), square: true, letters: 2 })}<div class="grow"><div class="name truncate">${g.name}</div><div class="sub">${botIn.has(g.id) ? 'Bot already added' : 'Bot not added yet'}</div></div>${action}</div>`;
              })}</div>`}
        <div class="card-f"><span class="xs muted">The bot asks for ${perms}.</span><div class="end">${postBtn(`${b}/setup/discord/install`, 'Add the bot to a server…', ctx.csrf, { icon: 'bot' })}</div></div>
      </div>`;
    }

    // ---- Connected server: identity, permissions and channels in use
    let connected = html``;
    if (conn && !changing) {
      const [access, roles, contributor, bot] = deps.discord && conn.status === 'active'
        ? await Promise.all([inspectGuild(deps.discord, conn.guild_id), inspectRoles(deps.discord, conn.guild_id), getContributorSettings(deps.db, wid), botIdentity(deps)])
        : [null, null, await getContributorSettings(deps.db, wid), await botIdentity(deps)];
      const checks: { status: 'ok' | 'warning' | 'error'; title: string; detail?: string; fix?: { label: string; href: string } }[] = [];
      if (access && !access.ok) checks.push({ status: 'error', title: access.message });
      if (access?.ok) {
        checks.push({ status: 'ok', title: 'Bot is in the server' });
        if (roles?.ok) checks.push(roles.canManageRoles ? { status: 'ok', title: 'Manage Roles', detail: 'needed by Contributor roles' } : { status: 'warning', title: 'Missing Manage Roles', detail: 'needed by Contributor roles. Server Settings › Roles › the bot’s role.' });
        for (const [label, id, href] of [['tickets', conn.tickets_channel_id, `${b}/tickets/panel#channel`], ['verify', contributor.channel_id, `${b}/contributors/panel#channel`]] as const) {
          if (!id) continue;
          const ch = access.channels.find((c) => c.id === id);
          if (!ch) checks.push({ status: 'error', title: `The ${label} channel no longer exists or is hidden from the bot`, fix: { label: 'Choose channel', href } });
          else if (ch.missing.length) checks.push({ status: 'error', title: `Missing permissions in #${ch.name}`, detail: ch.missing.join(', '), fix: { label: 'Check again', href: `${b}/setup/discord` } });
          else checks.push({ status: 'ok', title: `Can post in #${ch.name}` });
        }
      }
      const channelLine = (name: string | null, what: string, href: string) => html`<div class="line">${icon('hash', 14, 'muted')}<span class="grow">${name ? html`<span class="name">#${name}</span>` : html`<span class="muted">No channel yet</span>`}<span class="small muted"> · ${what}</span></span>${linkBtn(href, name ? 'Open' : 'Choose', { variant: 'ghost', size: 'sm', trail: 'arrow-right' })}</div>`;
      connected = html`
        ${conn.status_detail && conn.status !== 'active' ? notice('danger', conn.status_detail, 'Add the bot to the server again, or connect another server.', {
          action: postBtn(`${b}/setup/discord/install`, 'Add the bot again', ctx.csrf, { size: 'sm', fields: { guild_id: conn.guild_id } }),
        }) : ''}
        <div class="card">
          <div class="card-h"><h2>Connection</h2></div>
          ${setting('Server', null, html`<span class="row">${avatar(conn.guild_name, 32, { src: guildIcon({ id: conn.guild_id, icon: conn.guild_icon }), square: true, letters: 2 })}<span class="name">${conn.guild_name}</span><span class="mono muted">ID ${conn.guild_id}</span></span>`)}
          ${setting('Bot', null, html`<span class="row">${icon('bot', 16, 'muted')}<span>${bot.name}</span>${tag('APP')}</span>`)}
        </div>
        ${checks.length ? html`<div class="card"><div class="card-h"><div><h2>Permissions</h2><div class="desc">The bot needs ${perms} in each panel channel.</div></div>${linkBtn(`${b}/setup/discord`, 'Check again', { variant: 'ghost', size: 'sm', icon: 'refresh-cw' })}</div>
          <div class="card-b tight">${checklist(checks)}</div></div>` : ''}
        <div class="card">
          <div class="card-h"><div><h2>Channels in use</h2><div class="desc">Each tool picks its own channel on its Panel tab.</div></div></div>
          ${channelLine(conn.tickets_channel_name, 'Discord tickets panel', `${b}/tickets/panel#channel`)}
          ${channelLine(contributor.channel_name, 'Contributor roles panel', `${b}/contributors/panel#channel`)}
        </div>`;
    }

    // A linked workspace with its own server goes back to its main's instead of disconnecting.
    const leave = main
      ? { post: `${b}/setup/discord/disconnect`, label: `Go back to ${main.name}’s server…`, icon: 'unplug' as const, danger: true, confirm: { title: `Stop using ${conn?.guild_name ?? 'this server'}?`, body: `Its panels there are taken down and ${ctx.workspace.name} uses ${main.name}’s server again, with its apps on ${main.name}’s panel. Contributor roles, announcements and bot features are hidden again; their settings are kept.`, label: 'Go back', danger: true } }
      : { post: `${b}/setup/discord/disconnect`, label: 'Disconnect Discord…', icon: 'unplug' as const, danger: true, confirm: { title: 'Disconnect Discord?', body: 'The ticket panel is removed and members can’t open tickets until you reconnect. History is kept.', label: 'Disconnect', danger: true } };
    const body = html`
      ${pageHeader({
        eyebrow: 'Setup · Step 2 of 3',
        title: 'Discord',
        after: main && usesMainServer(ctx.workspace) ? undefined : status,
        description: !main
          ? 'The bot posts the panels in your server. Each workspace connects one server.'
          : usesMainServer(ctx.workspace)
            ? `Choose a server for ${ctx.workspace.name}. Its panels and tools post there, with only its apps; ${main.name}’s server isn’t affected.`
            : `${ctx.workspace.name} has its own Discord server. Its panels and tools post there, with only its apps; ${main.name}’s server isn’t affected.`,
        actions: conn && !changing
          ? menu([{ href: `${b}/setup/discord?change=1`, label: 'Change server', icon: 'arrow-left-right' }, 'sep', leave], { csrf: ctx.csrf, size: 'md' })
          : undefined,
      })}
      ${!deps.discord ? notice('warn', 'The Discord application isn’t registered for this deployment yet', 'Whoever runs the server needs to finish the deployment setup first.', { action: linkBtn(`${b}/deployment`, 'Open Deployment', { size: 'sm' }) }) : ''}
      ${connected}
      ${picker}`;
    return web.render(reply, ctx, 'Discord', 'discord', body);
  });

  app.post('/w/:wid/setup/discord/server', async (req, reply) => {
    const ctx = await web.requireWorkspace(req, reply);
    if (!ctx) return reply;
    if (!deps.discord) return reply.redirect(`${ctx.base}/setup/discord`);
    const guildId = String((req.body as { guild_id?: string }).guild_id ?? '');
    const back = `${ctx.base}/setup/discord`;
    try {
      const mine = await manageableGuilds(req);
      // Server-side checks: the admin manages this server and the bot is in it.
      if (!mine?.some((g) => g.id === guildId)) throw new UserFacingError('You need the Manage Server permission on that server (sign out and in again if you just got it).');
      const access = await inspectGuild(deps.discord, guildId);
      if (!access.ok) throw new UserFacingError(access.message);
      await connectDiscordServer(deps, ctx.workspace.id, access.guild, ctx.user.id);
      setFlash(reply, 'success', `Connected to “${access.guild.name}”. Choose the tickets channel in Discord tickets › Panel.`);
    } catch (err) {
      if (!(err instanceof UserFacingError)) throw err;
      setFlash(reply, 'error', err.message);
    }
    return reply.redirect(back);
  });

  app.post('/w/:wid/setup/discord/disconnect', async (req, reply) => {
    const ctx = await web.requireWorkspace(req, reply);
    if (!ctx) return reply;
    const ws = ctx.workspace;
    if (ws.parent_id) {
      if (usesMainServer(ws)) return reply.redirect(`${ctx.base}/setup/discord`);
      const main = (await mainOf(deps.db, ws))!;
      await leaveOwnServer(deps, ws.id);
      setFlash(reply, 'success', `${ws.name} uses ${main.name}’s server again, and its apps are on ${main.name}’s panel${main.my_tickets ? '' : ` once ${main.name}’s panel is published`}. You can remove the bot from its old server in Discord.`);
      return reply.redirect(`${ctx.base}/setup/discord`);
    }
    // Linked workspaces' own panels in this server come down too (not those in servers of their own).
    for (const l of await listLinked(deps.db, ws.id)) if (usesMainServer(l)) await unpublishPanel(deps, l.id);
    await unpublishPanel(deps, ws.id);
    await deleteDiscordConnection(deps.db, ctx.workspace.id);
    setFlash(reply, 'success', 'Discord disconnected and the panel removed. You can also remove the bot from the server in Discord.');
    return reply.redirect(`${ctx.base}/setup/discord`);
  });

  // ---- Discord link: whoever runs a server adds the bot for a workspace, without an account ----

  app.post('/w/:wid/setup/discord/share', async (req, reply) => {
    const ctx = await web.requireWorkspace(req, reply);
    if (!ctx) return reply;
    await createDiscordLink(deps, ctx.workspace.id);
    setFlash(reply, 'success', 'Link created. Copy it and send it to an admin of the Discord server.');
    return reply.redirect(`${ctx.base}/setup/discord#own-server`);
  });

  app.post('/w/:wid/setup/discord/share/revoke', async (req, reply) => {
    const ctx = await web.requireWorkspace(req, reply);
    if (!ctx) return reply;
    await clearDiscordLink(deps.db, ctx.workspace.id);
    setFlash(reply, 'success', 'The link stopped working.');
    return reply.redirect(`${ctx.base}/setup/discord#own-server`);
  });

  const linkGone = () => simplePage('Connect Discord', html`<h1>This link doesn’t work anymore</h1>
    <p class="muted">It expired, was already used, or was replaced by a newer one. Ask the workspace’s admins for a new link.</p>`);

  app.get('/discord/connect/:token', async (req, reply) => {
    const { token } = req.params as { token: string };
    const ws = await findDiscordLink(deps.db, token);
    if (!ws || !deps.discord) return reply.type('text/html').send(linkGone());
    const conn = ws.own_discord ? await getDiscordConnection(deps.db, ws.id) : null;
    if (conn) {
      return reply.type('text/html').send(simplePage('Connect Discord', html`<h1>Already connected</h1>
        <p class="muted">${ws.name} is connected to ${conn.guild_name}. There’s nothing more to do.</p>`));
    }
    return reply.type('text/html').send(simplePage('Connect Discord', html`<div class="stack gap-8">
      <h1>Add the ticket bot for ${ws.name}</h1>
      <p class="muted">${ws.name} turns bug reports from Discord into GitHub issues. Adding the bot to your server gives ${ws.name}’s team a ticket panel there that lists only ${ws.name}’s apps.</p>
      <ol class="steps">
        <li><span>Discord opens. Pick your server (you need Manage Server there) and confirm the bot’s permissions.</span></li>
        <li><span>That’s all. ${ws.name}’s team picks the channels and sets up the panel.</span></li>
      </ol>
      <div class="tags">${REQUIRED_CHANNEL_PERMISSIONS.map((p) => tag(p.name))}${tag('Manage Roles')}</div>
      <p class="small muted">Manage Roles is only used if they turn on contributor roles. You can remove the bot from your server at any time.</p></div>
      ${linkBtn(`/discord/connect/${token}/add`, 'Add to Discord', { variant: 'primary', block: true, icon: 'bot' })}`));
  });

  /** Off to Discord to add the bot, remembering the link. */
  app.get('/discord/connect/:token/add', async (req, reply) => {
    const { token } = req.params as { token: string };
    const ws = await findDiscordLink(deps.db, token);
    if (!ws || !deps.discord) return reply.type('text/html').send(linkGone());
    const state = await createState(deps.db, 'discord_bot', null, ws.id, { link: sha256(token) }, 30);
    return reply.redirect(deps.discord.botInstallUrl(state, discordRedirect, BOT_INSTALL_PERMISSIONS));
  });
}
