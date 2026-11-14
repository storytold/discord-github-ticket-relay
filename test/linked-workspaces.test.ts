import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { connectDiscordServer } from '../src/domain/discord-link.js';
import { createLinkedWorkspace, listLinked } from '../src/domain/linked.js';
import { checkPanel, publishPanel } from '../src/domain/panel.js';
import { createApp, getDiscordConnection, getGitHubConnection, getPanel, saveGitHubConnection } from '../src/domain/store.js';
import type { AppRow, WorkspaceRow } from '../src/domain/types.js';
import { acceptInvite, createInvite, getMembership, getWorkspace, listMemberships, setMemberActions, setMyTickets } from '../src/domain/workspaces.js';
import { form, get, grant, makeAdmin, makeApp, makeWorkspace, member, modalSubmit, nextInteractionId, resetDb, sendInteraction, TEST_FILES_DIR, testDb, type Admin, type ConfiguredWorkspace, type TestEnv } from './helpers.js';

let env: TestEnv;
let main: ConfiguredWorkspace;
let linked: WorkspaceRow;
let mailcraft: AppRow;
const ALEX = '555000000000000031';
const MAILCRAFT_INSTALL = 7990;
const MAILCRAFT_REPO = 9990;

const click = (customId: string, o: { values?: string[]; guild?: string } = {}) =>
  sendInteraction(env, { id: nextInteractionId(), type: 3, token: `tok-${customId}`, guild_id: o.guild ?? main.guildId, member: member(ALEX, 'Alex'), data: { custom_id: customId, ...(o.values ? { values: o.values } : {}) } });
const fresh = async () => {
  main.workspace = (await getWorkspace(env.db, main.workspace.id))!;
  linked = (await getWorkspace(env.db, linked.id))!;
};
/** Someone in the main workspace with this role (a moderator can be global). */
async function join(role: 'admin' | 'moderator', o: { global?: boolean; workspace?: string } = {}): Promise<Admin> {
  const person = await makeAdmin(env);
  const token = await createInvite(env.db, o.workspace ?? main.workspace.id, main.owner.user.id, role, { global: o.global });
  await acceptInvite(env.db, token, person.user.id);
  return person;
}
beforeEach(async () => {
  await resetDb();
  env = await makeApp();
  main = await makeWorkspace(env, { repos: [{ id: 9801, name: 'photocraft', private: false }], apps: [{ name: 'PhotoCraft', repoIndex: 0 }] });
  linked = await createLinkedWorkspace(env.db, main.workspace, 'Mailcraft');
  env.github.addInstallation(MAILCRAFT_INSTALL, 'mailcraft-org', [{ id: MAILCRAFT_REPO, name: 'mailcraft', private: false }]);
  await saveGitHubConnection(env.db, linked.id, { installationId: MAILCRAFT_INSTALL, accountLogin: 'mailcraft-org', accountType: 'Organization', accountAvatarUrl: null, repositorySelection: 'selected', suspended: false }, null);
  mailcraft = await createApp(env.db, linked.id, { name: 'Mailcraft', description: 'Email designer', repo: { id: MAILCRAFT_REPO, owner: 'mailcraft-org', name: 'mailcraft', private: false }, labels: [], enabled: true });
});
afterAll(async () => {
  await testDb().end();
});

describe('Linked workspaces: who is in them', () => {
  it('has the main’s owner and global admins as admins and its global moderators as moderators, with their pages', async () => {
    const admin = await join('admin', { global: true });
    const mainAdmin = await join('admin');
    const globalMod = await join('moderator', { global: true });
    const mod = await join('moderator');
    await grant(env, main.workspace.id, globalMod.user.id, { moderation: 'edit' });

    expect(await getMembership(env.db, main.owner.user.id, linked.id)).toMatchObject({ role: 'owner', via: main.workspace.name });
    expect(await getMembership(env.db, admin.user.id, linked.id)).toMatchObject({ role: 'admin', via: main.workspace.name });
    expect(await getMembership(env.db, globalMod.user.id, linked.id)).toMatchObject({ role: 'moderator', global: true, access: { moderation: 'edit' } });
    expect(await getMembership(env.db, mod.user.id, linked.id)).toBeNull();
    expect(await getMembership(env.db, mainAdmin.user.id, linked.id)).toBeNull();

    // A linked workspace sits right after its main.
    expect((await listMemberships(env.db, admin.user.id)).map((m) => m.workspace.name)).toEqual([main.workspace.name, 'Mailcraft']);
    expect((await env.server.inject({ method: 'GET', url: `/w/${linked.id}/moderation`, ...get(globalMod) })).statusCode).toBe(200);
    expect((await env.server.inject({ method: 'GET', url: `/w/${linked.id}`, ...get(mod) })).statusCode).toBe(404);
  });

  it('invites admins and moderators of its own, who don’t see the main or the server’s pages', async () => {
    const res = await env.server.inject({ method: 'POST', url: `/w/${linked.id}/members/invites`, ...form(main.owner, { role: 'admin', global: '1' }) });
    const token = /\/invite\/([A-Za-z0-9_-]+)/.exec(res.body)![1]!;
    expect(res.body).toContain('Admin invite link');
    const sam = await makeAdmin(env);
    await acceptInvite(env.db, token, sam.user.id);
    expect(await getMembership(env.db, sam.user.id, linked.id)).toMatchObject({ role: 'admin', global: false, local: true });
    expect(await getMembership(env.db, sam.user.id, main.workspace.id)).toBeNull();

    // Sam runs Mailcraft, but the whole server's pages stay with the main's team.
    const at = (path: string) => env.server.inject({ method: 'GET', url: `/w/${linked.id}${path}`, ...get(sam) });
    expect((await at('/setup/github')).statusCode).toBe(200);
    const overview = await at('');
    expect(overview.body).not.toContain(`href="/w/${linked.id}/deployment"`);
    expect(overview.body).not.toContain('Server health');
    for (const path of ['/deployment', '/health']) {
      const page = await at(path);
      expect(page.statusCode).toBe(403);
      expect(page.body).toContain('cover the whole server');
    }

    // Sam invites moderators of Mailcraft (never admins), and removes them; roles stay with the owner.
    const invite = await env.server.inject({ method: 'POST', url: `/w/${linked.id}/members/invites`, ...form(sam, { role: 'admin' }) });
    expect(invite.body).toContain('Moderator invite link');
    const lee = await makeAdmin(env);
    await acceptInvite(env.db, /\/invite\/([A-Za-z0-9_-]+)/.exec(invite.body)![1]!, lee.user.id);
    expect(await getMembership(env.db, lee.user.id, linked.id)).toMatchObject({ role: 'moderator', local: true });
    expect((await env.server.inject({ method: 'POST', url: `/w/${linked.id}/members/${lee.user.id}/role`, ...form(sam, { role: 'admin' }) })).statusCode).toBe(403);
    // Lee can't be given Server health from here either.
    await grant(env, linked.id, lee.user.id, { health: 'view' });
    expect((await env.server.inject({ method: 'GET', url: `/w/${linked.id}/health`, ...get(lee) })).statusCode).toBe(403);
    await env.server.inject({ method: 'POST', url: `/w/${linked.id}/members/${lee.user.id}/remove`, ...form(sam) });
    expect(await getMembership(env.db, lee.user.id, linked.id)).toBeNull();
    // Not someone the owner made admin.
    const kit = await join('admin', { workspace: linked.id });
    await env.server.inject({ method: 'POST', url: `/w/${linked.id}/members/${kit.user.id}/remove`, ...form(sam) });
    expect(await getMembership(env.db, kit.user.id, linked.id)).toMatchObject({ role: 'admin' });

    const page = await env.server.inject({ method: 'GET', url: `/w/${linked.id}/members`, ...get(main.owner) });
    expect(page.body).toContain(`From ${main.workspace.name}`);
    expect(page.body).toContain('Added in Mailcraft');
  });

  it('makes a global moderator an admin of a linked workspace alone, and back', async () => {
    const benz = await join('moderator', { global: true });
    await grant(env, main.workspace.id, benz.user.id, { moderation: 'edit' });
    const members = await env.server.inject({ method: 'GET', url: `/w/${linked.id}/members`, ...get(main.owner) });
    expect(members.body).toContain(`id="role-${benz.user.id}"`);
    expect(members.body).toContain('Admin of Mailcraft');

    await env.server.inject({ method: 'POST', url: `/w/${linked.id}/members/${benz.user.id}/role`, ...form(main.owner, { role: 'admin' }) });
    expect(await getMembership(env.db, benz.user.id, linked.id)).toMatchObject({ role: 'admin', local: true });
    expect(await getMembership(env.db, benz.user.id, main.workspace.id)).toMatchObject({ role: 'moderator', global: true });
    expect((await env.server.inject({ method: 'GET', url: `/w/${linked.id}/setup/github`, ...get(benz) })).statusCode).toBe(200);
    expect((await listMemberships(env.db, benz.user.id)).map((m) => [m.workspace.name, m.role])).toEqual([[main.workspace.name, 'moderator'], ['Mailcraft', 'admin']]);
    const after = await env.server.inject({ method: 'GET', url: `/w/${linked.id}/members`, ...get(main.owner) });
    expect(after.body).toContain(`global moderator in ${main.workspace.name}`);

    // Back to moderator: through the main again, with the main's pages.
    await env.server.inject({ method: 'POST', url: `/w/${linked.id}/members/${benz.user.id}/role`, ...form(main.owner, { role: 'moderator' }) });
    expect(await getMembership(env.db, benz.user.id, linked.id)).toMatchObject({ role: 'moderator', via: main.workspace.name, access: { moderation: 'edit' } });
    expect((await env.db.query('SELECT count(*) AS n FROM workspace_members WHERE workspace_id = $1 AND user_id = $2', [linked.id, benz.user.id])).rows[0].n).toBe(0);
  });

  it('makes global admins and moderators from the invite switch or a role change, and taking it away takes the linked workspaces away', async () => {
    const page = await env.server.inject({ method: 'GET', url: `/w/${main.workspace.id}/members?invite=1`, ...get(main.owner) });
    expect(page.body).toContain('Also an admin or moderator in Mailcraft, the same as here.');
    expect(page.body).not.toMatch(/name="global"[^>]*checked/);
    const admin = await env.server.inject({ method: 'POST', url: `/w/${main.workspace.id}/members/invites`, ...form(main.owner, { role: 'admin', global: '1' }) });
    expect(admin.body).toContain('Global admin invite link');
    const res = await env.server.inject({ method: 'POST', url: `/w/${main.workspace.id}/members/invites`, ...form(main.owner, { role: 'moderator', global: '1' }) });
    expect(res.body).toContain('Global moderator invite link');
    const token = /\/invite\/([A-Za-z0-9_-]+)/.exec(res.body)![1]!;
    const kim = await makeAdmin(env);
    await acceptInvite(env.db, token, kim.user.id);
    expect(await getMembership(env.db, kim.user.id, linked.id)).toMatchObject({ role: 'moderator' });

    // Moderator only in the main: out of Mailcraft, and their claims there end.
    await env.db.query(`INSERT INTO ticket_claims (id, workspace_id, user_id, repo_id, number) VALUES ('c1', $1, $2, $3, 1)`, [linked.id, kim.user.id, MAILCRAFT_REPO]);
    await env.server.inject({ method: 'POST', url: `/w/${main.workspace.id}/members/${kim.user.id}/role`, ...form(main.owner, { role: 'moderator' }) });
    expect(await getMembership(env.db, kim.user.id, linked.id)).toBeNull();
    expect((await env.db.query(`SELECT end_reason FROM ticket_claims WHERE id = 'c1'`)).rows[0]).toEqual({ end_reason: 'left' });
    await env.server.inject({ method: 'POST', url: `/w/${main.workspace.id}/members/${kim.user.id}/role`, ...form(main.owner, { role: 'moderator', global: '1' }) });
    expect(await getMembership(env.db, kim.user.id, linked.id)).toMatchObject({ role: 'moderator', global: true });
    await env.server.inject({ method: 'POST', url: `/w/${main.workspace.id}/members/${kim.user.id}/role`, ...form(main.owner, { role: 'admin', global: '1' }) });
    expect(await getMembership(env.db, kim.user.id, linked.id)).toMatchObject({ role: 'admin', via: main.workspace.name });
    const members = await env.server.inject({ method: 'GET', url: `/w/${main.workspace.id}/members`, ...get(main.owner) });
    expect(members.body).toContain('Global admin');
    // An admin of the main only: not in Mailcraft.
    await env.server.inject({ method: 'POST', url: `/w/${main.workspace.id}/members/${kim.user.id}/role`, ...form(main.owner, { role: 'admin' }) });
    expect(await getMembership(env.db, kim.user.id, linked.id)).toBeNull();
  });

  it('is made from the main’s Settings, and not from a linked workspace', async () => {
    const res = await env.server.inject({ method: 'POST', url: `/w/${main.workspace.id}/settings/linked`, ...form(main.owner, { name: 'Notecraft' }) });
    const made = (await listLinked(env.db, main.workspace.id)).find((l) => l.name === 'Notecraft')!;
    expect(res.headers.location).toBe(`/w/${made.id}`);
    expect(made).toMatchObject({ parent_id: main.workspace.id, on_main_panel: true });
    await expect(createLinkedWorkspace(env.db, made, 'Deeper')).rejects.toThrow('can’t have linked workspaces of its own');
    // The workspace switcher offers it too, to the main's owner and admins, from a linked workspace as well.
    for (const w of [main.workspace.id, made.id]) {
      const page = await env.server.inject({ method: 'GET', url: `/w/${w}`, ...get(main.owner) });
      expect(page.body).toContain('New linked workspace…');
      expect(page.body).toContain(`action="/w/${main.workspace.id}/settings/linked"`);
    }
    const globalMod = await join('moderator', { global: true });
    expect((await env.server.inject({ method: 'GET', url: `/w/${made.id}`, ...get(globalMod) })).body).not.toContain('New linked workspace…');
    // An admin of the linked workspace alone can't add workspaces to the main.
    const own = await join('admin', { workspace: made.id });
    expect((await env.server.inject({ method: 'GET', url: `/w/${made.id}`, ...get(own) })).body).not.toContain('New linked workspace…');
    const settings = await env.server.inject({ method: 'GET', url: `/w/${main.workspace.id}/settings`, ...get(main.owner) });
    expect(settings.body).toContain('Linked workspaces');
    expect(settings.body).toContain('GitHub: mailcraft-org');
  });

  it('uses the main’s Discord server and leaves the server-wide tools to the main', async () => {
    expect(await getDiscordConnection(env.db, linked.id)).toMatchObject({ guild_id: main.guildId, workspace_id: linked.id, tickets_channel_id: null });
    const discord = await env.server.inject({ method: 'GET', url: `/w/${linked.id}/setup/discord`, ...get(main.owner) });
    expect(discord.body).toContain(`Mailcraft uses ${main.workspace.name}’s Discord server`);
    expect(discord.body).not.toContain('Disconnect Discord');
    const tools = await env.server.inject({ method: 'GET', url: `/w/${linked.id}/contributors/roles`, ...get(main.owner) });
    expect(tools.body).toContain('Set up in the main workspace');
    const overview = await env.server.inject({ method: 'GET', url: `/w/${linked.id}`, ...get(main.owner) });
    expect(overview.body).not.toContain(`href="/w/${linked.id}/announcements"`);
    expect(overview.body).toContain(`Linked to ${main.workspace.name}`);
  });
});

describe('Linked workspaces: tickets in Discord', () => {
  it('lists its apps on the main’s panel and files them in its own workspace and repository', async () => {
    await publishPanel(env.deps, main.workspace.id, null);
    const posted = [...env.discord.messages.values()].at(-1)!.payload as any;
    // A button for the main's apps and one for the linked workspaces'.
    expect(posted.components).toHaveLength(1);
    expect(posted.components[0].components.map((b: any) => [b.label, b.custom_id])).toEqual([[main.workspace.name, 'tr:grp:main'], ['Mailcraft', 'tr:grp:linked']]);
    expect(posted.embeds[0].description).toContain(`1. Press **${main.workspace.name.replace(/([\\*_~`|>#\[\]()-])/g, '\\$1')}** or **Mailcraft**, then choose your app.`);

    // Its button opens its list, even with one app; picking it opens the form.
    const list = (await click('tr:grp:linked')).json().data;
    expect(list.flags & 64).toBe(64);
    expect(list.components[0].components[0].options.map((o: { label: string }) => o.label)).toEqual(['Mailcraft']);
    const modal = (await click('tr:pickp', { values: [mailcraft.public_id] })).json();
    expect(modal.type).toBe(9);
    expect(modal.data.custom_id).toBe(`tr:form:${mailcraft.public_id}:${MAILCRAFT_REPO}`);

    const res = await sendInteraction(env, { ...modalSubmit(main, mailcraft, { title: 'Templates vanish', description: 'They disappear after saving.' }), member: member(ALEX, 'Alex') });
    expect(res.json().type).toBe(5);
    await env.worker.drain();
    const sub = (await env.db.query('SELECT workspace_id, installation_id, repo_id, issue_number FROM submissions ORDER BY created_at DESC LIMIT 1')).rows[0];
    expect(sub).toMatchObject({ workspace_id: linked.id, installation_id: MAILCRAFT_INSTALL, repo_id: MAILCRAFT_REPO });
    expect(env.github.repos.get(MAILCRAFT_REPO)!.issues.map((i) => i.title)).toEqual([expect.stringContaining('Templates vanish')]);
    // A server it isn't on can't reach it.
    const other = await makeWorkspace(env);
    expect((await click('tr:pick', { values: [mailcraft.public_id], guild: other.guildId })).json().data.embeds[0].title).toBe('App unavailable');
  });

  it('shows a member’s tickets from both in My tickets on the main’s panel, each with its own workspace’s buttons', async () => {
    await setMyTickets(env.db, main.workspace.id, true);
    await setMemberActions(env.db, linked.id, { details: true, files: false, close: false, text: {} });
    await sendInteraction(env, { ...modalSubmit(main, main.apps[0]!, { title: 'Export crashes', description: 'Every time I export.' }), member: member(ALEX, 'Alex') });
    await sendInteraction(env, { ...modalSubmit(main, mailcraft, { title: 'Templates vanish', description: 'They disappear after saving.' }), member: member(ALEX, 'Alex') });
    await env.worker.drain();
    const list = (await click('tr:mine')).json().data;
    const options = list.components.find((r: any) => r.components[0].type === 3).components[0].options;
    expect(options.map((o: { label: string }) => o.label).sort()).toEqual(['Export crashes', 'Templates vanish']);
    const refs = (await env.db.query('SELECT ref, workspace_id FROM submissions')).rows as { ref: string; workspace_id: string }[];
    const mine = refs.find((r) => r.workspace_id === linked.id)!.ref;
    const theirs = refs.find((r) => r.workspace_id === main.workspace.id)!.ref;
    const labels = async (ref: string) => (await click('tr:mine:t:0', { values: [ref] })).json().data.components.flatMap((r: any) => r.components.map((c: any) => c.label));
    expect(await labels(mine)).toContain('Add details');
    expect(await labels(theirs)).not.toContain('Add details');
  });

  it('can have a panel of its own, whose clicks stay with it', async () => {
    await env.db.query('UPDATE workspaces SET on_main_panel = 0, panel_channel_id = $2, panel_channel_name = $3 WHERE id = $1', [linked.id, main.channelId, 'tickets']);
    await setMyTickets(env.db, linked.id, true);
    await fresh();
    await publishPanel(env.deps, linked.id, null);
    const own = (await getPanel(env.db, linked.id))!;
    const payload = env.discord.messages.get(own.message_id)!.payload as any;
    expect(payload.components[0].components.map((c: { custom_id: string }) => c.custom_id)).toEqual([`tr:open~${linked.id}`, `tr:mine~${linked.id}`]);

    // Open a ticket on it: Mailcraft's form (its only app), still tagged.
    const opened = (await click(`tr:open~${linked.id}`)).json();
    expect(opened.data.custom_id).toBe(`tr:form:${mailcraft.public_id}:${MAILCRAFT_REPO}~${linked.id}`);
    // The main's panel no longer lists Mailcraft: its one app goes straight to PhotoCraft's form.
    expect((await click('tr:open')).json().data.custom_id).toBe(`tr:form:${main.apps[0]!.public_id}:${main.apps[0]!.repo_id}`);
    // My tickets on it is Mailcraft's alone, and its buttons keep the tag.
    const mine = (await click(`tr:mine~${linked.id}`)).json().data;
    expect(JSON.stringify(mine)).not.toMatch(/"custom_id":"tr:[^"~]*"/);
    // A tag for a workspace that isn't linked to this server's: out of date.
    const other = await makeWorkspace(env);
    expect((await click(`tr:open~${other.workspace.id}`)).json().data.embeds[0].title).toBe('Out of date');
  });

  it('chooses its panel on its Panel page, and the main’s Panel page lists it', async () => {
    const page = await env.server.inject({ method: 'GET', url: `/w/${linked.id}/tickets/panel`, ...get(main.owner) });
    expect(page.body).toContain('Where members open tickets');
    expect(page.body).toContain(`On ${main.workspace.name}’s panel`);
    expect(page.body).not.toContain('value="publish"');
    const mainPage = await env.server.inject({ method: 'GET', url: `/w/${main.workspace.id}/tickets/panel`, ...get(main.owner) });
    expect(mainPage.body).toContain('<h3>Buttons</h3>');
    expect(mainPage.body).toContain('1 app: Mailcraft');

    const res = await env.server.inject({ method: 'POST', url: `/w/${linked.id}/tickets/panel`, ...form(main.owner, { panel_home_sent: '1', panel_home: 'own' }) });
    expect(res.headers.location).toBe(`/w/${linked.id}/tickets/panel`);
    await fresh();
    expect(linked.on_main_panel).toBe(false);
    // Its own panel goes up, then comes down again when it moves back to the main's.
    await env.server.inject({ method: 'POST', url: `/w/${linked.id}/tickets/panel`, ...form(main.owner, { channel_id: main.channelId, intent: 'publish' }) });
    expect(await getPanel(env.db, linked.id)).not.toBeNull();
    await env.server.inject({ method: 'POST', url: `/w/${linked.id}/tickets/panel`, ...form(main.owner, { panel_home_sent: '1', panel_home: 'main' }) });
    expect(await getPanel(env.db, linked.id)).toBeNull();
  });
});

describe('Linked workspaces: a button for the main’s apps and one for theirs', () => {
  const labels = (payload: any) => payload.components[0].components.map((b: any) => b.label);
  const save = (fields: Record<string, string>) => env.server.inject({ method: 'POST', url: `/w/${main.workspace.id}/tickets/panel`, ...form(main.owner, fields) });

  it('names the buttons on the main’s Panel page, with the workspaces’ names by default', async () => {
    const page = (await env.server.inject({ method: 'GET', url: `/w/${main.workspace.id}/tickets/panel`, ...get(main.owner) })).body;
    expect(page).toContain('<h3>Buttons</h3>');
    expect(page).toContain('id="group_linked"');
    await publishPanel(env.deps, main.workspace.id, null);
    await save({ group_main: 'ArtCraft apps', group_linked: '  Community   Apps ' });
    await fresh();
    expect([main.workspace.panel_section_title, main.workspace.panel_linked_title]).toEqual(['ArtCraft apps', 'Community Apps']);
    // The published panel shows the old names until it's published again.
    expect(await checkPanel(env.deps, main.workspace.id, { live: false })).toMatchObject({ state: 'published', outdated: true });
    await publishPanel(env.deps, main.workspace.id, null);
    expect(labels([...env.discord.messages.values()].at(-1)!.payload)).toEqual(['ArtCraft apps', 'Community Apps']);
    // The defaults again mean "the default".
    await save({ group_main: main.workspace.name, group_linked: 'Mailcraft' });
    await fresh();
    expect([main.workspace.panel_section_title, main.workspace.panel_linked_title]).toEqual([null, null]);
    // Two or more linked workspaces share the button, "Other apps" by default.
    const second = await createLinkedWorkspace(env.db, main.workspace, 'Paintcraft');
    await createApp(env.db, second.id, { name: 'Paintcraft', description: null, repo: { id: MAILCRAFT_REPO, owner: 'mailcraft-org', name: 'mailcraft', private: false }, labels: [], enabled: true });
    await publishPanel(env.deps, main.workspace.id, null);
    expect(labels([...env.discord.messages.values()].at(-1)!.payload)).toEqual([main.workspace.name, 'Other apps']);
    // A linked workspace's page doesn't name them.
    const linkedPage = (await env.server.inject({ method: 'GET', url: `/w/${linked.id}/tickets/panel`, ...get(main.owner) })).body;
    expect(linkedPage).not.toContain('id="group_linked"');
  });

  it('opens a group’s list privately, page by page, from the panel or from Open a ticket', async () => {
    await env.db.query('UPDATE workspaces SET panel_linked_title = $2 WHERE id = $1', [main.workspace.id, 'Community Apps']);
    for (let n = 0; n < 26; n++) {
      await createApp(env.db, linked.id, { name: `Tool ${String(n).padStart(2, '0')}`, description: null, repo: { id: MAILCRAFT_REPO, owner: 'mailcraft-org', name: 'mailcraft', private: false }, labels: [], enabled: true });
    }
    // From the panel: a new private message with the group's list.
    const list = (await click('tr:grp:linked')).json();
    expect(list.type).toBe(4);
    expect(list.data.flags & 64).toBe(64);
    expect(list.data.content).toBe('Choose the app you need help with in Community Apps (page 1 of 2).');
    expect(list.data.components[0].components[0].options).toHaveLength(25);
    expect(list.data.components[1].components.map((b: any) => b.custom_id)).toEqual(['tr:page:-1:linked', 'tr:page:1:linked']);
    const next = (await click('tr:page:1:linked')).json().data;
    expect(next.components[0].components[0].options.map((o: any) => o.label)).toEqual(['Tool 24', 'Tool 25']);
    expect((await click('tr:pickp', { values: [mailcraft.public_id] })).json().type).toBe(9);

    // With My tickets on: Open a ticket shows the two buttons privately, then the list in their place.
    await setMyTickets(env.db, main.workspace.id, true);
    const chooser = (await click('tr:open')).json().data;
    expect(chooser.content).toBe(`Press **${main.workspace.name.replace(/([\\*_~`|>#\[\]()-])/g, '\\$1')}** or **Community Apps**, then choose your app.`);
    expect(chooser.components[0].components.map((b: any) => b.custom_id)).toEqual(['tr:grpp:main', 'tr:grpp:linked']);
    // The main's list has its one app, in place of the buttons.
    const mainList = (await click('tr:grpp:main')).json();
    expect(mainList.type).toBe(7);
    expect(mainList.data.components[0].components[0].options.map((o: { label: string }) => o.label)).toEqual(['PhotoCraft']);
    const inPlace = (await click('tr:grpp:linked')).json();
    expect(inPlace.type).toBe(7);
    expect(inPlace.data.flags).toBeUndefined();
  });

  it('shows a button’s description, when it has one, with its name', async () => {
    const name = main.workspace.name.replace(/([\\*_~`|>#\[\]()-])/g, '\\$1');
    await publishPanel(env.deps, main.workspace.id, null);
    await save({ group_linked: 'Community Apps', group_main_note: '', group_linked_note: '  Made by   the **community** ' });
    await fresh();
    expect([main.workspace.panel_main_note, main.workspace.panel_linked_note]).toEqual([null, 'Made by the **community**']);
    expect(await checkPanel(env.deps, main.workspace.id, { live: false })).toMatchObject({ state: 'published', outdated: true });
    await publishPanel(env.deps, main.workspace.id, null);
    const text = ([...env.discord.messages.values()].at(-1)!.payload as any).embeds[0].description as string;
    expect(text).toContain('\n\n**Community Apps**: Made by the **community**\n\n**How it works**\n1. Press');
    expect(text).not.toContain(`**${name}**:`);
    // The Panel page shows it in the preview, where it follows the field.
    const page = (await env.server.inject({ method: 'GET', url: `/w/${main.workspace.id}/tickets/panel`, ...get(main.owner) })).body;
    expect(page).toContain('id="group_linked_note"');
    expect(page).toContain('id="pv-note-linked">Made by the <strong>community</strong></span>');
    expect(page).toContain('data-pv-line="group_main_note" hidden');

    // With My tickets on: in the private Open a ticket message, right away.
    await setMyTickets(env.db, main.workspace.id, true);
    await publishPanel(env.deps, main.workspace.id, null);
    const saved = await save({ group_main_note: 'Made by our team' });
    expect(await checkPanel(env.deps, main.workspace.id, { live: false })).toMatchObject({ outdated: false });
    expect(Buffer.from(saved.cookies.find((c) => c.name === 'tr_flash')!.value, 'base64url').toString()).toContain('when they press Open a ticket');
    const chooser = (await click('tr:open')).json().data;
    expect(chooser.content).toBe(`Press **${name}** or **Community Apps**, then choose your app.\n\n**${name}**: Made by our team\n**Community Apps**: Made by the **community**`);
    // Cleared, they're gone.
    await save({ group_main_note: ' ', group_linked_note: '' });
    await fresh();
    expect([main.workspace.panel_main_note, main.workspace.panel_linked_note]).toEqual([null, null]);
    expect((await click('tr:open')).json().data.content).toBe(`Press **${name}** or **Community Apps**, then choose your app.`);
  });

  it('keeps one menu when only one workspace has apps on the panel, and old panels’ menus still work', async () => {
    await env.db.query('UPDATE apps SET enabled = 0 WHERE workspace_id = $1', [linked.id]);
    await publishPanel(env.deps, main.workspace.id, null);
    const posted = [...env.discord.messages.values()].at(-1)!.payload as any;
    expect(posted.components).toHaveLength(1);
    expect(posted.components[0].components[0]).toMatchObject({ custom_id: 'tr:pick', placeholder: 'Choose an app…' });
    expect((await click('tr:grp:linked')).json().data.embeds[0].title).toBe('Out of date');
    // A menu from the panel posted with a menu per workspace.
    expect((await click('tr:pick:0', { values: [main.apps[0]!.public_id] })).json().type).toBe(9);
    expect((await click('tr:pick:1', { values: [`__more:${linked.id}`] })).json().data.content).toBe('Choose the app you need help with.');
  });
});

describe('Install links', () => {
  async function makeLink(ws: WorkspaceRow) {
    await env.db.query('DELETE FROM github_connections WHERE workspace_id = $1', [ws.id]);
    await env.server.inject({ method: 'POST', url: `/w/${ws.id}/setup/github/share`, ...form(main.owner) });
    const page = await env.server.inject({ method: 'GET', url: `/w/${ws.id}/setup/github`, ...get(main.owner) });
    return /\/github\/connect\/([A-Za-z0-9_-]+)/.exec(page.body)![1]!;
  }
  const stateOf = (location: string) => new URL(location).searchParams.get('state')!;

  it('lets the organization’s owner install the app without an account, once', async () => {
    const token = await makeLink(linked);
    const landing = await env.server.inject({ method: 'GET', url: `/github/connect/${token}` });
    expect(landing.body).toContain('Connect GitHub for Mailcraft');
    const go = await env.server.inject({ method: 'GET', url: `/github/connect/${token}/install` });
    expect(go.headers.location).toContain('/installations/new?state=');

    env.github.addInstallation(8123, 'their-org', [{ id: 8124, name: 'mailer' }]);
    env.github.addInstallation(8200, 'someone-else', [{ id: 8201, name: 'other' }]);
    env.github.userInstallationIds = [8123];
    // An installation they can't access isn't connected.
    const spoof = await env.server.inject({ method: 'GET', url: `/oauth/github/callback?code=good-code&installation_id=8200&setup_action=install&state=${stateOf(go.headers.location as string)}` });
    expect(spoof.body).toContain('Nothing was connected');
    expect(await getGitHubConnection(env.db, linked.id)).toBeNull();

    const again = await env.server.inject({ method: 'GET', url: `/github/connect/${token}/install` });
    const done = await env.server.inject({ method: 'GET', url: `/oauth/github/callback?code=good-code&installation_id=8123&setup_action=install&state=${stateOf(again.headers.location as string)}` });
    expect(done.body).toContain('Connected');
    expect(await getGitHubConnection(env.db, linked.id)).toMatchObject({ installation_id: 8123, account_login: 'their-org', connected_by: null });
    expect((await env.server.inject({ method: 'GET', url: `/github/connect/${token}` })).body).toContain('doesn’t work anymore');
  });

  it('asks which account when they sign in with several, and stops when the admins stop it', async () => {
    const token = await makeLink(linked);
    env.github.addInstallation(8301, 'org-a', [{ id: 8302, name: 'a' }]);
    env.github.addInstallation(8311, 'org-b', [{ id: 8312, name: 'b' }]);
    env.github.userInstallationIds = [8301, 8311];
    const go = await env.server.inject({ method: 'GET', url: `/github/connect/${token}/signin` });
    expect(go.headers.location).toContain('/login/oauth/authorize');
    const pick = await env.server.inject({ method: 'GET', url: `/oauth/github/callback?code=good-code&state=${stateOf(go.headers.location as string)}` });
    const href = /href="(\/github\/connect\/choose\?[^"]+installation_id=8311)"/.exec(pick.body)![1]!.replace(/&amp;/g, '&');
    expect((await env.server.inject({ method: 'GET', url: href })).body).toContain('Connected');
    expect(await getGitHubConnection(env.db, linked.id)).toMatchObject({ installation_id: 8311 });

    const second = await makeLink(linked);
    await env.server.inject({ method: 'POST', url: `/w/${linked.id}/setup/github/share/revoke`, ...form(main.owner) });
    expect((await env.server.inject({ method: 'GET', url: `/github/connect/${second}` })).body).toContain('doesn’t work anymore');
  });
});

describe('Deleting a workspace', () => {
  const settings = (ws: WorkspaceRow | ConfiguredWorkspace['workspace'], who: Admin = main.owner) => env.server.inject({ method: 'GET', url: `/w/${ws.id}/settings`, ...get(who) });
  const remove = (ws: { id: string }, name: string, who: Admin = main.owner) => env.server.inject({ method: 'POST', url: `/w/${ws.id}/settings/delete`, ...form(who, { confirm_name: name }) });
  const flash = (res: { cookies: { name: string; value: string }[] }) => (JSON.parse(Buffer.from(res.cookies.find((c) => c.name === 'tr_flash')!.value, 'base64url').toString()) as { message: string }).message;

  it('is for the owner, needs the name typed, and waits for a main’s linked workspaces', async () => {
    const admin = await join('admin');
    expect((await settings(main.workspace, admin)).body).not.toContain('Delete workspace');
    expect((await remove(main.workspace, main.workspace.name, admin)).statusCode).toBe(403);

    const page = (await settings(main.workspace)).body;
    expect(page).toContain('<h2>Delete workspace</h2>');
    expect(page).toContain('Delete its linked workspaces first: ');
    expect(page).not.toContain('name="confirm_name"');
    const blocked = await remove(main.workspace, main.workspace.name);
    expect(flash(blocked)).toBe('Delete its linked workspaces first: Mailcraft.');
    expect(await getWorkspace(env.db, main.workspace.id)).not.toBeNull();

    expect((await settings(linked)).body).toContain('data-must-match="Mailcraft"');
    const wrong = await remove(linked, 'mailcraft');
    expect(flash(wrong)).toBe('Type Mailcraft exactly to delete it.');
    expect(await getWorkspace(env.db, linked.id)).not.toBeNull();

    // A linked workspace on its main's panel: back to the main, whose posted menu needs publishing.
    const done = await remove(linked, '  Mailcraft ');
    expect(done.headers.location).toBe(`/w/${main.workspace.id}/settings#linked`);
    expect(flash(done)).toBe(`Mailcraft was deleted. Publish ${main.workspace.name}’s panel to take its apps off the menu.`);
    expect(await getWorkspace(env.db, linked.id)).toBeNull();
    expect((await env.db.query('SELECT count(*) AS n FROM apps WHERE workspace_id = $1', [linked.id])).rows[0]).toMatchObject({ n: 0 });
    expect((await settings(main.workspace)).body).toContain('name="confirm_name"');
  });

  it('takes down its panel and removes its files and tickets', async () => {
    await env.db.query('DELETE FROM workspaces WHERE id = $1', [linked.id]);
    await publishPanel(env.deps, main.workspace.id, null);
    const panel = (await getPanel(env.db, main.workspace.id))!;
    expect(env.discord.messages.has(panel.message_id)).toBe(true);
    await sendInteraction(env, { ...modalSubmit(main, main.apps[0]!, { title: 'Export crashes', description: 'Every time I export.' }), member: member(ALEX, 'Alex') });
    await env.worker.drain();
    const sub = (await env.db.query('SELECT id FROM submissions WHERE workspace_id = $1', [main.workspace.id])).rows[0] as { id: string };
    await env.db.query(`INSERT INTO ticket_files (id, workspace_id, submission_id, source, filename, size, status, kind, ext, content_type) VALUES ('DELETEMEDELETEMEDELETE', $1, $2, 'member', 'shot.png', 4, 'stored', 'image', 'png', 'image/png')`, [main.workspace.id, sub.id]);
    mkdirSync(TEST_FILES_DIR, { recursive: true });
    const file = path.join(TEST_FILES_DIR, 'DELETEMEDELETEMEDELETE.png');
    writeFileSync(file, 'png!');

    const res = await remove(main.workspace, main.workspace.name);
    expect(res.headers.location).toBe('/');
    expect(await getWorkspace(env.db, main.workspace.id)).toBeNull();
    expect(env.discord.messages.has(panel.message_id)).toBe(false);
    expect(existsSync(file)).toBe(false);
    for (const table of ['submissions', 'ticket_files', 'apps', 'workspace_members', 'panels']) {
      expect([table, (await env.db.query(`SELECT count(*) AS n FROM ${table} WHERE workspace_id = $1`, [main.workspace.id])).rows[0]]).toEqual([table, { n: 0 }]);
    }
    // The owner has no workspaces left.
    expect((await env.server.inject({ method: 'GET', url: '/', ...get(main.owner) })).headers.location).toBe('/workspaces');
  });
});

describe('A linked workspace with its own Discord server', () => {
  const SOLID_GUILD = '610000000000000001';
  const SOLID_CHANNEL = '610000000000000002';
  const page = (url: string, who: Admin = main.owner) => env.server.inject({ method: 'GET', url, ...get(who) });
  const post = (url: string, fields: Record<string, string> = {}, who: Admin = main.owner) => env.server.inject({ method: 'POST', url, ...form(who, fields) });
  const addSolid = () => env.discord.addGuild(SOLID_GUILD, 'Solid', [{ id: SOLID_CHANNEL, type: 0, name: 'help', position: 0 }]);
  const connectSolid = async () => {
    addSolid();
    await connectDiscordServer(env.deps, linked.id, { id: SOLID_GUILD, name: 'Solid', icon: null }, null);
    await fresh();
  };
  const lastPayload = () => [...env.discord.messages.values()].at(-1)!.payload as any;

  it('connects through a one-time link that only its owner and admins can make', async () => {
    const mod = await join('moderator', { workspace: linked.id });
    expect((await post(`/w/${linked.id}/setup/discord/share`, {}, mod)).statusCode).toBe(403);

    const setup = (await page(`/w/${linked.id}/setup/discord`)).body;
    expect(setup).toContain('Its own Discord server');
    await post(`/w/${linked.id}/setup/discord/share`);
    const token = /\/discord\/connect\/([A-Za-z0-9_-]+)/.exec((await page(`/w/${linked.id}/setup/discord`)).body)![1]!;
    expect((await env.server.inject({ method: 'GET', url: `/discord/connect/${token}` })).body).toContain('Add the ticket bot for Mailcraft');
    const go = await env.server.inject({ method: 'GET', url: `/discord/connect/${token}/add` });
    expect(go.headers.location).toContain('discord.com');
    const state = new URL(go.headers.location as string).searchParams.get('state')!;

    // Whoever runs the server comes back from Discord without an account here.
    addSolid();
    env.discord.codes.set('solid-code', { access_token: 'x', expires_in: 600, scope: 'bot identify', guild: { id: SOLID_GUILD, name: 'Solid', icon: null } });
    const done = await env.server.inject({ method: 'GET', url: `/oauth/discord/callback?code=solid-code&state=${state}` });
    expect(done.body).toContain('Added to Solid');
    await fresh();
    expect(linked.own_discord).toBe(true);
    expect((await getDiscordConnection(env.db, linked.id))!.guild_id).toBe(SOLID_GUILD);
    expect((await getDiscordConnection(env.db, main.workspace.id))!.guild_id).toBe(main.guildId);
    // The link worked once.
    expect((await env.server.inject({ method: 'GET', url: `/discord/connect/${token}` })).body).toContain('doesn’t work anymore');
    expect((await page(`/w/${linked.id}/setup/discord`)).body).toContain('Mailcraft has its own Discord server');
  });

  it('has a panel there with only its apps, and can stay on the main’s panel too', async () => {
    await connectSolid();
    const res = await post(`/w/${linked.id}/tickets/panel`, { channel_id: SOLID_CHANNEL, intent: 'publish' });
    expect(res.statusCode).toBe(302);
    const own = (await getPanel(env.db, linked.id))!;
    expect(own.channel_id).toBe(SOLID_CHANNEL);
    const select = lastPayload().components[0].components[0];
    expect(select.custom_id).toBe('tr:pick');
    expect(select.options.map((o: any) => o.label)).toEqual(['Mailcraft']);

    // From its server, the main's apps can't be reached.
    expect((await click('tr:pick', { values: [main.apps[0]!.public_id], guild: SOLID_GUILD })).json().data.embeds[0].title).toBe('App unavailable');
    expect((await click('tr:pick', { values: [mailcraft.public_id], guild: SOLID_GUILD })).json().type).toBe(9);

    // Still on the main's panel, behind the linked workspaces' button…
    await publishPanel(env.deps, main.workspace.id, null);
    expect(lastPayload().components[0].components.map((b: any) => b.label)).toEqual([main.workspace.name, 'Mailcraft']);
    // …until it leaves it; its own panel stays.
    const page2 = (await page(`/w/${linked.id}/tickets/panel`)).body;
    expect(page2).toContain(`Also on ${main.workspace.name}’s panel`);
    await post(`/w/${linked.id}/tickets/panel`, { also_main_sent: '1' });
    await fresh();
    expect(linked.on_main_panel).toBe(false);
    expect(await getPanel(env.db, linked.id)).not.toBeNull();
    await publishPanel(env.deps, main.workspace.id, null);
    expect(lastPayload().components[0].components[0].options.map((o: any) => o.label)).toEqual(['PhotoCraft']);
  });

  it('shows only its tickets in My tickets there', async () => {
    await connectSolid();
    await setMyTickets(env.db, linked.id, true);
    await sendInteraction(env, { ...modalSubmit(main, main.apps[0]!, { title: 'Export crashes', description: 'Every time I export.' }), member: member(ALEX, 'Alex') });
    await sendInteraction(env, { ...modalSubmit(main, mailcraft, { title: 'Templates vanish', description: 'They disappear after saving.' }), guild_id: SOLID_GUILD, member: member(ALEX, 'Alex') });
    await env.worker.drain();
    const list = (await click('tr:mine', { guild: SOLID_GUILD })).json().data;
    const options = list.components.find((r: any) => r.components[0].type === 3).components[0].options;
    expect(options.map((o: { label: string }) => o.label)).toEqual(['Templates vanish']);
    expect(JSON.stringify(list)).not.toContain('~');
  });

  it('runs its own contributor roles, announcements and bot features, and can go back to the main’s server', async () => {
    expect((await page(`/w/${linked.id}/contributors`)).body).toContain('Set up in the main workspace');
    await connectSolid();
    const tools = await page(`/w/${linked.id}/contributors`);
    expect(tools.statusCode).toBe(200);
    expect(tools.body).not.toContain('Set up in the main workspace');
    expect(tools.body).toContain(`href="/w/${linked.id}/announcements"`);

    // The main disconnecting its server leaves this one alone.
    await post(`/w/${linked.id}/tickets/panel`, { channel_id: SOLID_CHANNEL, intent: 'publish' });
    const own = (await getPanel(env.db, linked.id))!;
    await post(`/w/${main.workspace.id}/setup/discord/disconnect`);
    expect((await getDiscordConnection(env.db, linked.id))!.guild_id).toBe(SOLID_GUILD);
    expect(env.discord.messages.has(own.message_id)).toBe(true);

    // Back to the main's server: its panel there comes down and its apps go on the main's panel.
    await env.db.query('UPDATE workspaces SET on_main_panel = 0 WHERE id = $1', [linked.id]);
    const back = await post(`/w/${linked.id}/setup/discord/disconnect`);
    expect(back.headers.location).toBe(`/w/${linked.id}/setup/discord`);
    await fresh();
    expect([linked.own_discord, linked.on_main_panel]).toEqual([false, true]);
    expect(env.discord.messages.has(own.message_id)).toBe(false);
    expect(await getPanel(env.db, linked.id)).toBeNull();
    expect((await page(`/w/${linked.id}/contributors`)).body).toContain('Set up in the main workspace');
  });
});
