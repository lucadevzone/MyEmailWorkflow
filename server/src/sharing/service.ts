// Uso alternato su più PC (docs/03-uso-su-piu-pc.md), fase 2: cartella condivisa e semaforo.
//
// Nella cartella condivisa (es. Google Drive) stanno il semaforo (semaforo.json: chi ha il database,
// segnale di vita, versione) e le ultime versioni consegnate dei dati personali (personale-<v>.sqlite).
// Un solo PC alla volta ha il database e lavora; gli altri sono in sola lettura finché non lo prendono.
//
// Il database locale non sta mai nella cartella condivisa: si consegna una copia scritta tutta in una volta
// (file temporaneo + rinomina), così Google Drive non carica mai un file a metà.

import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import BetterSqlite3 from 'better-sqlite3';
import type Database from 'better-sqlite3';
import type { SharingFolderInput, SharingFolderPreviewDto, SharingLeaseDto, SharingState, SharingStatusDto } from '@mmw/shared';
import { exportPersonal, importPersonal } from './exchange.ts';
import { downloadFiles, fetchFile, personalBlobShas, uploadFiles } from './files.ts';
import type { BlobStore } from '../store/blobs.ts';
import { forgetAiWindow } from '../ai/window.ts';
import { bus } from '../events/bus.ts';

const LEASE_FILE = 'semaforo.json';
const dataFile = (version: number) => `personale-${version}.sqlite`;
/** Versioni consegnate conservate nella cartella. */
const KEEP_VERSIONS = 3;
/** Ogni quanto il PC che lavora aggiorna il segnale di vita. */
const HEARTBEAT_MS = 30_000;
/** Senza segnale di vita da tanto, il PC si considera spento: si può prendere il database comunque. */
const STALE_MS = 5 * 60_000;
/** Consegna di sicurezza mentre si lavora (solo se i dati sono cambiati). */
const SAFETY_DELIVERY_MS = 10 * 60_000;
const TICK_MS = 10_000;

interface LeaseFile {
  holderId: string | null;
  holderName: string | null;
  since: number | null;
  heartbeat: number | null;
  version: number;
  file: string | null;
  sha256: string | null;
  size: number | null;
  releaseRequest: { by: string; byName: string; at: number } | null;
}

/** Processi che scrivono sul database (posta, analisi, coda attività): solo sul PC che ha il database. */
export interface Writers {
  start(): void;
  stop(): Promise<void>;
}

export class SharingError extends Error {}

export class SharingService {
  private state: SharingState = 'disabled';
  private writersOn = false;
  private error: string | null = null;
  private lastActivity = Date.now();
  private lastHeartbeat = 0;
  private lastDeliveryAt: number | null = null;
  private timer: NodeJS.Timeout | null = null;
  private busy: Promise<unknown> = Promise.resolve();
  /** File caricati sull'altro PC che Google Drive non ha ancora portato qui: si riprova a ogni giro. */
  private missingFiles = 0;

  constructor(private deps: { sqlite: Database.Database; dataDir: string; writers: Writers; log: (msg: string) => void; blobs?: BlobStore }) {
    const blobs = deps.blobs;
    blobs?.setFallback((sha) => (this.folder ? fetchFile(blobs, this.folder, sha) : false));
  }

  // ─── Impostazioni di questo PC (non viaggiano) ─────────────────────────────

  private getSetting<T>(key: string, fallback: T): T {
    const r = this.deps.sqlite.prepare('select value from settings where key = ?').get(key) as { value: string } | undefined;
    return r ? (JSON.parse(r.value) as T) : fallback;
  }
  private setSetting(key: string, value: unknown) {
    this.deps.sqlite
      .prepare('insert into settings (key, value, updated_at) values (?, ?, ?) on conflict(key) do update set value = excluded.value, updated_at = excluded.updated_at')
      .run(key, JSON.stringify(value), Date.now());
  }
  private get machineId(): string {
    let id = this.getSetting<string | null>('machine.id', null);
    if (!id) {
      id = crypto.randomUUID();
      this.setSetting('machine.id', id);
    }
    return id;
  }
  private get machineName(): string {
    return this.getSetting<string | null>('machine.name', null) ?? os.hostname().replace(/\.local$/, '');
  }
  private get folder(): string | null {
    return this.getSetting<string | null>('machine.sharedFolder', null);
  }
  private get idleMinutes(): number {
    return this.getSetting<number>('machine.idleReleaseMinutes', 10);
  }
  private get localVersion(): number {
    return this.getSetting<number>('exchange.version', 0);
  }

  // ─── Semaforo ──────────────────────────────────────────────────────────────

  private leasePath(folder = this.folder) {
    return folder ? path.join(folder, LEASE_FILE) : null;
  }
  private readLease(folder = this.folder): LeaseFile | null {
    const p = this.leasePath(folder);
    if (!p || !fs.existsSync(p)) return null;
    try {
      return JSON.parse(fs.readFileSync(p, 'utf8')) as LeaseFile;
    } catch {
      // Google Drive lo sta riscrivendo: si riprova al giro dopo.
      throw new SharingError('Semaforo illeggibile in questo momento (sincronizzazione in corso?)');
    }
  }
  /** Scrittura tutta in una volta: file temporaneo e rinomina. */
  private writeLease(lease: LeaseFile, folder = this.folder) {
    const p = this.leasePath(folder)!;
    const tmp = `${p}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(lease, null, 2));
    fs.renameSync(tmp, p);
  }
  private isStale(lease: LeaseFile | null) {
    return !!lease?.holderId && Date.now() - (lease.heartbeat ?? 0) > STALE_MS;
  }

  // ─── Stato ─────────────────────────────────────────────────────────────────

  status(): SharingStatusDto {
    let lease: LeaseFile | null = null;
    try {
      lease = this.readLease();
    } catch {
      /* resta l'ultimo stato noto */
    }
    const dto: SharingLeaseDto | null = lease && {
      holderId: lease.holderId,
      holderName: lease.holderName,
      since: lease.since,
      heartbeat: lease.heartbeat,
      version: lease.version,
      releaseRequestedBy: lease.releaseRequest?.byName ?? null,
    };
    return {
      state: this.state,
      folder: this.folder,
      machineId: this.machineId,
      machineName: this.machineName,
      idleReleaseMinutes: this.idleMinutes,
      lease: dto,
      localVersion: this.localVersion,
      lastDeliveryAt: this.lastDeliveryAt,
      holderStale: this.isStale(lease),
      error: this.error,
    };
  }

  /** Le modifiche sono permesse solo al PC che ha il database (o senza cartella condivisa). */
  get writable() {
    return this.state === 'disabled' || this.state === 'holder';
  }

  markActivity() {
    this.lastActivity = Date.now();
  }

  private setState(s: SharingState) {
    if (this.state !== s) {
      this.state = s;
      bus.publish({ type: 'sharing' });
    }
  }
  private startWriters() {
    if (this.writersOn) return;
    this.writersOn = true;
    this.deps.writers.start();
  }
  private async stopWriters() {
    if (!this.writersOn) return;
    this.writersOn = false;
    await this.deps.writers.stop();
  }
  /** Un'operazione alla volta (presa, rilascio, consegna, giro del timer). */
  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.busy.then(fn, fn);
    this.busy = next.catch(() => {});
    return next;
  }

  // ─── Avvio e arresto ───────────────────────────────────────────────────────

  async init() {
    await this.serial(async () => {
      if (!this.folder) {
        this.setState('disabled');
        this.startWriters();
        return;
      }
      await this.join();
    });
    this.timer = setInterval(() => void this.tick(), TICK_MS);
    this.timer.unref?.();
  }

  /** Arresto dell'app: si consegna e si libera il database, così l'altro PC può prenderlo. */
  async shutdown() {
    if (this.timer) clearInterval(this.timer);
    await this.serial(async () => {
      if (this.state === 'holder') await this.doRelease();
      await this.stopWriters();
    });
  }

  /** Cartella appena scelta o all'avvio: si prende il database se libero, altrimenti si aspetta. */
  private async join() {
    const folder = this.folder!;
    if (!fs.existsSync(folder)) {
      this.error = `Cartella condivisa non raggiungibile: ${folder}`;
      this.setState('waiting');
      await this.stopWriters();
      return;
    }
    this.error = null;
    const lease = this.readLease();
    if (!lease) {
      // Cartella nuova: questo PC la inaugura con i suoi dati.
      this.writeLease({ holderId: this.machineId, holderName: this.machineName, since: Date.now(), heartbeat: Date.now(), version: this.localVersion, file: null, sha256: null, size: null, releaseRequest: null });
      this.setState('holder');
      this.startWriters();
      this.doDeliver(true);
      return;
    }
    if (lease.holderId === this.machineId) {
      // Riavvio dopo una chiusura brusca: il database è ancora nostro.
      this.setState('holder');
      this.startWriters();
      return;
    }
    if (!lease.holderId) {
      try {
        await this.doAcquire(false);
      } catch (err) {
        // Libero ma il file non è ancora arrivato da Drive (stato "syncing"): si riprova al giro.
        if (!(err instanceof SharingError)) throw err;
        if (this.state !== 'syncing') this.setState('waiting');
        await this.stopWriters();
      }
      return;
    }
    this.setState('waiting');
    await this.stopWriters();
  }

  // ─── Presa, rilascio, consegna ─────────────────────────────────────────────

  acquire(force = false): Promise<SharingStatusDto> {
    return this.serial(async () => {
      await this.doAcquire(force);
      return this.status();
    });
  }

  private async doAcquire(force: boolean) {
    if (!this.folder) throw new SharingError('Nessuna cartella condivisa');
    if (this.state === 'holder') return;
    const lease = this.readLease();
    if (lease?.holderId && lease.holderId !== this.machineId && !(force && this.isStale(lease))) {
      throw new SharingError(`Il database è in uso su ${lease.holderName ?? 'un altro PC'}`);
    }
    // Versione più nuova consegnata altrove: serve il file completo prima di prendere il database.
    if (lease && lease.version > this.localVersion) {
      const file = lease.file ? path.join(this.folder, lease.file) : null;
      if (!file || !fs.existsSync(file) || fs.statSync(file).size !== lease.size || sha256(file) !== lease.sha256) {
        this.setState('syncing');
        throw new SharingError('Google Drive non ha ancora scaricato l\'ultima versione: riprova tra poco');
      }
      // Si lavora su una copia locale del file scaricato.
      const local = path.join(this.deps.dataDir, `in-arrivo-${lease.version}.sqlite`);
      fs.copyFileSync(file, local);
      try {
        const r = importPersonal(this.deps.sqlite, local);
        // Impronta di ciò che si è ricevuto: se si rilascia senza modifiche, non serve una versione nuova.
        this.setSetting('exchange.contentHash', contentHash(this.deps.sqlite, local));
        this.deps.log(`Uso su più PC: importata la versione ${r.version} da ${r.machine} (${r.movedMessages} messaggi riordinati, ${r.pendingRefs} riferimenti in sospeso)`);
      } finally {
        fs.rmSync(local, { force: true });
      }
      this.fetchFiles();
      forgetAiWindow();
      for (const type of ['projects', 'tasks', 'people', 'activities'] as const) bus.publish({ type });
      bus.publish({ type: 'conversations', ids: [] });
    }
    this.writeLease({
      holderId: this.machineId,
      holderName: this.machineName,
      since: Date.now(),
      heartbeat: Date.now(),
      version: Math.max(lease?.version ?? 0, this.localVersion),
      file: lease?.file ?? null,
      sha256: lease?.sha256 ?? null,
      size: lease?.size ?? null,
      releaseRequest: null,
    });
    this.lastHeartbeat = Date.now();
    this.lastActivity = Date.now();
    this.setState('holder');
    this.startWriters();
  }

  release(): Promise<SharingStatusDto> {
    return this.serial(async () => {
      if (this.state === 'holder') await this.doRelease();
      return this.status();
    });
  }

  private async doRelease() {
    await this.stopWriters();
    const version = this.doDeliver(false);
    const lease = this.readLease();
    this.writeLease({ ...(lease ?? emptyLease()), holderId: null, holderName: null, since: null, heartbeat: Date.now(), version, releaseRequest: null });
    this.setState('waiting');
    this.deps.log(`Uso su più PC: database rilasciato (versione ${version})`);
  }

  /** Consegna senza rilasciare (consegna di sicurezza o "Consegna ora"). */
  deliver(): Promise<SharingStatusDto> {
    return this.serial(async () => {
      if (this.state !== 'holder') throw new SharingError('Solo il PC che ha il database può consegnare');
      this.doDeliver(true);
      return this.status();
    });
  }

  /**
   * Esporta i dati personali; se sono cambiati dall'ultima consegna, li mette nella cartella come nuova
   * versione e aggiorna il semaforo. Restituisce la versione corrente.
   */
  private doDeliver(keepHolder: boolean): number {
    const folder = this.folder!;
    // Prima i file, poi i dati che li citano: chi prende trova già tutto.
    if (this.deps.blobs) {
      const n = uploadFiles(this.deps.sqlite, this.deps.blobs, folder);
      if (n) this.deps.log(`Uso su più PC: ${n} file messi nella cartella condivisa`);
    }
    const lease = this.readLease() ?? emptyLease();
    const tmpLocal = path.join(this.deps.dataDir, 'in-consegna.sqlite');
    const next = Math.max(lease.version, this.localVersion) + 1;
    exportPersonal(this.deps.sqlite, tmpLocal, { version: next, machine: this.machineName, exportedAt: Date.now() });
    const hash = contentHash(this.deps.sqlite, tmpLocal);
    if (hash === this.getSetting<string | null>('exchange.contentHash', null) && lease.file && fs.existsSync(path.join(folder, lease.file))) {
      fs.rmSync(tmpLocal, { force: true });
      this.lastDeliveryAt = Date.now();
      return lease.version;
    }
    const name = dataFile(next);
    const dest = path.join(folder, name);
    fs.copyFileSync(tmpLocal, `${dest}.tmp`);
    fs.renameSync(`${dest}.tmp`, dest);
    const size = fs.statSync(dest).size;
    const sha = sha256(dest);
    fs.rmSync(tmpLocal, { force: true });
    this.writeLease({
      ...lease,
      ...(keepHolder ? { holderId: this.machineId, holderName: this.machineName, heartbeat: Date.now() } : {}),
      version: next,
      file: name,
      sha256: sha,
      size,
    });
    this.setSetting('exchange.version', next);
    this.setSetting('exchange.contentHash', hash);
    this.lastDeliveryAt = Date.now();
    this.pruneOldVersions(folder, next);
    this.deps.log(`Uso su più PC: consegnata la versione ${next} (${(size / 1e6).toFixed(1)} MB)`);
    return next;
  }

  /** Porta qui i file caricati sull'altro PC (risorse, foto, allegati) che mancano. */
  private fetchFiles() {
    if (!this.deps.blobs || !this.folder) return;
    const r = downloadFiles(this.deps.sqlite, this.deps.blobs, this.folder);
    if (r.copied) {
      this.deps.log(`Uso su più PC: ${r.copied} file presi dalla cartella condivisa`);
      bus.publish({ type: 'people' });
    }
    this.missingFiles = r.missing;
  }

  private pruneOldVersions(folder: string, current: number) {
    for (const f of fs.readdirSync(folder)) {
      const m = /^personale-(\d+)\.sqlite$/.exec(f);
      if (m && Number(m[1]) <= current - KEEP_VERSIONS) fs.rmSync(path.join(folder, f), { force: true });
    }
  }

  /** Un altro PC chiede il database: lo si scrive nel semaforo, chi lo ha lo rilascia al prossimo giro. */
  requestRelease(): SharingStatusDto {
    const lease = this.readLease();
    if (!lease?.holderId || lease.holderId === this.machineId) return this.status();
    this.writeLease({ ...lease, releaseRequest: { by: this.machineId, byName: this.machineName, at: Date.now() } });
    return this.status();
  }

  // ─── Impostazioni ──────────────────────────────────────────────────────────

  setMachine(input: { name?: string; idleReleaseMinutes?: number }): SharingStatusDto {
    if (input.name !== undefined) this.setSetting('machine.name', input.name.trim() || null);
    if (input.idleReleaseMinutes !== undefined) this.setSetting('machine.idleReleaseMinutes', input.idleReleaseMinutes);
    return this.status();
  }

  /** Cambia (o toglie) la cartella condivisa; con copy porta il contenuto di quella attuale nella nuova. */
  setFolder(input: SharingFolderInput): Promise<SharingStatusDto> {
    return this.serial(async () => {
      const old = this.folder;
      const folder = resolveFolder(input.folder);
      if (folder) {
        // La sottocartella proposta (es. …/Il mio Drive/MyEmailWorkflow) si crea, se esiste quella che la contiene.
        if (!fs.existsSync(folder) && fs.existsSync(path.dirname(folder))) fs.mkdirSync(folder);
        if (!fs.existsSync(folder) || !fs.statSync(folder).isDirectory()) throw new SharingError('La cartella non esiste');
        try {
          fs.accessSync(folder, fs.constants.W_OK);
        } catch {
          throw new SharingError('Nella cartella non si può scrivere');
        }
      }
      if (folder && input.join && !fs.existsSync(path.join(folder, LEASE_FILE))) {
        throw new SharingError("In questa cartella non ci sono i dati dell'altro PC. Se Google Drive la sta ancora scaricando, riprova tra poco.");
      }
      if (folder === old) return this.status();
      if (folder && old && input.copy && fs.existsSync(old)) copyFolderContent(old, folder);
      this.setSetting('machine.sharedFolder', folder);
      if (!folder) {
        this.error = null;
        this.setState('disabled');
        this.startWriters();
        return this.status();
      }
      await this.join();
      return this.status();
    });
  }

  /**
   * Cosa succederebbe scegliendo questa cartella, per chiedere conferma: dati di un altro PC già presenti
   * (che sostituiranno quelli di qui), contenuto della cartella attuale da copiare, oppure dati di questo PC
   * da scrivere (si esporta per misurarli).
   */
  previewFolder(input: SharingFolderInput): SharingFolderPreviewDto {
    const folder = resolveFolder(input.folder);
    if (!folder) throw new SharingError('Nessuna cartella');
    const base = { folder, create: !fs.existsSync(folder), holderName: null, version: null, from: null, dataBytes: 0 };
    if (!base.create && !fs.statSync(folder).isDirectory()) throw new SharingError('Non è una cartella');
    if (base.create && !fs.existsSync(path.dirname(folder))) throw new SharingError('La cartella non esiste');
    const leaseFile = path.join(folder, LEASE_FILE);
    if (fs.existsSync(leaseFile)) {
      let lease: LeaseFile | null = null;
      try {
        lease = JSON.parse(fs.readFileSync(leaseFile, 'utf8')) as LeaseFile;
      } catch {
        /* semaforo illeggibile: si mostra quel che si sa */
      }
      const data = lease?.file ? path.join(folder, lease.file) : null;
      const present = !!data && fs.existsSync(data);
      // Database libero: il semaforo non dice più chi l'aveva, lo dice il file consegnato.
      let holderName = lease?.holderName ?? null;
      if (!holderName && present) {
        try {
          const db = new BetterSqlite3(data, { readonly: true, fileMustExist: true });
          try {
            holderName = (db.prepare("select value from meta where key = 'machine'").get() as { value: string } | undefined)?.value || null;
          } finally {
            db.close();
          }
        } catch {
          /* file non ancora scaricato del tutto */
        }
      }
      return { ...base, mode: 'join', bytes: present ? fs.statSync(data).size : (lease?.size ?? 0), files: 1, holderName, version: lease?.version ?? null };
    }
    const old = this.folder;
    if (old && old !== folder && input.copy && fs.existsSync(old)) {
      const { bytes, files } = folderContentSize(old, folder);
      return { ...base, mode: 'copy', bytes, files, from: old };
    }
    const tmp = path.join(this.deps.dataDir, 'stima.sqlite');
    try {
      exportPersonal(this.deps.sqlite, tmp, { version: 0, machine: this.machineName, exportedAt: Date.now() });
      const dataBytes = fs.statSync(tmp).size;
      let fileBytes = 0;
      let files = 0;
      const size = this.deps.sqlite.prepare('select size from blobs where sha256 = ?');
      for (const sha of personalBlobShas(this.deps.sqlite)) {
        files++;
        fileBytes += (size.get(sha) as { size: number } | undefined)?.size ?? 0;
      }
      return { ...base, mode: 'new', bytes: dataBytes + fileBytes, files, dataBytes };
    } finally {
      fs.rmSync(tmp, { force: true });
    }
  }

  // ─── Giro periodico ────────────────────────────────────────────────────────

  private tick() {
    return this.serial(async () => {
      if (!this.folder) return;
      let lease: LeaseFile | null;
      try {
        lease = this.readLease();
      } catch (err) {
        this.error = (err as Error).message;
        return;
      }
      const now = Date.now();
      if (this.state === 'holder') {
        if (lease?.holderId && lease.holderId !== this.machineId && (lease.since ?? 0) > 0) {
          // Un altro PC l'ha preso (dopo un nostro silenzio): si smette di scrivere.
          this.deps.log(`Uso su più PC: il database è stato preso da ${lease.holderName}`);
          await this.stopWriters();
          this.setState('waiting');
          return;
        }
        if (lease?.releaseRequest && lease.releaseRequest.by !== this.machineId) {
          this.deps.log(`Uso su più PC: ${lease.releaseRequest.byName} chiede il database`);
          await this.doRelease();
          return;
        }
        if (this.idleMinutes > 0 && now - this.lastActivity > this.idleMinutes * 60_000) {
          this.deps.log(`Uso su più PC: rilascio dopo ${this.idleMinutes} minuti senza uso`);
          await this.doRelease();
          return;
        }
        if (this.missingFiles) this.fetchFiles();
        if (now - (this.lastDeliveryAt ?? 0) > SAFETY_DELIVERY_MS) this.doDeliver(true);
        if (now - this.lastHeartbeat > HEARTBEAT_MS && lease) {
          this.writeLease({ ...lease, heartbeat: now });
          this.lastHeartbeat = now;
        }
        return;
      }
      // In attesa: si aggiorna solo lo stato (libero ma file non ancora arrivato, oppure occupato).
      if (this.state === 'syncing' || this.state === 'waiting') bus.publish({ type: 'sharing' });
    });
  }
}

function emptyLease(): LeaseFile {
  return { holderId: null, holderName: null, since: null, heartbeat: null, version: 0, file: null, sha256: null, size: null, releaseRequest: null };
}

function sha256(file: string): string {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

/** Impronta del contenuto (senza i metadati che cambiano a ogni esportazione: versione, data). */
function contentHash(sqlite: Database.Database, file: string): string {
  sqlite.prepare('attach database ? as h').run(file);
  try {
    const h = crypto.createHash('sha256');
    const tables = (sqlite.prepare("select name from h.sqlite_master where type = 'table' and name <> 'meta' order by name").all() as { name: string }[]).map((t) => t.name);
    for (const t of tables) {
      h.update(t);
      for (const row of sqlite.prepare(`select * from h."${t}" order by 1`).iterate()) h.update(JSON.stringify(row));
    }
    return h.digest('hex');
  } finally {
    sqlite.prepare('detach database h').run();
  }
}

const resolveFolder = (raw: string | null | undefined): string | null =>
  raw?.trim() ? path.resolve(raw.trim().replace(/^~(?=$|\/)/, os.homedir())) : null;

const copied = (f: string) => f === LEASE_FILE || /^personale-\d+\.sqlite$/.test(f) || f === 'files';

/** Byte e file che copyFolderContent copierebbe. */
function folderContentSize(from: string, to: string): { bytes: number; files: number } {
  let bytes = 0;
  let files = 0;
  const walk = (p: string) => {
    const st = fs.statSync(p);
    if (st.isDirectory()) for (const f of fs.readdirSync(p)) walk(path.join(p, f));
    else {
      bytes += st.size;
      files++;
    }
  };
  for (const f of fs.readdirSync(from)) if (copied(f) && !fs.existsSync(path.join(to, f))) walk(path.join(from, f));
  return { bytes, files };
}

function copyFolderContent(from: string, to: string) {
  for (const f of fs.readdirSync(from)) {
    if (!copied(f)) continue;
    const src = path.join(from, f);
    const dest = path.join(to, f);
    if (fs.existsSync(dest)) continue;
    fs.cpSync(src, dest, { recursive: true });
  }
}
