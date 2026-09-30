// FakeRuntime — санах ойд бүрэн ажилладаг Runtime.
//
// ⚠️ ЭНЭ НЬ SAND-ИЙН FakeDocker БИШ.
//
// SAND-ийн controller/test/exec.test.js дотор Docker-ийн API-г дуурайсан
// хуурамч байдаг: putArchive, exec урсгалын 8 байтын multiplex толгой,
// demuxStream хүртэл. Техник нь зөв (жинхэнэ Docker хэрэггүйгээр 26 тест
// ажилладаг), гэхдээ ХЭЛБЭР нь буруу — тест нь өөрөө Docker-т уягдсан.
//
// FakeRuntime нь МАНАЙ интерфейсийг хэрэгжүүлнэ. Доор нь Docker гэж юу ч
// байхгүй.
//
// Хоёр дахь үүрэг: ДОХИО УЛААН БОЛЖ ЧАДДАГИЙГ БАТЛАХ. `world` дамжуулан
// OOM, timeout, алга болсон машин, бичилтийн уналт бүгдийг ЗОРИУД үүсгэж
// чадна. Хэрэв гажуудал оруулаад тест ногоон хэвээр байвал тест өөрөө
// эвдэрсэн гэсэн үг.

import type {
  Capabilities,
  Endpoint,
  ExecOptions,
  ExecResult,
  LogOptions,
  LogResult,
  Machine,
  MachineInfo,
  MachineSpec,
  RejectReason,
  RemoveResult,
  Runtime,
  Status,
  Workspace,
  WriteResult,
} from "./types.ts";
import { ExecUnsupportedError } from "./types.ts";
import { byteLen, checkPath } from "./paths.ts";

export const DEFAULT_CAPS: Capabilities = {
  fileWatch: "inotify",
  logStreams: "split",
  writeWhileRunning: true,
  memoryLimit: true,
  diskQuota: true,
  exec: true,
};

/** Runtime-ийн зан үйлийг тестээс удирдах хөшүүрэг. */
export interface FakeWorld {
  /** Файлын тооны хязгаар. */
  maxFiles: number;
  /** Нэг файлын хэмжээний хязгаар (байт). */
  maxFileBytes: number;
  /** Workspace-ийн нийт хэмжээ (байт). */
  maxTotalBytes: number;
  /** argv-ийн эхний утгаар хайх exec-ийн хариунууд. */
  execResults: Map<string, Partial<ExecResult>>;
  /** Энэ id-тай машинууд "gone" болсон дүр эсгэнэ (доод давхарга алга болсон). */
  vanished: Set<string>;
  /** Энэ id-тай машинууд OOM-оор алагдсан дүр эсгэнэ. */
  oomed: Set<string>;
  /** Машины лог. */
  logs: Map<string, string[]>;
  /** Одоогийн цаг — тестээс хөлдөөж болно. */
  now: () => number;
}

export function makeWorld(over: Partial<FakeWorld> = {}): FakeWorld {
  return {
    maxFiles: 500,
    maxFileBytes: 2 * 1024 * 1024,
    maxTotalBytes: 32 * 1024 * 1024,
    // Гэрээний тестийн "хайгуул" командууд. Жинхэнэ runtime дээр эдгээрийн
    // оронд жинхэнэ команд өгөгдөнө (Docker: sh -c "yes | head -c ...").
    execResults: new Map<string, Partial<ExecResult>>([
      ["huge", { stdout: "x".repeat(4096) }],
      ["hang", { timedOut: true }],
    ]),
    vanished: new Set(),
    oomed: new Set(),
    logs: new Map(),
    now: () => Date.now(),
    ...over,
  };
}

let seq = 0;
const nextId = (prefix: string) => prefix + "-" + (++seq).toString(36).padStart(4, "0");

// ───────────────────────────────────────────────────────────────────────
// Workspace
// ───────────────────────────────────────────────────────────────────────

class FakeWorkspace implements Workspace {
  readonly id: string;
  private files = new Map<string, Buffer>();
  private disposed = false;
  private world: FakeWorld;

  constructor(world: FakeWorld) {
    this.world = world;
    this.id = nextId("ws");
  }

  private totalBytes(): number {
    let n = 0;
    for (const b of this.files.values()) n += b.byteLength;
    return n;
  }

  async write(input: Record<string, string | Uint8Array>): Promise<WriteResult> {
    const res: WriteResult = { written: [], rejected: [], bytes: 0 };
    if (this.disposed) {
      for (const p of Object.keys(input)) res.rejected.push({ path: p, reason: "disposed" });
      return res;
    }
    let total = this.totalBytes();
    for (const [p, v] of Object.entries(input)) {
      const bad = checkPath(p);
      if (bad) {
        res.rejected.push({ path: p, reason: bad });
        continue;
      }
      const size = byteLen(v);
      if (size > this.world.maxFileBytes) {
        res.rejected.push({ path: p, reason: "too-large" });
        continue;
      }
      const isNew = !this.files.has(p);
      if (isNew && this.files.size >= this.world.maxFiles) {
        res.rejected.push({ path: p, reason: "too-many" });
        continue;
      }
      const prev = this.files.get(p)?.byteLength ?? 0;
      if (total - prev + size > this.world.maxTotalBytes) {
        res.rejected.push({ path: p, reason: "quota" });
        continue;
      }
      this.files.set(p, Buffer.from(typeof v === "string" ? Buffer.from(v, "utf8") : v));
      total = total - prev + size;
      res.written.push(p);
      res.bytes += size;
    }
    return res;
  }

  async remove(paths: string[]): Promise<RemoveResult> {
    const res: RemoveResult = { removed: [], missing: [], rejected: [] };
    if (this.disposed) {
      for (const p of paths) res.rejected.push({ path: p, reason: "disposed" });
      return res;
    }
    for (const p of paths) {
      const bad = checkPath(p);
      if (bad) {
        res.rejected.push({ path: p, reason: bad });
        continue;
      }
      if (this.files.delete(p)) res.removed.push(p);
      else res.missing.push(p);
    }
    return res;
  }

  async read(paths: string[]): Promise<Record<string, string | null>> {
    const out: Record<string, string | null> = {};
    for (const p of paths) {
      const b = this.disposed ? undefined : this.files.get(p);
      out[p] = b ? b.toString("utf8") : null;
    }
    return out;
  }

  async list(): Promise<string[]> {
    if (this.disposed) return [];
    return [...this.files.keys()].sort();
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    this.files.clear();
  }

  /** Зөвхөн FakeMachine-д зориулсан дотоод хандалт. */
  _snapshot(): Map<string, Buffer> {
    return this.files;
  }
  _isDisposed(): boolean {
    return this.disposed;
  }
}

// ───────────────────────────────────────────────────────────────────────
// Machine
// ───────────────────────────────────────────────────────────────────────

class FakeMachine implements Machine {
  readonly id: string;
  private state: Status["state"] = "starting";
  private exitCode: number | null = null;
  private startedAt: number | null = null;
  private destroyed = false;
  private world: FakeWorld;
  private caps: Capabilities;
  private runtimeName: string;
  readonly spec: MachineSpec;

  constructor(world: FakeWorld, caps: Capabilities, runtimeName: string, spec: MachineSpec) {
    this.world = world;
    this.caps = caps;
    this.runtimeName = runtimeName;
    this.spec = spec;
    this.id = nextId("m");
  }

  async start(): Promise<void> {
    if (this.destroyed) return;
    if (this.state === "running") return;
    this.state = "running";
    this.startedAt = this.world.now();
  }

  async status(): Promise<Status> {
    const checkedAt = this.world.now();
    // Доод давхаргаас АСУУНА — кэш байхгүй. Алга болсныг эндээс мэднэ.
    if (this.world.vanished.has(this.id)) {
      return { state: "gone", exitCode: null, oomKilled: false, startedAt: this.startedAt, checkedAt };
    }
    if (this.destroyed) {
      return { state: "gone", exitCode: null, oomKilled: false, startedAt: this.startedAt, checkedAt };
    }
    // OOM нь create-ийн үед биш, ЯМАР Ч ҮЕД илэрнэ.
    if (this.world.oomed.has(this.id)) {
      return {
        state: "exited",
        exitCode: 137,
        oomKilled: this.caps.memoryLimit,
        startedAt: this.startedAt,
        checkedAt,
      };
    }
    return {
      state: this.state,
      exitCode: this.state === "exited" ? this.exitCode : null,
      oomKilled: false,
      startedAt: this.startedAt,
      checkedAt,
    };
  }

  async endpoint(): Promise<Endpoint | null> {
    const st = await this.status();
    if (st.state !== "running") return null;
    return { host: "127.0.0.1", port: 30000 + (this.spec.port % 1000) };
  }

  async exec(argv: string[], opts: ExecOptions): Promise<ExecResult> {
    if (!this.caps.exec) throw new ExecUnsupportedError(this.runtimeName);
    const started = this.world.now();
    const key = argv.join(" ");
    const planned = this.world.execResults.get(key) ?? this.world.execResults.get(argv[0] ?? "");

    const timedOut = planned?.timedOut === true;
    let stdout = planned?.stdout ?? "";
    let stderr = planned?.stderr ?? "";

    let truncated = false;
    const cap = opts.maxOutputBytes;
    if (Buffer.byteLength(stdout, "utf8") > cap) {
      stdout = Buffer.from(stdout, "utf8").subarray(0, cap).toString("utf8");
      truncated = true;
    }
    if (Buffer.byteLength(stderr, "utf8") > cap) {
      stderr = Buffer.from(stderr, "utf8").subarray(0, cap).toString("utf8");
      truncated = true;
    }

    return {
      stdout,
      stderr: this.caps.logStreams === "merged" ? "" : stderr,
      // timedOut үед exitCode нь null — 0 БИШ.
      exitCode: timedOut ? null : (planned?.exitCode ?? 0),
      timedOut,
      truncated: truncated || planned?.truncated === true,
      durationMs: Math.max(0, this.world.now() - started),
    };
  }

  async logs(opts: LogOptions): Promise<LogResult> {
    const lines = this.world.logs.get(this.id) ?? [];
    const tail = lines.slice(-opts.tail);
    return {
      stdout: tail.join("\n"),
      stderr: "",
      truncated: lines.length > tail.length,
    };
  }

  async stop(_opts: { timeoutMs: number }): Promise<void> {
    if (this.destroyed) return;
    if (this.state === "running" || this.state === "starting") {
      this.state = "exited";
      this.exitCode = 0;
    }
  }

  async destroy(): Promise<void> {
    this.destroyed = true;
    this.world.logs.delete(this.id);
  }

  _destroyed(): boolean {
    return this.destroyed;
  }
}

// ───────────────────────────────────────────────────────────────────────
// Runtime
// ───────────────────────────────────────────────────────────────────────

export class FakeRuntime implements Runtime {
  readonly name = "fake";
  readonly caps: Capabilities;
  readonly world: FakeWorld;
  private machines = new Map<string, FakeMachine>();

  constructor(opts: { caps?: Partial<Capabilities>; world?: FakeWorld } = {}) {
    this.caps = { ...DEFAULT_CAPS, ...opts.caps };
    this.world = opts.world ?? makeWorld();
  }

  async createWorkspace(): Promise<Workspace> {
    return new FakeWorkspace(this.world);
  }

  async create(spec: MachineSpec): Promise<Machine> {
    const m = new FakeMachine(this.world, this.caps, this.name, spec);
    this.machines.set(m.id, m);
    return m;
  }

  async list(): Promise<MachineInfo[]> {
    const out: MachineInfo[] = [];
    for (const m of this.machines.values()) {
      if (m._destroyed()) continue;
      if (this.world.vanished.has(m.id)) continue;
      const st = await m.status();
      const ws = m.spec.workspace as { id?: string };
      out.push({ id: m.id, state: st.state, workspaceId: ws.id ?? null });
    }
    return out;
  }

  async get(id: string): Promise<Machine | null> {
    const m = this.machines.get(id);
    if (!m || m._destroyed() || this.world.vanished.has(id)) return null;
    return m;
  }
}
