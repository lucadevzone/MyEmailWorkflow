// Persone: contatti confermati (con più indirizzi) e indirizzi visti nelle email ma non ancora confermati.
// Chiave di una persona: "c:<contactId>" oppure "a:<addressId>".

import { and, eq, inArray, isNull } from 'drizzle-orm';
import { z } from 'zod';
import type { GroupDto, PeopleDirectoryDto, PersonDto, ProjectSuggestion } from '@mmw/shared';
import type Database from 'better-sqlite3';
import type { Db } from '../db/client.ts';
import {
  accounts,
  contactAddresses,
  contactGroups,
  contacts,
  groupMembers,
  projectContacts,
} from '../db/schema.ts';
import { newId, now } from '../lib/ids.ts';

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
  constructor(private db: Db, private sqlite: Database.Database) {}

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
    if (!ids.length) return new Map<string, { name: string; emails: string[] }>();
    const cs = this.db
      .select()
      .from(contacts)
      .where(and(inArray(contacts.id, ids), isNull(contacts.deletedAt)))
      .all();
    const addrs = this.db.select().from(contactAddresses).where(inArray(contactAddresses.contactId, ids)).all();
    return new Map(
      cs.map((c) => [c.id, { name: c.displayName, emails: addrs.filter((a) => a.contactId === c.id).map((a) => a.email) }]),
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
      if (c) people.push({ key: `c:${id}`, contactId: id, name: c.name, emails: c.emails, conversationCount: 0, lastSeenAt: null, member: true });
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
    return { key: `c:${contactId}`, contactId, name: c.name, emails: c.emails, conversationCount: 0, lastSeenAt: null };
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

