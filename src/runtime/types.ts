// Runtime — sandbox-ын цорын ганц гадаад ертөнц.
//
// ЭНЭ ФАЙЛЫГ УНШИХААС ӨМНӨ: docs/WHY.md
//
// Энэ интерфейсээс гадуур кодын НЭГ Ч мөр docker, firecracker, KVM гэж
// мэдэхгүй. SAND-ийг алсан зүйл яг үүний эсрэг байсан: dockerode-ийн
// дуудлага 2185 мөрт 40+ газар тархаж, runtime нь солигддог давхарга биш
// бүтээгдэхүүний суурь болсон. Тэр алдааг давтахгүй.
//
// Хэрэгжүүлэлтүүд (эрэмбээр):
//   1. FakeRuntime        — санах ойд. Тест, $0.
//   2. DockerRuntime      — Vultr дээр өнөөдөр ажиллана. $0.
//   3. FirecrackerRuntime — bare metal. Мөнгө орсны дараа.
//
// Нэг хэрэгжүүлэлтээр батлагдсан интерфейс нь БАТЛАГДААГҮЙ. Docker нь
// хоёр дахь нүд болж хийсвэрлэл жинхэнэ эсэхийг шалгана.

// ───────────────────────────────────────────────────────────────────────
// Capabilities — runtime-уудын ЯЛГААГ өгөгдөл болгоно
// ───────────────────────────────────────────────────────────────────────
//
// gVisor дээр inotify тэг event өгдгийг бид ЧИМЭЭГҮЙ УНАЛТААР олсон.
// Дахиж тэгэхгүй: runtime бүр өөрийн хязгаарыг ЗАРЛАНА, дээд давхарга
// уншиж шийднэ, тест нь зарласантай нь тааруулж шалгана.

export interface Capabilities {
  /**
   * Файлын өөрчлөлтийг зочин дотор хэрхэн мэдэх вэ.
   *   "inotify" — fs.watch ажиллана (runc)
   *   "poll"    — зөвхөн fs.watchFile (gVisor: inotify 0 event, poll 280ms)
   *   "none"    — огт мэдэгдэхгүй, dev server гараар дахин ачаалах
   * Энэ утга dev server-ийн орчны хувьсагчийг шийднэ
   * (WATCHPACK_POLLING, CHOKIDAR_USEPOLLING).
   */
  fileWatch: "inotify" | "poll" | "none";

  /**
   * Лог урсгал салдаг эсэх.
   *   "split"  — stdout/stderr тусдаа (Docker)
   *   "merged" — консол нэг урсгал (Firecracker-ийн serial)
   * "merged" үед БҮГД stdout-д орж, stderr хоосон байна. Дуудагч тал
   * stderr хоосон байхыг "алдаа гараагүй" гэж уншиж БОЛОХГҮЙ.
   */
  logStreams: "split" | "merged";

  /**
   * Машин АЖИЛЛАЖ БАЙХАД workspace руу бичсэн нь зочинд харагдах эсэх.
   * false бол шинэ файл тусгахын тулд машиныг дахин эхлүүлэх ёстой.
   * Firecracker-т virtio-fs БАЙХГҮЙ (block/net/vsock/rng/balloon л бий)
   * тул энэ нь зочин доторх агентаар л биелнэ.
   */
  writeWhileRunning: boolean;

  /** Санах ойн хязгаар биелдэг эсэх. false бол oomKilled хэзээ ч үнэн болохгүй. */
  memoryLimit: boolean;

  /** Дискний квот биелдэг эсэх. */
  diskQuota: boolean;

  /** Машин доторх команд ажиллуулах боломжтой эсэх (npm install үүнээс хамаарна). */
  exec: boolean;
}

// ───────────────────────────────────────────────────────────────────────
// Workspace — ФАЙЛУУД. Машинаас ТУСДАА амьдрал.
// ───────────────────────────────────────────────────────────────────────
//
// Энэ бол хамгийн чухал шийдвэр. SAND-д "файл бичих" гэдэг нь "ажиллаж
// буй контейнер руу бичих" үйлдэл байсан. Тиймээс runtime солиход файл
// дамжуулалт бүхэлдээ нурдаг байв.
//
// Салгаснаар нэг гэрээ гурван өөр механизмыг далдална:
//   Fake        → санах ойн Map
//   Docker      → host дээрх хавтас (bind mount) эсвэл putArchive
//   Firecracker → ext4 образ (ачаалахын өмнө) эсвэл vsock агент (дараа)
//
// "tar", "archive", "putArchive" гэсэн үг энэ гарын үсэгт ОГТ БАЙХГҮЙ.

export interface Workspace {
  readonly id: string;

  /**
   * Файл бичих. Зам нь workspace-ийн үндсээс эхэлсэн харьцангуй зам
   * ("src/App.tsx"), "/" -ээр эхэлж БОЛОХГҮЙ, ".." агуулж БОЛОХГҮЙ.
   *
   * Хэсэгчилсэн амжилт БАЙЖ БОЛНО. Дуудагч тал rejected-ийг ЗААВАЛ
   * шалгана. Бүх файл бичигдсэн гэж ТААМАГЛАХ эрх байхгүй —
   * "алгасалт нь амжилт гэж уншигдах ЁСГҮЙ".
   */
  write(files: Record<string, string | Uint8Array>): Promise<WriteResult>;

  /** Файл устгах. Байхгүй файл нь алдаа БИШ, missing-д орно. */
  remove(paths: string[]): Promise<RemoveResult>;

  /** Файл унших. Байхгүй бол утга нь null — хоосон мөр БИШ. */
  read(paths: string[]): Promise<Record<string, string | null>>;

  /** Бүх файлын зам. Эрэмбэ нь тогтвортой (цагаан толгойн дараалал). */
  list(): Promise<string[]>;

  /** Устгах. Дахин дуудахад алдаа гаргахгүй (идемпотент). */
  dispose(): Promise<void>;
}

export interface WriteResult {
  written: string[];
  /** Яагаад бичигдээгүйг НЭРЛЭНЭ. Хоосон массив нь "бүгд амжилттай" гэсэн үг. */
  rejected: Array<{ path: string; reason: RejectReason }>;
  bytes: number;
}

export interface RemoveResult {
  removed: string[];
  /** Байхгүй байсан замууд. Алдаа биш, харин ДУУГҮЙ өнгөрөөж БОЛОХГҮЙ. */
  missing: string[];
  rejected: Array<{ path: string; reason: RejectReason }>;
}

export type RejectReason =
  | "path-escape"      // ".." эсвэл абсолют зам
  | "path-invalid"     // хоосон, NUL, хэт урт
  | "too-large"        // файлын хэмжээний хязгаар
  | "too-many"         // workspace дэх файлын тооны хязгаар
  | "quota"            // нийт хэмжээний хязгаар
  | "disposed"         // workspace устсан
  | "io";              // доод давхаргын алдаа

// ───────────────────────────────────────────────────────────────────────
// Machine — АЖИЛЛАЖ БУЙ зүйл
// ───────────────────────────────────────────────────────────────────────

export interface MachineSpec {
  workspace: Workspace;
  /** Юун дээр ажиллах вэ: Docker-т образ, Firecracker-т rootfs+kernel. */
  image: string;
  /** Ажиллуулах команд. Хоосон бол образын анхдагч. */
  argv?: string[];
  env?: Record<string, string>;
  /** Зочин доторх сонсох порт. Гаднах порт нь endpoint()-оос гарна. */
  port: number;
  memMb: number;
  cpus: number;
  /** Workspace зочны файлын системд хаана холбогдох вэ. */
  workdir: string;
}

export interface Machine {
  readonly id: string;

  /** Асаах. Дахин дуудахад алдаа гаргахгүй (идемпотент). */
  start(): Promise<void>;

  /**
   * Одоогийн төлөв. ЭНЭ НЬ ХЭЗЭЭ Ч КЭШЛЭГДЭХГҮЙ — дуудах бүрд доод
   * давхаргаас асууна. SAND-ийн oomKilled зөвхөн create-ийн үед
   * тоологдож, ажиллаж байхад алагдсан барилтууд хэдэн долоо хоног
   * үл мэдэгдсэн. Самбар "OOM 0" гэж байхад хэрэглэгчийн ажил үхэж байсан.
   */
  status(): Promise<Status>;

  /**
   * Хаана хандах вэ. Машин ажиллаагүй бол null.
   * "HostPort" БИШ — Firecracker-т TAP төхөөрөмж + зочны IP байна.
   */
  endpoint(): Promise<Endpoint | null>;

  /**
   * Команд ажиллуулах. npm install үүнээс хамаарна.
   * caps.exec === false бол ExecUnsupportedError шиднэ — ЧИМЭЭГҮЙ
   * хоосон үр дүн буцаахгүй.
   * Firecracker-т "docker exec" гэж байхгүй: vsock дээрх зочин доторх
   * агент шаардлагатай.
   */
  exec(argv: string[], opts: ExecOptions): Promise<ExecResult>;

  /** Лог унших. caps.logStreams === "merged" бол бүгд stdout-д. */
  logs(opts: LogOptions): Promise<LogResult>;

  /** Зогсоох. Дахин дуудахад алдаа гаргахгүй. */
  stop(opts: { timeoutMs: number }): Promise<void>;

  /** Устгах. Дахин дуудахад алдаа гаргахгүй. Workspace-д ХҮРЭХГҮЙ. */
  destroy(): Promise<void>;
}

export interface Status {
  /**
   * "starting" — үүссэн, гэхдээ бэлэн болоогүй
   * "running"  — ажиллаж байна
   * "exited"   — дууссан, exitCode МЭДЭГДЭЖ БАЙГАА
   * "gone"     — runtime үүнийг мэдэхгүй болсон
   *
   * "gone" ба "exited" хоёр ӨӨР. "gone" гэдэг нь "яаж дууссаныг
   * МЭДЭХГҮЙ" гэсэн үг — 0 гэж хэвлэж болох мэдээлэл БИШ.
   */
  state: "starting" | "running" | "exited" | "gone";

  /** state === "exited" үед л тоо. Бусад үед null — 0 БИШ. */
  exitCode: number | null;

  /**
   * Санах ойн хязгаараар алагдсан эсэх.
   * caps.memoryLimit === false бол энэ нь ҮРГЭЛЖ false байна —
   * "OOM болоогүй" гэсэн үг БИШ, "хэмжиж чадахгүй" гэсэн үг.
   * Дээд давхарга caps-ийг хамт уншина.
   */
  oomKilled: boolean;

  startedAt: number | null;
  /** Энэ хариуг ХЭЗЭЭ авсан бэ. Хуучин мэдээллийг шинэ гэж уншихаас сэргийлнэ. */
  checkedAt: number;
}

export interface Endpoint {
  host: string;
  port: number;
}

export interface ExecOptions {
  /** ЗААВАЛ. Өгөгдмөл утга БАЙХГҮЙ — мартах боломжгүй байх ёстой. */
  timeoutMs: number;
  /** ЗААВАЛ. Хязгааргүй гаралт нь controller-ийн санах ойг иддэг. */
  maxOutputBytes: number;
  cwd?: string;
  env?: Record<string, string>;
}

export interface ExecResult {
  stdout: string;
  stderr: string;
  /** timedOut эсвэл дуусаагүй бол null — 0 БИШ. */
  exitCode: number | null;
  timedOut: boolean;
  /** maxOutputBytes-д хүрч тасарсан эсэх. Дуугүй тайрахыг хориглоно. */
  truncated: boolean;
  durationMs: number;
}

export interface LogOptions {
  /** Сүүлийн хэдэн мөр. */
  tail: number;
  /** Хэдэн мс-ийн өмнөхөөс хойш. Өгөөгүй бол бүгд. */
  sinceMs?: number;
}

export interface LogResult {
  stdout: string;
  /** caps.logStreams === "merged" үед ҮРГЭЛЖ хоосон. Тайлбарыг caps-аас унш. */
  stderr: string;
  /** tail-д багтаагүй мөр байсан эсэх. */
  truncated: boolean;
}

// ───────────────────────────────────────────────────────────────────────
// Runtime
// ───────────────────────────────────────────────────────────────────────

export interface Runtime {
  readonly name: string;
  readonly caps: Capabilities;

  createWorkspace(): Promise<Workspace>;

  /**
   * id-гаар workspace эргүүлж авах. Байхгүй эсвэл устсан бол null.
   *
   * ⚠️ Controller дахин эхлэхэд preview-үүдийг СЭРГЭЭХЭД заавал хэрэгтэй.
   *    Машиныг `get()`-ээр олж чадсан ч түүний файлууд руу хүрэх зам
   *    байхгүй бол preview тахир дутуу сэргэнэ — файл шинэчлэх боломжгүй
   *    болно. SAND-д «restart-д preview үхэхгүй» чанар байсан; энэ
   *    интерфейс түүнгүйгээр тэр чанарыг биелүүлж чадахгүй байв.
   *
   * `MachineInfo.workspaceId` нь яг энэ функцэд дамжуулах id.
   */
  getWorkspace(id: string): Promise<Workspace | null>;
  create(spec: MachineSpec): Promise<Machine>;

  /**
   * Энэ runtime-д БАЙГАА бүх машин.
   *
   * Controller дахин эхлэхэд амьд үлдсэн машинуудыг олох цорын ганц
   * зам. SAND-д энэ байгаагүй бол restart бүрд preview-үүд өнчирдөг
   * байсан. Санах ойд хадгалсан жагсаалт нь эх сурвалж БИШ —
   * ҮНЭНИЙГ ҮРГЭЛЖ ДООД ДАВХАРГААС АСУУНА.
   */
  list(): Promise<MachineInfo[]>;

  /** id-гаар машин эргүүлж авах (restart-ийн дараа). Байхгүй бол null. */
  get(id: string): Promise<Machine | null>;
}

export interface MachineInfo {
  id: string;
  state: Status["state"];
  /** Аль workspace-д харьяалагдах. Мэдэгдэхгүй бол null. */
  workspaceId: string | null;
}

// ───────────────────────────────────────────────────────────────────────
// Алдаанууд — бүгд НЭРТЭЙ. "Ямар нэг юм болсон" гэж шидэхгүй.
// ───────────────────────────────────────────────────────────────────────

export class RuntimeError extends Error {
  readonly code: string;
  constructor(message: string, code: string) {
    super(message);
    this.name = "RuntimeError";
    this.code = code;
  }
}

export class ExecUnsupportedError extends RuntimeError {
  constructor(runtimeName: string) {
    super(runtimeName + " нь exec дэмжихгүй (caps.exec === false)", "exec-unsupported");
    this.name = "ExecUnsupportedError";
  }
}

export class MachineGoneError extends RuntimeError {
  constructor(id: string) {
    super("машин алга: " + id, "machine-gone");
    this.name = "MachineGoneError";
  }
}

export class WorkspaceDisposedError extends RuntimeError {
  constructor(id: string) {
    super("workspace устсан: " + id, "workspace-disposed");
    this.name = "WorkspaceDisposedError";
  }
}
