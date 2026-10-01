// PreviewManager — Runtime-ээс ДЭЭШ байх давхарга.
//
// Энэ файл доод давхаргын хэрэгжүүлэлтийг НЭРЭЭР Ч мэдэхгүй. `Runtime`
// интерфейсээр л ажиллана. Тиймээс энд бичигдсэн бүх зүйл VMM солигдоход
// АМЬД ҮЛДЭНЭ — төслийн 10 жил наслах хөрөнгө нь яг энэ.
//
// (Хэрэгжүүлэлтийн нэрийг энд бичих гэж оролдвол `test/no-leak.test.ts`
//  улаан болно. Тэр нь зөв: нэр дурдах эрх нь `src/runtime/` дотор л бий.)
//
// Хариуцдаг зүйлс:
//   багтаамжийн хаалт · TTL/keepalive · restart-аас сэргэх (reconcile) ·
//   хэмжигч · алдааны гэрээ
//
// SAND дээр өвдөж сурсан 4 зүйл энд шингэсэн:
//   1. Слотыг `await`-аас ӨМНӨ синхроноор нөөцлөнө. Эс тэгвэл зэрэгцээ
//      хүсэлтүүд ижил слотыг хуваана (SAND-ийн жинхэнэ алдаа).
//   2. `oomKilled` хэмжиж ЧАДАХГҮЙ үед `null`, 0 БИШ. Самбар «OOM 0» гэж
//      худал хэвлэснээс болж хэрэглэгчийн ажил хэдэн долоо хоног үхэж байв.
//   3. Санах ойд хадгалсан жагсаалт эх сурвалж БИШ — `reconcile()` үнэнийг
//      доод давхаргаас асууна.
//   4. Хугацаа нь `Clock`-оор орно. Тест жинхэнэ хүлээхгүй → TTL-ийн
//      логик найдвартай хэмжигдэнэ.

import type { Machine, Runtime, Workspace, WriteResult } from "../runtime/types.ts";
import { capacityFull, previewGone, previewNotFound, workspaceLost } from "./errors.ts";

export interface Clock {
  now(): number;
}

export const systemClock: Clock = { now: () => Date.now() };

export interface PreviewManagerOptions {
  runtime: Runtime;
  /** Машины үзүүлэлт — бүх preview ижил. */
  image: string;
  workdir: string;
  port: number;
  memMb: number;
  cpus: number;
  argv?: string[];
  env?: Record<string, string>;
  /** Зэрэг ажиллах preview-ийн дээд тоо. Хэтрэхэд capacity-full. */
  maxPreviews: number;
  /** Хүрэлцэхгүй бол чөлөөлөгдөх хугацаа. keepAlive сунгана. */
  ttlMs: number;
  clock?: Clock;
}

export interface PreviewInfo {
  id: string;
  workspaceId: string;
  createdAt: number;
  expiresAt: number;
  /** Сэргээгдсэн (reconcile-аар олдсон) эсэх — шинээр үүсгэгдсэн биш. */
  adopted: boolean;
}

export interface Stats {
  active: number;
  max: number;
  /** Амжилттай үүссэн preview-ийн тоо. */
  created: number;
  /** Багтаамжаар татгалзсан хүсэлт. */
  rejected: number;
  /** TTL-ээр чөлөөлөгдсөн. */
  expired: number;
  /** Доод давхаргаас алга болсон (бид зогсоогоогүй). */
  vanished: number;
  /** restart-ийн дараа сэргээгдсэн. */
  adopted: number;
  /** Машин бий ч файлууд алга байсан тул устгасан. */
  workspaceLost: number;
  /**
   * Санах ойн хязгаараар алагдсан.
   *
   * ⚠️ `null` нь «ХЭМЖИЖ ЧАДАХГҮЙ» гэсэн үг — `0` БИШ. Доод давхарга
   *    `caps.memoryLimit === false` бол энэ нь ҮРГЭЛЖ null байна.
   *    Самбар дээр «0» гэж хэвлэвэл худал болно.
   */
  oomKilled: number | null;
}

export interface ReconcileResult {
  adopted: string[];
  /** Файлууд алга байсан тул устгасан машинууд. */
  dropped: Array<{ id: string; reason: "workspace-lost" | "not-running" }>;
}

export interface SweepResult {
  expired: string[];
  vanished: string[];
  oomKilled: string[];
}

interface Entry {
  id: string;
  workspaceId: string;
  machine: Machine;
  workspace: Workspace;
  createdAt: number;
  expiresAt: number;
  adopted: boolean;
}

export class PreviewManager {
  private rt: Runtime;
  private o: PreviewManagerOptions;
  private clock: Clock;
  private entries = new Map<string, Entry>();

  /**
   * Нөөцлөгдсөн ч бүртгэгдээгүй слотын тоо.
   *
   * ⚠️ ЭНЭ БОЛ SAND-ИЙН ЖИНХЭНЭ АЛДААНЫ ЗАСВАР. `create()` дотор Docker
   *    руу хандах `await` байдаг. Хэрэв багтаамжийг зөвхөн `entries.size`-
   *    аар шалгавал зэрэг ирсэн 10 хүсэлт бүгд «сул байна» гэж уншаад
   *    хязгаарыг давна. Тиймээс слот нь ПЕРВЫЙ `await`-аас өмнө
   *    синхроноор нөөцлөгдөнө.
   */
  private pending = 0;

  private counters = {
    created: 0,
    rejected: 0,
    expired: 0,
    vanished: 0,
    adopted: 0,
    workspaceLost: 0,
    oomKilled: 0,
  };

  constructor(opts: PreviewManagerOptions) {
    this.rt = opts.runtime;
    this.o = opts;
    this.clock = opts.clock ?? systemClock;
  }

  /** Эзэлсэн слот = бүртгэгдсэн + нөөцлөгдсөн. */
  private occupied(): number {
    return this.entries.size + this.pending;
  }

  // ─────────────────────────────────────────────────────────────────────
  // Үүсгэх
  // ─────────────────────────────────────────────────────────────────────

  async create(files: Record<string, string | Uint8Array>): Promise<PreviewInfo> {
    // ⚠️ Синхрон хэсэг. Энд `await` байж БОЛОХГҮЙ.
    if (this.occupied() >= this.o.maxPreviews) {
      this.counters.rejected++;
      throw capacityFull(this.o.maxPreviews, Math.ceil(this.o.ttlMs / 1000));
    }
    this.pending++;
    // ─── синхрон хэсэг дууслаа ───

    let ws: Workspace | null = null;
    let m: Machine | null = null;
    try {
      ws = await this.rt.createWorkspace();
      const w = await ws.write(files);
      // Хэсэгчилсэн амжилтыг ЧИМЭЭГҮЙ өнгөрүүлэхгүй.
      if (w.rejected.length > 0) {
        const names = w.rejected.map((r) => `${r.path} (${r.reason})`).join(", ");
        throw new Error(`файл бичигдсэнгүй: ${names}`);
      }

      m = await this.rt.create({
        workspace: ws,
        image: this.o.image,
        workdir: this.o.workdir,
        port: this.o.port,
        memMb: this.o.memMb,
        cpus: this.o.cpus,
        ...(this.o.argv ? { argv: this.o.argv } : {}),
        ...(this.o.env ? { env: this.o.env } : {}),
      });
      await m.start();

      const now = this.clock.now();
      const entry: Entry = {
        id: m.id,
        workspaceId: ws.id,
        machine: m,
        workspace: ws,
        createdAt: now,
        expiresAt: now + this.o.ttlMs,
        adopted: false,
      };
      this.entries.set(entry.id, entry);
      this.counters.created++;
      return this.toInfo(entry);
    } catch (e) {
      // Үлдэгдэл хаяхгүй. Машин үүссэн байж магадгүй.
      if (m) await m.destroy().catch(() => {});
      if (ws) await ws.dispose().catch(() => {});
      throw e;
    } finally {
      // Слот нь бүртгэгдсэн эсвэл чөлөөлөгдсөн — хоёр тохиолдолд ч
      // нөөцлөлт дуусна.
      this.pending--;
    }
  }

  // ─────────────────────────────────────────────────────────────────────
  // Хугацаа
  // ─────────────────────────────────────────────────────────────────────

  /** Амьдрах хугацааг сунгана. Байхгүй бол preview-not-found. */
  keepAlive(id: string): PreviewInfo {
    const e = this.entries.get(id);
    if (!e) throw previewNotFound(id);
    e.expiresAt = this.clock.now() + this.o.ttlMs;
    return this.toInfo(e);
  }

  /**
   * Хугацаа хэтэрсэн ба алга болсныг цэвэрлэнэ.
   *
   * Хоёр өөр зүйлийг ТУСАД НЬ тоолно:
   *   expired  — бид чөлөөлсөн (хэвийн)
   *   vanished — доод давхаргаас алга болсон (бид зогсоогоогүй)
   * SAND-д эдгээр нэг тоонд нийлж, «preview яагаад үхэв» гэдэг хариугүй
   * болдог байв.
   */
  async sweep(): Promise<SweepResult> {
    const res: SweepResult = { expired: [], vanished: [], oomKilled: [] };
    const now = this.clock.now();

    for (const e of [...this.entries.values()]) {
      // Үнэнийг доод давхаргаас асууна — санах ойн бүртгэлээс биш.
      let state: Awaited<ReturnType<Machine["status"]>>;
      try {
        state = await e.machine.status();
      } catch {
        // Доод давхарга хариулахгүй бол ТААМАГЛАХГҮЙ — дараагийн
        // sweep-д дахин асууна.
        continue;
      }

      if (state.oomKilled) {
        this.counters.oomKilled++;
        res.oomKilled.push(e.id);
      }

      if (state.state === "gone") {
        this.entries.delete(e.id);
        this.counters.vanished++;
        res.vanished.push(e.id);
        await e.workspace.dispose().catch(() => {});
        continue;
      }

      if (state.state === "exited") {
        // Өөрөө дууссан. Бид чөлөөлөөгүй тул «expired» биш.
        this.entries.delete(e.id);
        this.counters.vanished++;
        res.vanished.push(e.id);
        await e.machine.destroy().catch(() => {});
        await e.workspace.dispose().catch(() => {});
        continue;
      }

      if (now >= e.expiresAt) {
        this.entries.delete(e.id);
        this.counters.expired++;
        res.expired.push(e.id);
        await e.machine.stop({ timeoutMs: 2000 }).catch(() => {});
        await e.machine.destroy().catch(() => {});
        await e.workspace.dispose().catch(() => {});
      }
    }
    return res;
  }

  // ─────────────────────────────────────────────────────────────────────
  // restart-аас сэргэх
  // ─────────────────────────────────────────────────────────────────────

  /**
   * Доод давхаргад амьд үлдсэн машинуудыг эргүүлж авна.
   *
   * ⚠️ Хугацаа нь ШИНЭ. Бид өмнөх expiresAt-ыг мэдэхгүй (controller-ийн
   *    санах ойд байсан), тиймээс сэргээсэн preview бүрд бүтэн TTL
   *    өгнө. Энэ нь «мэдэхгүй» зүйлийг таамаглахаас дээр.
   *
   * ⚠️ Машин бий ч workspace алга бол preview нь ТАХИР ДУТУУ: харагдаж
   *    байгаа ч файл шинэчлэх боломжгүй. Тэрийг устгана — хагас
   *    ажилладаг зүйл үлдээх нь хамгийн хүнд алдаа.
   */
  async reconcile(): Promise<ReconcileResult> {
    const res: ReconcileResult = { adopted: [], dropped: [] };
    const rows = await this.rt.list();

    for (const row of rows) {
      if (this.entries.has(row.id)) continue;

      const m = await this.rt.get(row.id);
      if (!m) continue;

      if (row.state !== "running" && row.state !== "starting") {
        await m.destroy().catch(() => {});
        res.dropped.push({ id: row.id, reason: "not-running" });
        continue;
      }

      const ws = row.workspaceId ? await this.rt.getWorkspace(row.workspaceId) : null;
      if (!ws) {
        await m.destroy().catch(() => {});
        this.counters.workspaceLost++;
        res.dropped.push({ id: row.id, reason: "workspace-lost" });
        continue;
      }

      const now = this.clock.now();
      this.entries.set(row.id, {
        id: row.id,
        workspaceId: ws.id,
        machine: m,
        workspace: ws,
        createdAt: now,
        expiresAt: now + this.o.ttlMs,
        adopted: true,
      });
      this.counters.adopted++;
      res.adopted.push(row.id);
    }
    return res;
  }

  // ─────────────────────────────────────────────────────────────────────
  // Үйлдлүүд
  // ─────────────────────────────────────────────────────────────────────

  async updateFiles(id: string, files: Record<string, string | Uint8Array>): Promise<WriteResult> {
    const e = this.entries.get(id);
    if (!e) throw previewNotFound(id);
    const st = await e.machine.status();
    if (st.state === "gone") {
      this.entries.delete(id);
      this.counters.vanished++;
      throw previewGone(id);
    }
    // Файлууд алга бол ЧИМЭЭГҮЙ «бичигдлээ» гэж хэлэхгүй.
    const live = await this.rt.getWorkspace(e.workspaceId);
    if (!live) {
      this.entries.delete(id);
      this.counters.workspaceLost++;
      throw workspaceLost(id);
    }
    return live.write(files);
  }

  async endpoint(id: string): Promise<{ host: string; port: number } | null> {
    const e = this.entries.get(id);
    if (!e) throw previewNotFound(id);
    return e.machine.endpoint();
  }

  async stop(id: string): Promise<void> {
    const e = this.entries.get(id);
    if (!e) throw previewNotFound(id);
    this.entries.delete(id);
    await e.machine.stop({ timeoutMs: 2000 }).catch(() => {});
    await e.machine.destroy().catch(() => {});
    await e.workspace.dispose().catch(() => {});
  }

  list(): PreviewInfo[] {
    return [...this.entries.values()].map((e) => this.toInfo(e));
  }

  get(id: string): PreviewInfo | null {
    const e = this.entries.get(id);
    return e ? this.toInfo(e) : null;
  }

  stats(): Stats {
    return {
      active: this.entries.size,
      max: this.o.maxPreviews,
      created: this.counters.created,
      rejected: this.counters.rejected,
      expired: this.counters.expired,
      vanished: this.counters.vanished,
      adopted: this.counters.adopted,
      workspaceLost: this.counters.workspaceLost,
      // ⚠️ Хэмжиж чадахгүй бол null. 0 гэж хэвлэвэл ХУДАЛ болно.
      oomKilled: this.rt.caps.memoryLimit ? this.counters.oomKilled : null,
    };
  }

  private toInfo(e: Entry): PreviewInfo {
    return {
      id: e.id,
      workspaceId: e.workspaceId,
      createdAt: e.createdAt,
      expiresAt: e.expiresAt,
      adopted: e.adopted,
    };
  }
}
