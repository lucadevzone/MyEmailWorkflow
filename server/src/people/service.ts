// Persone: contatti confermati (con più indirizzi) e indirizzi visti nelle email ma non ancora confermati.
// Chiave di una persona: "c:<contactId>" oppure "a:<addressId>".

import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import { z } from 'zod';
import type { GroupDto, PeopleDirectoryDto, PersonDto, ProjectMembersDto, ProjectSuggestion } from '@mmw/shared';
import type Database from 'better-sqlite3';
import type { Db } from '../db/client.ts';
import {
  accounts,
  contactAddresses,
  contactGroups,
  contacts,
  groupMembers,
  projectContacts,
  projectGroups,
  messages,
  messageAddresses,
  conversations,
} from '../db/schema.ts';
import { newId, now } from '../lib/ids.ts';
import type { BlobStore } from '../store/blobs.ts';
import { rankBetween } from '../lib/rank.ts';

/** URL della foto; la parte "v" cambia con l'immagine, così il browser non usa quella vecchia in cache. */
const avatarUrl = (contactId: string, sha: string | null) => (sha ? `/api/contacts/${contactId}/avatar?v=${sha.slice(0, 12)}` : null);

/** Tipo dell'immagine dai primi byte (non ci si fida dell'header dichiarato dal client). */
export function imageMime(data: Buffer): string | null {
  if (data.length > 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) return 'image/jpeg';
  if (data.length > 8 && data.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (data.length > 12 && data.toString('ascii', 0, 4) === 'RIFF' && data.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
  return null;
}

export const contactInputSchema = z.object({
  name: z.string().trim().min(1, 'Il nome è obbligatorio'),
  emails: z.array(z.email('Indirizzo non valido')).min(1, 'Serve almeno un indirizzo'),
});

export const groupInputSchema = z.object({
  name: z.string().trim().min(1, 'Il nome è obbligatorio'),
  contactIds: z.array(z.string()).default([]),
});

export class PeopleError extends Error {}

export type PeopleScope =
  | { view: 'inbox' }
  | { view: 'noise' }
  | { view: 'project'; projectId: string }
  | { view: 'all' };

interface Row {
  key: string;
  contactId: string | null;
  convs: number;
  last: number | null;
  emails: string;
  addrName: string | null;
}

export class PeopleService {
  constructor(private db: Db, private sqlite: Database.Database, private blobs: BlobStore) {}

  private ownEmails(): string[] {
    return this.db
      .select({ email: accounts.email })
      .from(accounts)
      .where(isNull(accounts.deletedAt))
      .all()
      .map((a) => a.email.toLowerCase());
  }

  private scopeSql(scope: PeopleScope): { sql: string; params: unknown[] } {
    switch (scope.view) {
      case 'inbox':
        return { sql: 'c.project_id is null and c.is_noise = 0 and c.archived_at is null', params: [] };
      case 'noise':
        return { sql: 'c.project_id is null and c.is_noise = 1', params: [] };
      case 'project':
        return { sql: 'c.project_id = ?', params: [scope.projectId] };
      case 'all':
        return { sql: 'c.is_noise = 0', params: [] };
    }
  }

  private aggregate(scope: PeopleScope): Row[] {
    const own = this.ownEmails();
    const { sql, params } = this.scopeSql(scope);
    const ownSql = own.length ? `and ca.email not in (${own.map(() => '?').join(',')})` : '';
    return this.sqlite
      .prepare(
        `select coalesce('c:' || ca.contact_id, 'a:' || ca.id) as key,
                ca.contact_id as contactId,
                count(distinct c.id) as convs,
                max(m.date) as last,
                group_concat(distinct ca.email) as emails,
                max(ca.display_name) as addrName
           from message_addresses ma
           join messages m on m.id = ma.message_id and m.deleted_at is null
           join conversations c on c.id = m.conversation_id and c.deleted_at is null and c.trashed_at is null
           join contact_addresses ca on ca.id = ma.contact_address_id
          where ${sql} ${ownSql}
          group by key
          order by convs desc, last desc`,
      )
      .all(...params, ...own) as Row[];
  }

  private contactInfo(ids: string[]) {
    if (!ids.length) return new Map<string, { name: string; emails: string[]; avatarUrl: string | null }>();
    const cs = this.db
      .select()
      .from(contacts)
      .where(and(inArray(contacts.id, ids), isNull(contacts.deletedAt)))
      .all();
    const addrs = this.db.select().from(contactAddresses).where(inArray(contactAddresses.contactId, ids)).all();
    return new Map(
      cs.map((c) => [
        c.id,
        {
          name: c.displayName,
          emails: addrs.filter((a) => a.contactId === c.id).map((a) => a.email),
          avatarUrl: avatarUrl(c.id, c.avatarBlobSha),
        },
      ]),
    );
  }

  private toPeople(rows: Row[]): PersonDto[] {
    const info = this.contactInfo(rows.map((r) => r.contactId).filter((x): x is string => !!x));
    return rows.map((r) => {
      const c = r.contactId ? info.get(r.contactId) : undefined;
      return {
        key: r.key,
        contactId: r.contactId,
        name: c?.name ?? r.addrName,
        emails: c?.emails ?? r.emails.split(','),
        conversationCount: r.convs,
        lastSeenAt: r.last,
        avatarUrl: c?.avatarUrl ?? null,
      };
    });
  }

  /** Persone che compaiono in una vista; nei progetti anche i contatti associati a mano. */
  inScope(scope: PeopleScope): PersonDto[] {
    const people = this.toPeople(this.aggregate(scope));
    if (scope.view !== 'project') return people;

    const memberIds = this.db
      .select({ id: projectContacts.contactId })
      .from(projectContacts)
      .where(eq(projectContacts.projectId, scope.projectId))
      .all()
      .map((m) => m.id);
    const members = new Set(memberIds);
    for (const p of people) if (p.contactId && members.has(p.contactId)) p.member = true;
    const missing = memberIds.filter((id) => !people.some((p) => p.contactId === id));
    const info = this.contactInfo(missing);
    for (const id of missing) {
      const c = info.get(id);
      if (c) people.push({ key: `c:${id}`, contactId: id, name: c.name, emails: c.emails, conversationCount: 0, lastSeenAt: null, avatarUrl: c.avatarUrl, member: true });
    }
    return people;
  }

  directory(): PeopleDirectoryDto {
    const active = this.toPeople(this.aggregate({ view: 'all' }));
    const all = this.db.select().from(contacts).where(isNull(contacts.deletedAt)).all();
    const info = this.contactInfo(all.map((c) => c.id));
    const contactsList: PersonDto[] = all
      .map((c) => {
        const stats = active.find((p) => p.contactId === c.id);
        return (
          stats ?? {
            key: `c:${c.id}`,
            contactId: c.id,
            name: c.displayName,
            emails: info.get(c.id)?.emails ?? [],
            conversationCount: 0,
            lastSeenAt: null,
            avatarUrl: info.get(c.id)?.avatarUrl ?? null,
          }
        );
      })
      .sort((a, b) => b.conversationCount - a.conversationCount || (a.name ?? '').localeCompare(b.name ?? ''));
    return {
      contacts: contactsList,
      suggested: active.filter((p) => !p.contactId).slice(0, 60),
      groups: this.groups(contactsList),
    };
  }

  private groups(people: PersonDto[]): GroupDto[] {
    const gs = this.db.select().from(contactGroups).where(isNull(contactGroups.deletedAt)).all();
    const members = this.db.select().from(groupMembers).all();
    return gs
      .map((g) => ({
        id: g.id,
        name: g.name,
        members: members
          .filter((m) => m.groupId === g.id)
          .map((m) => people.find((p) => p.contactId === m.contactId))
          .filter((p): p is PersonDto => !!p),
      }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  /** Indirizzi corrispondenti a una persona (per filtrare le conversazioni). */
  addressIdsFor(key: string): string[] {
    const [kind, id] = [key.slice(0, 2), key.slice(2)];
    if (kind === 'a:') return [id];
    if (kind === 'c:') {
      return this.db
        .select({ id: contactAddresses.id })
        .from(contactAddresses)
        .where(eq(contactAddresses.contactId, id))
        .all()
        .map((a) => a.id);
    }
    if (kind === 'g:') {
      const memberIds = this.db.select({ id: groupMembers.contactId }).from(groupMembers).where(eq(groupMembers.groupId, id)).all();
      if (!memberIds.length) return [];
      return this.db
        .select({ id: contactAddresses.id })
        .from(contactAddresses)
        .where(inArray(contactAddresses.contactId, memberIds.map((m) => m.id)))
        .all()
        .map((a) => a.id);
    }
    return [];
  }

  // ─── Contatti ──────────────────────────────────────────────────────────────

  createContact(input: z.infer<typeof contactInputSchema>): PersonDto {
    const t = now();
    const id = newId();
    this.db.transaction((tx) => {
      tx.insert(contacts).values({ id, displayName: input.name, createdAt: t, updatedAt: t }).run();
      this.linkEmails(tx as unknown as Db, id, input.emails);
    });
    return this.person(id);
  }

  updateContact(id: string, input: Partial<z.infer<typeof contactInputSchema>>): PersonDto {
    const existing = this.db.select().from(contacts).where(and(eq(contacts.id, id), isNull(contacts.deletedAt))).get();
    if (!existing) throw new PeopleError('Contatto non trovato');
    const t = now();
    this.db.transaction((tx) => {
      if (input.name) tx.update(contacts).set({ displayName: input.name, updatedAt: t }).where(eq(contacts.id, id)).run();
      if (input.emails) {
        const keep = input.emails.map((e) => e.toLowerCase());
        const current = tx.select().from(contactAddresses).where(eq(contactAddresses.contactId, id)).all();
        for (const a of current) {
          if (!keep.includes(a.email)) tx.update(contactAddresses).set({ contactId: null, updatedAt: t }).where(eq(contactAddresses.id, a.id)).run();
        }
        this.linkEmails(tx as unknown as Db, id, keep);
      }
    });
    return this.person(id);
  }

  deleteContact(id: string) {
    const t = now();
    this.db.transaction((tx) => {
      tx.update(contacts).set({ deletedAt: t, updatedAt: t }).where(eq(contacts.id, id)).run();
      tx.update(contactAddresses).set({ contactId: null, updatedAt: t }).where(eq(contactAddresses.contactId, id)).run();
      tx.delete(groupMembers).where(eq(groupMembers.contactId, id)).run();
      tx.delete(projectContacts).where(eq(projectContacts.contactId, id)).run();
    });
  }

  /** Associa gli indirizzi al contatto (spostandoli da un eventuale altro contatto). */
  private linkEmails(db: Db, contactId: string, emails: string[]) {
    const t = now();
    for (const raw of emails) {
      const email = raw.toLowerCase();
      const a = db.select().from(contactAddresses).where(eq(contactAddresses.email, email)).get();
      if (a) db.update(contactAddresses).set({ contactId, updatedAt: t }).where(eq(contactAddresses.id, a.id)).run();
      else db.insert(contactAddresses).values({ id: newId(), contactId, email, createdAt: t, updatedAt: t }).run();
    }
  }

  private person(contactId: string): PersonDto {
    const c = this.contactInfo([contactId]).get(contactId);
    if (!c) throw new PeopleError('Contatto non trovato');
    return { key: `c:${contactId}`, contactId, name: c.name, emails: c.emails, conversationCount: 0, lastSeenAt: null, avatarUrl: c.avatarUrl };
  }

  /**
   * Unisce una persona (contatto "c:…" o indirizzo "a:…") nel contatto targetId.
   * Il nome resta quello del target; passano indirizzi, gruppi, progetti e (se manca) la foto.
   */
  merge(targetId: string, sourceKey: string): PersonDto {
    const target = this.db.select().from(contacts).where(and(eq(contacts.id, targetId), isNull(contacts.deletedAt))).get();
    if (!target) throw new PeopleError('Contatto non trovato');
    const [kind, id] = [sourceKey.slice(0, 2), sourceKey.slice(2)];
    const t = now();

    if (kind === 'a:') {
      const addr = this.db.select().from(contactAddresses).where(eq(contactAddresses.id, id)).get();
      if (!addr) throw new PeopleError('Indirizzo non trovato');
      if (addr.contactId) return this.merge(targetId, `c:${addr.contactId}`);
      this.db.update(contactAddresses).set({ contactId: targetId, updatedAt: t }).where(eq(contactAddresses.id, id)).run();
      return this.person(targetId);
    }
    if (kind !== 'c:') throw new PeopleError('Persona non valida');
    if (id === targetId) throw new PeopleError('Non si può unire un contatto con sé stesso');
    const source = this.db.select().from(contacts).where(and(eq(contacts.id, id), isNull(contacts.deletedAt))).get();
    if (!source) throw new PeopleError('Contatto da unire non trovato');

    this.db.transaction((tx) => {
      tx.update(contactAddresses).set({ contactId: targetId, updatedAt: t }).where(eq(contactAddresses.contactId, id)).run();
      for (const g of tx.select().from(groupMembers).where(eq(groupMembers.contactId, id)).all()) {
        tx.insert(groupMembers).values({ groupId: g.groupId, contactId: targetId }).onConflictDoNothing().run();
      }
      for (const pc of tx.select().from(projectContacts).where(eq(projectContacts.contactId, id)).all()) {
        tx.insert(projectContacts).values({ projectId: pc.projectId, contactId: targetId, createdAt: t }).onConflictDoNothing().run();
      }
      tx.delete(groupMembers).where(eq(groupMembers.contactId, id)).run();
      tx.delete(projectContacts).where(eq(projectContacts.contactId, id)).run();
      if (!target.avatarBlobSha && source.avatarBlobSha) {
        tx.update(contacts).set({ avatarBlobSha: source.avatarBlobSha }).where(eq(contacts.id, targetId)).run();
      }
      tx.update(contacts).set({ updatedAt: t }).where(eq(contacts.id, targetId)).run();
      tx.update(contacts).set({ deletedAt: t, updatedAt: t }).where(eq(contacts.id, id)).run();
    });
    return this.person(targetId);
  }

  // ─── Foto ──────────────────────────────────────────────────────────────────

  /** Imposta (o toglie, con data null) la foto di un contatto. Solo JPEG, PNG o WebP, max 2 MB. */
  setAvatar(contactId: string, data: Buffer | null): PersonDto {
    let sha: string | null = null;
    if (data) {
      const mime = imageMime(data);
      if (!mime) throw new PeopleError('Formato non supportato: usa JPEG, PNG o WebP');
      if (data.length > 2 * 1024 * 1024) throw new PeopleError('Immagine troppo grande (max 2 MB)');
      sha = this.blobs.put(data, mime);
    }
    const res = this.db
      .update(contacts)
      .set({ avatarBlobSha: sha, updatedAt: now() })
      .where(and(eq(contacts.id, contactId), isNull(contacts.deletedAt)))
      .run();
    if (!res.changes) throw new PeopleError('Contatto non trovato');
    return this.person(contactId);
  }

  avatar(contactId: string): { data: Buffer; mime: string } | undefined {
    const c = this.db.select({ sha: contacts.avatarBlobSha }).from(contacts).where(eq(contacts.id, contactId)).get();
    if (!c?.sha) return undefined;
    const data = this.blobs.read(c.sha);
    return { data, mime: imageMime(data) ?? 'application/octet-stream' };
  }

  // ─── Contatti dei progetti ─────────────────────────────────────────────────

  /** Aggiunge al progetto un contatto esistente, oppure lo crea da nome + email. */
  addToProject(projectId: string, input: { contactId?: string; name?: string; email?: string }): PersonDto {
    let contactId = input.contactId;
    if (!contactId) {
      const email = input.email?.toLowerCase();
      if (!email) throw new PeopleError('Serve un contatto o un indirizzo email');
      const addr = this.db.select().from(contactAddresses).where(eq(contactAddresses.email, email)).get();
      contactId = addr?.contactId ?? this.createContact({ name: input.name?.trim() || addr?.displayName || email.split('@')[0]!, emails: [email] }).contactId!;
    }
    this.db.insert(projectContacts).values({ projectId, contactId, createdAt: now() }).onConflictDoNothing().run();
    return { ...this.person(contactId), member: true };
  }

  /** Contatti e gruppi inseriti esplicitamente nel progetto. */
  projectMembers(projectId: string): ProjectMembersDto {
    const contactIds = this.db
      .select({ id: projectContacts.contactId })
      .from(projectContacts)
      .where(eq(projectContacts.projectId, projectId))
      .orderBy(sql`${projectContacts.rank} is null`, projectContacts.rank, projectContacts.createdAt)
      .all()
      .map((r) => r.id);
    const info = this.contactInfo(contactIds);
    const people: PersonDto[] = contactIds
      .filter((id) => info.has(id))
      .map((id) => {
        const c = info.get(id)!;
        return { key: `c:${id}`, contactId: id, name: c.name, emails: c.emails, conversationCount: 0, lastSeenAt: null, avatarUrl: c.avatarUrl, member: true };
      });
    const groupIds = this.db
      .select({ id: projectGroups.groupId })
      .from(projectGroups)
      .innerJoin(contactGroups, eq(contactGroups.id, projectGroups.groupId))
      .where(and(eq(projectGroups.projectId, projectId), isNull(contactGroups.deletedAt)))
      .orderBy(sql`${projectGroups.rank} is null`, projectGroups.rank, projectGroups.createdAt)
      .all()
      .map((r) => r.id);
    return { contacts: people, groups: this.groupsById(groupIds) };
  }

  private groupsById(ids: string[]): GroupDto[] {
    if (!ids.length) return [];
    const gs = this.db.select().from(contactGroups).where(inArray(contactGroups.id, ids)).all();
    const members = this.db.select().from(groupMembers).where(inArray(groupMembers.groupId, ids)).all();
    const info = this.contactInfo([...new Set(members.map((m) => m.contactId))]);
    return ids
      .map((id) => gs.find((g) => g.id === id))
      .filter((g): g is NonNullable<typeof g> => !!g)
      .map((g) => ({
        id: g.id,
        name: g.name,
        members: members
          .filter((m) => m.groupId === g.id && info.has(m.contactId))
          .map((m) => {
            const c = info.get(m.contactId)!;
            return { key: `c:${m.contactId}`, contactId: m.contactId, name: c.name, emails: c.emails, conversationCount: 0, lastSeenAt: null, avatarUrl: c.avatarUrl };
          }),
      }));
  }

  /** Nuovo ordine della barra contatti: chiavi "c:<contatto>" e "g:<gruppo>" (gruppi e persone ordinati a parte). */
  reorderProjectMembers(projectId: string, keys: string[]) {
    let prevC: string | null = null;
    let prevG: string | null = null;
    this.db.transaction((tx) => {
      for (const key of keys) {
        const id = key.slice(2);
        if (key.startsWith('c:')) {
          const rank = rankBetween(prevC, null);
          tx.update(projectContacts).set({ rank }).where(and(eq(projectContacts.projectId, projectId), eq(projectContacts.contactId, id))).run();
          prevC = rank;
        } else if (key.startsWith('g:')) {
          const rank = rankBetween(prevG, null);
          tx.update(projectGroups).set({ rank }).where(and(eq(projectGroups.projectId, projectId), eq(projectGroups.groupId, id))).run();
          prevG = rank;
        }
      }
    });
  }

  addGroupToProject(projectId: string, groupId: string) {
    this.db.insert(projectGroups).values({ projectId, groupId, createdAt: now() }).onConflictDoNothing().run();
  }

  removeGroupFromProject(projectId: string, groupId: string) {
    this.db.delete(projectGroups).where(and(eq(projectGroups.projectId, projectId), eq(projectGroups.groupId, groupId))).run();
  }

  /**
   * Azione suggerita su una conversazione di progetto: i partecipanti (escluso me) diventano
   * contatti (se non lo sono già) e, se sono più di uno, un gruppo; tutto viene inserito nel progetto.
   */
  participantsToProject(conversationId: string, groupName?: string): ProjectMembersDto {
    const conv = this.db.select().from(conversations).where(and(eq(conversations.id, conversationId), isNull(conversations.deletedAt))).get();
    if (!conv) throw new PeopleError('Conversazione non trovata');
    if (!conv.projectId) throw new PeopleError('La conversazione non è in un progetto');
    const own = new Set(this.ownEmails());
    const addrs = this.db
      .selectDistinct({ id: contactAddresses.id, email: contactAddresses.email, name: contactAddresses.displayName, contactId: contactAddresses.contactId })
      .from(messageAddresses)
      .innerJoin(messages, eq(messages.id, messageAddresses.messageId))
      .innerJoin(contactAddresses, eq(contactAddresses.id, messageAddresses.contactAddressId))
      .where(and(eq(messages.conversationId, conversationId), isNull(messages.deletedAt)))
      .all()
      .filter((a) => !own.has(a.email));
    if (!addrs.length) throw new PeopleError('Nessun destinatario oltre a te');

    const contactIds = [
      ...new Set(addrs.map((a) => a.contactId ?? this.createContact({ name: a.name?.trim() || a.email.split('@')[0]!, emails: [a.email] }).contactId!)),
    ];
    if (contactIds.length === 1) {
      this.addToProject(conv.projectId, { contactId: contactIds[0] });
    } else {
      const name = groupName?.trim() || conv.subject || 'Gruppo';
      const groupId = this.saveGroup(null, { name, contactIds });
      this.addGroupToProject(conv.projectId, groupId);
    }
    return this.projectMembers(conv.projectId);
  }

  removeFromProject(projectId: string, contactId: string) {
    this.db
      .delete(projectContacts)
      .where(and(eq(projectContacts.projectId, projectId), eq(projectContacts.contactId, contactId)))
      .run();
  }

  // ─── Gruppi ────────────────────────────────────────────────────────────────

  saveGroup(id: string | null, input: z.infer<typeof groupInputSchema>): string {
    const t = now();
    const groupId = id ?? newId();
    this.db.transaction((tx) => {
      if (id) tx.update(contactGroups).set({ name: input.name, updatedAt: t }).where(eq(contactGroups.id, id)).run();
      else tx.insert(contactGroups).values({ id: groupId, name: input.name, createdAt: t, updatedAt: t }).run();
      tx.delete(groupMembers).where(eq(groupMembers.groupId, groupId)).run();
      for (const contactId of new Set(input.contactIds)) tx.insert(groupMembers).values({ groupId, contactId }).run();
    });
    return groupId;
  }

  deleteGroup(id: string) {
    const t = now();
    this.db.delete(groupMembers).where(eq(groupMembers.groupId, id)).run();
    this.db.update(contactGroups).set({ deletedAt: t, updatedAt: t }).where(eq(contactGroups.id, id)).run();
  }

  // ─── Progetto suggerito ────────────────────────────────────────────────────

  /** Progetti in cui compaiono questi indirizzi (e gli altri indirizzi dei loro contatti). */
  suggestProjects(emails: string[]): ProjectSuggestion[] {
    const list = emails.map((e) => e.toLowerCase()).filter(Boolean);
    if (!list.length) return [];
    const ph = list.map(() => '?').join(',');
    return this.sqlite
      .prepare(
        `with addr as (
           select id from contact_addresses where email in (${ph})
           union
           select a2.id from contact_addresses a1 join contact_addresses a2 on a2.contact_id = a1.contact_id
            where a1.email in (${ph}) and a1.contact_id is not null
         )
         select p.id as projectId, p.name as name, count(distinct c.id) as conversations
           from message_addresses ma
           join messages m on m.id = ma.message_id and m.deleted_at is null
           join conversations c on c.id = m.conversation_id and c.deleted_at is null and c.project_id is not null
           join projects p on p.id = c.project_id and p.deleted_at is null and p.archived = 0
          where ma.contact_address_id in (select id from addr)
          group by p.id
          order by conversations desc, max(c.last_message_at) desc
          limit 5`,
      )
      .all(...list, ...list) as ProjectSuggestion[];
  }
}

