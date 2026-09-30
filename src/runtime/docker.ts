// DockerRuntime — Vultr дээр ӨНӨӨДӨР ажиллах хэрэгжүүлэлт. $0.
//
// ⚠️ dockerode-ийг импортолж болох ЦОРЫН ГАНЦ газруудын нэг.
//    test/no-leak.test.ts үүнийг хамгаална.
//
// Яагаад Firecracker-ээс ӨМНӨ энэ вэ:
//   Нэг хэрэгжүүлэлтээр батлагдсан интерфейс нь БАТЛАГДААГҮЙ. Docker бол
//   хоёр дахь нүд — хийсвэрлэл жинхэнэ эсэхийг ЭНЭ шалгана. Бас
//   Firecracker-ийн bare metal-ыг хүлээлгүйгээр ажиллах зүйл өгнө.
//
// ФАЙЛ ДАМЖУУЛАЛТЫН ШИЙДВЭР: bind mount, `putArchive` БИШ.
//
//   SAND нь ажиллаж буй контейнер руу putArchive хийдэг. Тэр нь gVisor дээр
//   ЧИМЭЭГҮЙ УНАДАГ бөгөөд SAND-ыг gVisor дээр ажиллуулах боломжгүй
//   болгосон гол шалтгаан байв. Bind mount дээр энэ асуудал ОГТ гардаггүй:
//   host дээрх хавтсанд бичихэд дотор шууд харагдана (2026-09-20-нд
//   хэмжсэн: runc 113ms, runsc 79ms).
//
//   Нэмэлт ашиг: Workspace нь контейнерээс ТУСДАА амьдарна — контейнер
//   унтарсан ч файлууд байрандаа. Интерфейсийн гэрээ яг үүнийг шаарддаг.
//
// ⚠️ Bind mount нь controller болон Docker daemon НЭГ файлын систем
//    хуваалцаж байхыг шаардана. Vultr дээр үнэн (нэг хост). Алсын
//    daemon дээр ажиллахгүй — тэр тохиолдолд өөр Workspace хэрэгжүүлэлт.

import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, posix, resolve, sep } from "node:path";
import { tmpdir } from "node:os";
import { Writable } from "node:stream";
import Docker from "dockerode";

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

export interface DockerRuntimeOptions {
  /** Workspace-үүдийн host дээрх үндэс. Docker daemon-д ХАРАГДАХ ёстой. */
  workspaceRoot?: string;
  /** Контейнеруудыг тэмдэглэх нэрийн орон зай. Өөр системүүдээс тусгаарлана. */
  namespace?: string;
  /** Бэлэн Docker холболт (тестэд). */
  docker?: Docker;
  /** Нэг workspace дэх файлын дээд тоо. */
  maxFiles?: number;
  /** Нэг файлын дээд хэмжээ (байт). */
  maxFileBytes?: number;
  /** Workspace-ийн нийт дээд хэмжээ (байт). */
  maxTotalBytes?: number;
}

const LABEL_MANAGED = "sandbox.managed";
const LABEL_NS = "sandbox.namespace";
const LABEL_WS = "sandbox.workspace";

/**
 * Docker-ийн олон сувгийн урсгалыг задлах.
 * Толгой нь 8 байт: [төрөл, 0,0,0, урт×4]. stdout=1, stderr=2.
 * dockerode-ийн demuxStream-ийг ашиглана — өөрсдөө задлах шаардлагагүй.
 */
function collect(
  docker: Docker,
  stream: NodeJS.ReadableStream,
  maxBytes: number,
): Promise<{ stdout: string; stderr: string; truncated: boolean }> {
  return new Promise((resolveP, rejectP) => {
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    let outLen = 0;
    let errLen = 0;
    let truncated = false;

    const sink = (bucket: Buffer[], isOut: boolean) =>
      new Writable({
        write(chunk: Buffer, _enc, cb) {
          const len = isOut ? outLen : errLen;
          const room = maxBytes - len;
          if (room <= 0) {
            truncated = true;
            return cb();
          }
          if (chunk.length > room) {
            bucket.push(chunk.subarray(0, room));
            truncated = true;
            if (isOut) outLen = maxBytes;
            else errLen = maxBytes;
            return cb();
          }
          bucket.push(chunk);
          if (isOut) outLen += chunk.length;
          else errLen += chunk.length;
          cb();
        },
      });

    docker.modem.demuxStream(stream, sink(out, true), sink(err, false));
    stream.on("end", () =>
      resolveP({
        stdout: Buffer.concat(out).toString("utf8"),
        stderr: Buffer.concat(err).toString("utf8"),
        truncated,
      }),
    );
    stream.on("error", rejectP);
  });
}

const isNotFound = (e: unknown): boolean =>
  typeof e === "object" && e !== null && (e as { statusCode?: number }).statusCode === 404;

// ───────────────────────────────────────────────────────────────────────
// Workspace — host дээрх хавтас
// ───────────────────────────────────────────────────────────────────────

class DockerWorkspace implements Workspace {
  readonly id: string;
  readonly hostPath: string;
  private disposed = false;
  private limits: Required<Pick<DockerRuntimeOptions, "maxFiles" | "maxFileBytes" | "maxTotalBytes">>;

  constructor(
    id: string,
    hostPath: string,
    limits: Required<Pick<DockerRuntimeOptions, "maxFiles" | "maxFileBytes" | "maxTotalBytes">>,
  ) {
    this.id = id;
    this.hostPath = hostPath;
    this.limits = limits;
  }

  /** Аюулгүй болгосон харьцангуй замыг host дээрх абсолют зам болгоно. */
  private toHost(rel: string): string {
    const full = resolve(this.hostPath, rel);
    // Хоёр дахь хамгаалалт: checkPath дамжсан ч үр дүн нь үндсэн хавтсын
    // ДОТОР байхыг шалгана. Нэг давхар хамгаалалт хангалтгүй.
    const root = resolve(this.hostPath) + sep;
    if (!full.startsWith(root)) throw new Error("зам зугтав: " + rel);
    return full;
  }

  private async walk(dir: string, prefix: string, out: string[]): Promise<void> {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const rel = prefix ? posix.join(prefix, e.name) : e.name;
      if (e.isDirectory()) await this.walk(join(dir, e.name), rel, out);
      else if (e.isFile()) out.push(rel);
    }
  }

  private async totalBytes(): Promise<number> {
    const files: string[] = [];
    await this.walk(this.hostPath, "", files);
    let n = 0;
    for (const f of files) {
      try {
        n += (await stat(this.toHost(f))).size;
      } catch {
        /* уншиж чадаагүй файлыг 0 гэж үзнэ */
      }
    }
    return n;
  }

  async write(input: Record<string, string | Uint8Array>): Promise<WriteResult> {
    const res: WriteResult = { written: [], rejected: [], bytes: 0 };
    if (this.disposed) {
      for (const p of Object.keys(input)) res.rejected.push({ path: p, reason: "disposed" });
      return res;
    }

    const existing: string[] = [];
    await this.walk(this.hostPath, "", existing);
    let count = existing.length;
    let total = await this.totalBytes();

    for (const [p, v] of Object.entries(input)) {
      const bad = checkPath(p);
      if (bad) {
        res.rejected.push({ path: p, reason: bad });
        continue;
      }
      const size = byteLen(v);
      if (size > this.limits.maxFileBytes) {
        res.rejected.push({ path: p, reason: "too-large" });
        continue;
      }

      let host: string;
      try {
        host = this.toHost(p);
      } catch {
        res.rejected.push({ path: p, reason: "path-escape" });
        continue;
      }

      let prev = 0;
      let isNew = true;
      try {
        prev = (await stat(host)).size;
        isNew = false;
      } catch {
        /* шинэ файл */
      }

      if (isNew && count >= this.limits.maxFiles) {
        res.rejected.push({ path: p, reason: "too-many" });
        continue;
      }
      if (total - prev + size > this.limits.maxTotalBytes) {
        res.rejected.push({ path: p, reason: "quota" });
        continue;
      }

      try {
        await mkdir(dirname(host), { recursive: true });
        await writeFile(host, typeof v === "string" ? Buffer.from(v, "utf8") : Buffer.from(v));
      } catch {
        res.rejected.push({ path: p, reason: "io" });
        continue;
      }

      if (isNew) count++;
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
      let host: string;
      try {
        host = this.toHost(p);
      } catch {
        res.rejected.push({ path: p, reason: "path-escape" });
        continue;
      }
      try {
        await stat(host);
      } catch {
        res.missing.push(p);
        continue;
      }
      try {
        await rm(host, { force: true });
        res.removed.push(p);
      } catch {
        res.rejected.push({ path: p, reason: "io" as RejectReason });
      }
    }
    return res;
  }

  async read(paths: string[]): Promise<Record<string, string | null>> {
    const out: Record<string, string | null> = {};
    for (const p of paths) {
      if (this.disposed || checkPath(p)) {
        out[p] = null;
        continue;
      }
      try {
        out[p] = await readFile(this.toHost(p), "utf8");
      } catch {
        out[p] = null;
      }
    }
    return out;
  }

  async list(): Promise<string[]> {
    if (this.disposed) return [];
    const out: string[] = [];
    await this.walk(this.hostPath, "", out);
    return out.sort();
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    await rm(this.hostPath, { recursive: true, force: true });
  }
}

// ───────────────────────────────────────────────────────────────────────
// Machine — контейнер
// ───────────────────────────────────────────────────────────────────────

class DockerMachine implements Machine {
  readonly id: string;
  private docker: Docker;
  private caps: Capabilities;
  private runtimeName: string;
  private guestPort: number;
  private startedAt: number | null = null;

  constructor(docker: Docker, caps: Capabilities, runtimeName: string, id: string, guestPort: number) {
    this.docker = docker;
    this.caps = caps;
    this.runtimeName = runtimeName;
    this.id = id;
    this.guestPort = guestPort;
  }

  private c() {
    return this.docker.getContainer(this.id);
  }

  async start(): Promise<void> {
    try {
      await this.c().start();
      this.startedAt = Date.now();
    } catch (e) {
      // 304 = аль хэдийн ажиллаж байна. Идемпотент байх ёстой.
      const code = (e as { statusCode?: number }).statusCode;
      if (code === 304) return;
      if (isNotFound(e)) return;
      throw e;
    }
  }

  /**
   * Төлөв. ХЭЗЭЭ Ч КЭШЛЭХГҮЙ — дуудах бүрд inspect хийнэ.
   * SAND-ийн oomKilled зөвхөн create-ийн үед тоологдож, ажиллаж байхад
   * алагдсан барилтууд хэдэн долоо хоног үл мэдэгдэв.
   */
  async status(): Promise<Status> {
    const checkedAt = Date.now();
    let info;
    try {
      info = await this.c().inspect();
    } catch (e) {
      if (isNotFound(e)) {
        // Docker үүнийг мэдэхгүй болсон. "exited" БИШ — яаж дууссаныг
        // мэдэхгүй тул exitCode нь null.
        return { state: "gone", exitCode: null, oomKilled: false, startedAt: this.startedAt, checkedAt };
      }
      throw e;
    }

    const s = info.State;
    const startedAt = s.StartedAt && s.StartedAt !== "0001-01-01T00:00:00Z"
      ? Date.parse(s.StartedAt)
      : this.startedAt;

    // OOMKilled-ийг ЯМАР Ч ҮЕД уншина — create-ийн үед биш.
    const oomKilled = this.caps.memoryLimit ? s.OOMKilled === true : false;

    let state: Status["state"];
    if (s.Running) state = "running";
    else if (s.Status === "created") state = "starting";
    else state = "exited";

    return {
      state,
      exitCode: state === "exited" ? (typeof s.ExitCode === "number" ? s.ExitCode : null) : null,
      oomKilled,
      startedAt: Number.isFinite(startedAt) ? (startedAt as number) : null,
      checkedAt,
    };
  }

  async endpoint(): Promise<Endpoint | null> {
    const st = await this.status();
    if (st.state !== "running") return null;
    let info;
    try {
      info = await this.c().inspect();
    } catch {
      return null;
    }
    const binding = info.NetworkSettings?.Ports?.[`${this.guestPort}/tcp`];
    const hostPort = binding?.[0]?.HostPort;
    if (!hostPort) return null;
    return { host: "127.0.0.1", port: Number(hostPort) };
  }

  async exec(argv: string[], opts: ExecOptions): Promise<ExecResult> {
    if (!this.caps.exec) throw new ExecUnsupportedError(this.runtimeName);
    const started = Date.now();

    const ex = await this.c().exec({
      Cmd: argv,
      AttachStdout: true,
      AttachStderr: true,
      Tty: false,
      ...(opts.cwd ? { WorkingDir: opts.cwd } : {}),
      ...(opts.env ? { Env: Object.entries(opts.env).map(([k, v]) => `${k}=${v}`) } : {}),
    });

    const stream = await ex.start({ hijack: true, stdin: false });

    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<"timeout">((resolveP) => {
      timer = setTimeout(() => resolveP("timeout"), opts.timeoutMs);
    });

    const done = collect(this.docker, stream as NodeJS.ReadableStream, opts.maxOutputBytes);
    const winner = await Promise.race([done, timeout]);
    if (timer) clearTimeout(timer);

    if (winner === "timeout") {
      // Урсгалыг таслана. Процесс контейнер дотор үлдэж магадгүй тул
      // exitCode нь МЭДЭГДЭХГҮЙ — null. 0 гэж хэвлэвэл худал болно.
      (stream as unknown as { destroy?: () => void }).destroy?.();
      return {
        stdout: "",
        stderr: "",
        exitCode: null,
        timedOut: true,
        truncated: false,
        durationMs: Date.now() - started,
      };
    }

    const { stdout, stderr, truncated } = winner;
    let exitCode: number | null = null;
    try {
      const info = await ex.inspect();
      exitCode = typeof info.ExitCode === "number" ? info.ExitCode : null;
    } catch {
      exitCode = null;
    }

    return {
      stdout,
      stderr: this.caps.logStreams === "merged" ? "" : stderr,
      exitCode,
      timedOut: false,
      truncated,
      durationMs: Date.now() - started,
    };
  }

  async logs(opts: LogOptions): Promise<LogResult> {
    let buf: Buffer;
    try {
      const raw = await this.c().logs({
        stdout: true,
        stderr: true,
        tail: opts.tail,
        follow: false,
        ...(opts.sinceMs ? { since: Math.floor((Date.now() - opts.sinceMs) / 1000) } : {}),
      });
      buf = Buffer.isBuffer(raw) ? raw : Buffer.from(raw as unknown as string, "binary");
    } catch (e) {
      if (isNotFound(e)) return { stdout: "", stderr: "", truncated: false };
      throw e;
    }

    // logs() нь олон сувгийн формат буцаана (Tty=false үед). Гараар задална:
    // Docker-ийн API энд урсгал биш буфер өгдөг тул demuxStream тохирохгүй.
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    let i = 0;
    while (i + 8 <= buf.length) {
      const type = buf[i];
      const len = buf.readUInt32BE(i + 4);
      const body = buf.subarray(i + 8, i + 8 + len);
      (type === 2 ? err : out).push(body);
      i += 8 + len;
    }

    return {
      stdout: Buffer.concat(out).toString("utf8"),
      stderr: this.caps.logStreams === "merged" ? "" : Buffer.concat(err).toString("utf8"),
      // tail-аар хязгаарласан тул илүү мөр байсан эсэхийг МЭДЭХГҮЙ.
      // Мэдэхгүй зүйлийг false гэж хэлэхгүй — tail дүүрсэн эсэхээр таамаглана.
      truncated: out.length + err.length >= opts.tail,
    };
  }

  async stop(opts: { timeoutMs: number }): Promise<void> {
    try {
      await this.c().stop({ t: Math.max(0, Math.ceil(opts.timeoutMs / 1000)) });
    } catch (e) {
      const code = (e as { statusCode?: number }).statusCode;
      // 304 = аль хэдийн зогссон, 404 = байхгүй. Хоёулаа идемпотент.
      if (code === 304 || isNotFound(e)) return;
      throw e;
    }
  }

  async destroy(): Promise<void> {
    try {
      await this.c().remove({ force: true });
    } catch (e) {
      if (isNotFound(e)) return;
      // 409 = аль хэдийн устгагдаж байна.
      if ((e as { statusCode?: number }).statusCode === 409) return;
      throw e;
    }
  }
}

// ───────────────────────────────────────────────────────────────────────
// Runtime
// ───────────────────────────────────────────────────────────────────────

export class DockerRuntime implements Runtime {
  readonly name = "docker";
  readonly caps: Capabilities = {
    // runc дээр inotify ажиллана (2026-09-20: 5 event, 110ms lag).
    // gVisor (runsc) дээр ажиллуулбал ЭНЭ УТГЫГ "poll" болгох ёстой —
    // тэнд inotify ТЭГ event өгдөг.
    fileWatch: "inotify",
    logStreams: "split",
    // Bind mount тул ажиллаж байхад бичсэн нь ШУУД харагдана.
    writeWhileRunning: true,
    memoryLimit: true,
    // StorageOpt нь зөвхөн тодорхой storage driver дээр ажиллана.
    // Батлаагүй тул false — "боломжгүй" гэхээс "мэдэхгүй" нь дээр.
    diskQuota: false,
    exec: true,
  };

  private docker: Docker;
  private root: string;
  private ns: string;
  private limits: Required<Pick<DockerRuntimeOptions, "maxFiles" | "maxFileBytes" | "maxTotalBytes">>;
  private guestPorts = new Map<string, number>();

  constructor(opts: DockerRuntimeOptions = {}) {
    this.docker = opts.docker ?? new Docker();
    this.root = opts.workspaceRoot ?? join(tmpdir(), "sandbox-ws");
    this.ns = opts.namespace ?? "default";
    this.limits = {
      maxFiles: opts.maxFiles ?? 500,
      maxFileBytes: opts.maxFileBytes ?? 2 * 1024 * 1024,
      maxTotalBytes: opts.maxTotalBytes ?? 32 * 1024 * 1024,
    };
  }

  async createWorkspace(): Promise<Workspace> {
    await mkdir(this.root, { recursive: true });
    const dir = await mkdtemp(join(this.root, "ws-"));
    return new DockerWorkspace(dir.slice(dir.lastIndexOf(sep) + 1), dir, this.limits);
  }

  async create(spec: MachineSpec): Promise<Machine> {
    const ws = spec.workspace as DockerWorkspace;
    if (!ws.hostPath) {
      throw new Error("DockerRuntime нь DockerWorkspace шаардана");
    }

    const container = await this.docker.createContainer({
      Image: spec.image,
      ...(spec.argv ? { Cmd: spec.argv } : {}),
      ...(spec.env ? { Env: Object.entries(spec.env).map(([k, v]) => `${k}=${v}`) } : {}),
      WorkingDir: spec.workdir,
      ExposedPorts: { [`${spec.port}/tcp`]: {} },
      Labels: {
        [LABEL_MANAGED]: "1",
        [LABEL_NS]: this.ns,
        [LABEL_WS]: ws.id,
      },
      HostConfig: {
        // Bind mount — putArchive БИШ. Файлын шийдвэрийн тайлбарыг
        // энэ файлын толгойгоос үзнэ үү.
        Binds: [`${ws.hostPath}:${spec.workdir}`],
        PortBindings: { [`${spec.port}/tcp`]: [{ HostPort: "0" }] },
        Memory: spec.memMb * 1024 * 1024,
        NanoCpus: Math.round(spec.cpus * 1e9),
        AutoRemove: false,
      },
    });

    this.guestPorts.set(container.id, spec.port);
    return new DockerMachine(this.docker, this.caps, this.name, container.id, spec.port);
  }

  /**
   * Энэ namespace-ийн БҮХ контейнер — Docker-оос шууд.
   * Санах ойд хадгалсан жагсаалт эх сурвалж БИШ. Controller дахин
   * эхлэхэд амьд үлдсэнийг олох цорын ганц зам.
   */
  async list(): Promise<MachineInfo[]> {
    const rows = await this.docker.listContainers({
      all: true,
      filters: { label: [`${LABEL_MANAGED}=1`, `${LABEL_NS}=${this.ns}`] },
    });
    return rows.map((r) => ({
      id: r.Id,
      state: r.State === "running" ? "running" : r.State === "created" ? "starting" : "exited",
      workspaceId: r.Labels?.[LABEL_WS] ?? null,
    }));
  }

  async get(id: string): Promise<Machine | null> {
    try {
      const info = await this.docker.getContainer(id).inspect();
      if (info.Config?.Labels?.[LABEL_MANAGED] !== "1") return null;
      if (info.Config?.Labels?.[LABEL_NS] !== this.ns) return null;
      // Порт нь санах ойд байхгүй байж болно (restart-ийн дараа) —
      // тохиргооноос сэргээнэ.
      const exposed = Object.keys(info.Config?.ExposedPorts ?? {})[0];
      const port = this.guestPorts.get(id) ?? (exposed ? Number(exposed.split("/")[0]) : 0);
      return new DockerMachine(this.docker, this.caps, this.name, info.Id, port);
    } catch (e) {
      if (isNotFound(e)) return null;
      throw e;
    }
  }
}
