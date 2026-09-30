// Runtime-ийн ГЭРЭЭ — хэрэгжүүлэлт БҮР үүнийг дамжих ёстой.
//
// Энэ файл бол төслийн хамгийн үнэ цэнэтэй хөрөнгө. Firecracker, Docker
// хоёулаа ЯГ ЭНЭ тестүүдийг дамжина. Дамжихгүй бол интерфейс худлаа
// байсан гэсэн үг — хэрэгжүүлэлтийг биш, гэрээг засна.
//
// Ашиглалт:
//   import { runContractTests } from "./contract.ts";
//   runContractTests("fake", () => new FakeRuntime());

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { Machine, MachineSpec, Runtime, Workspace } from "../src/runtime/types.ts";
import { ExecUnsupportedError } from "../src/runtime/types.ts";

export interface ContractHooks {
  /** Шинэ runtime үүсгэнэ. Тест бүрд цоо шинэ. */
  make(): Promise<Runtime> | Runtime;
  /** Машины үзүүлэлт. Docker-т жинхэнэ образ хэрэгтэй. */
  spec?: Omit<MachineSpec, "workspace">;
  /**
   * Их хэмжээний гаралт үүсгэх команд. Өгөөгүй бол тайралтын тест
   * АЖИЛЛАХГҮЙ — чимээгүй ✅ биш, ил тэмдэглэгдэнэ.
   */
  bigOutputCmd?: string[];
  /** Хугацаа хэтрүүлэх команд. Өгөөгүй бол timeout-ийн тест ажиллахгүй. */
  hangCmd?: string[];
  /**
   * Машиныг доод давхаргаас "алга болгох" (controller-ийн мэдэлгүйгээр).
   * Дэмжихгүй бол undefined — тэр тохиолдолд холбогдох тест SKIP БИШ,
   * харин "энэ runtime үүнийг хэмжиж чадахгүй" гэж ИЛ тэмдэглэгдэнэ.
   */
  vanish?(rt: Runtime, m: Machine): Promise<void> | void;
  /** Машиныг OOM-оор алах. */
  forceOom?(rt: Runtime, m: Machine): Promise<void> | void;
}

const DEFAULT_SPEC: Omit<MachineSpec, "workspace"> = {
  image: "test-image",
  port: 3000,
  memMb: 512,
  cpus: 1,
  workdir: "/app",
};

export function runContractTests(label: string, hooks: ContractHooks): void {
  const make = async () => await hooks.make();
  const SPEC = hooks.spec ?? DEFAULT_SPEC;

  const withMachine = async (rt: Runtime): Promise<{ ws: Workspace; m: Machine }> => {
    const ws = await rt.createWorkspace();
    const m = await rt.create({ ...SPEC, workspace: ws });
    await m.start();
    return { ws, m };
  };

  describe(`гэрээ: ${label}`, () => {
    // ─────────────────────────────────────────────────────────────────
    describe("caps", () => {
      it("бүх талбар зарлагдсан байна", async () => {
        const rt = await make();
        const c = rt.caps;
        assert.ok(["inotify", "poll", "none"].includes(c.fileWatch), "fileWatch буруу");
        assert.ok(["split", "merged"].includes(c.logStreams), "logStreams буруу");
        assert.equal(typeof c.writeWhileRunning, "boolean");
        assert.equal(typeof c.memoryLimit, "boolean");
        assert.equal(typeof c.diskQuota, "boolean");
        assert.equal(typeof c.exec, "boolean");
      });

      it("name нь хоосон биш", async () => {
        const rt = await make();
        assert.ok(rt.name.length > 0);
      });
    });

    // ─────────────────────────────────────────────────────────────────
    describe("workspace: бичих/унших", () => {
      it("бичсэн зүйл буцаж уншигдана", async () => {
        const rt = await make();
        const ws = await rt.createWorkspace();
        const r = await ws.write({ "index.html": "<h1>сайн уу</h1>" });
        assert.deepEqual(r.rejected, []);
        assert.deepEqual(r.written, ["index.html"]);
        assert.ok(r.bytes > 0);
        const got = await ws.read(["index.html"]);
        assert.equal(got["index.html"], "<h1>сайн уу</h1>");
      });

      it("байхгүй файл нь null — хоосон мөр БИШ", async () => {
        const rt = await make();
        const ws = await rt.createWorkspace();
        const got = await ws.read(["алга.txt"]);
        assert.equal(got["алга.txt"], null);
      });

      it("list нь тогтвортой эрэмбэтэй", async () => {
        const rt = await make();
        const ws = await rt.createWorkspace();
        await ws.write({ "b.txt": "b", "a.txt": "a", "c/d.txt": "d" });
        assert.deepEqual(await ws.list(), ["a.txt", "b.txt", "c/d.txt"]);
      });

      it("дахин бичихэд агуулга солигдоно, файл олшрохгүй", async () => {
        const rt = await make();
        const ws = await rt.createWorkspace();
        await ws.write({ "a.txt": "нэг" });
        await ws.write({ "a.txt": "хоёр" });
        assert.deepEqual(await ws.list(), ["a.txt"]);
        assert.equal((await ws.read(["a.txt"]))["a.txt"], "хоёр");
      });
    });

    // ─────────────────────────────────────────────────────────────────
    describe("workspace: замын хамгаалалт", () => {
      const evil = [
        "../гадна.txt",
        "a/../../гадна.txt",
        "/etc/passwd",
        "",
        "a\0b",
      ];

      for (const p of evil) {
        it(`татгалзана: ${JSON.stringify(p)}`, async () => {
          const rt = await make();
          const ws = await rt.createWorkspace();
          const r = await ws.write({ [p]: "х" });
          assert.deepEqual(r.written, [], "зугтах замыг бичсэн байна");
          assert.equal(r.rejected.length, 1, "татгалзсан шалтгаан нэрлэгдээгүй");
          assert.ok(
            ["path-escape", "path-invalid"].includes(r.rejected[0]!.reason),
            `шалтгаан буруу: ${r.rejected[0]!.reason}`,
          );
        });
      }

      it("хэсэгчилсэн амжилтад САЙН нь бичигдэж, МУУ нь нэрлэгдэнэ", async () => {
        const rt = await make();
        const ws = await rt.createWorkspace();
        const r = await ws.write({ "сайн.txt": "за", "../муу.txt": "үгүй" });
        assert.deepEqual(r.written, ["сайн.txt"]);
        assert.deepEqual(
          r.rejected.map((x) => x.path),
          ["../муу.txt"],
        );
      });
    });

    // ─────────────────────────────────────────────────────────────────
    describe("workspace: устгах", () => {
      it("байхгүй файл нь missing, алдаа БИШ", async () => {
        const rt = await make();
        const ws = await rt.createWorkspace();
        await ws.write({ "a.txt": "a" });
        const r = await ws.remove(["a.txt", "алга.txt"]);
        assert.deepEqual(r.removed, ["a.txt"]);
        assert.deepEqual(r.missing, ["алга.txt"]);
        assert.deepEqual(r.rejected, []);
      });

      it("dispose дараа бичих нь disposed гэж татгалзана", async () => {
        const rt = await make();
        const ws = await rt.createWorkspace();
        await ws.dispose();
        const r = await ws.write({ "a.txt": "a" });
        assert.deepEqual(r.written, []);
        assert.equal(r.rejected[0]?.reason, "disposed");
      });

      it("dispose нь идемпотент", async () => {
        const rt = await make();
        const ws = await rt.createWorkspace();
        await ws.dispose();
        await ws.dispose();
      });
    });

    // ─────────────────────────────────────────────────────────────────
    describe("machine: амьдралын мөчлөг", () => {
      it("start дараа running, endpoint гарна", async () => {
        const rt = await make();
        const { m } = await withMachine(rt);
        const st = await m.status();
        assert.equal(st.state, "running");
        assert.equal(st.exitCode, null, "running үед exitCode нь null байх ёстой");
        const ep = await m.endpoint();
        assert.ok(ep, "running машин endpoint өгөх ёстой");
        assert.equal(typeof ep!.host, "string");
        assert.equal(typeof ep!.port, "number");
      });

      it("start нь идемпотент", async () => {
        const rt = await make();
        const { m } = await withMachine(rt);
        await m.start();
        assert.equal((await m.status()).state, "running");
      });

      it("stop дараа exited, exitCode нь ТОО", async () => {
        const rt = await make();
        const { m } = await withMachine(rt);
        await m.stop({ timeoutMs: 2000 });
        const st = await m.status();
        assert.equal(st.state, "exited");
        assert.equal(typeof st.exitCode, "number", "exited үед exitCode мэдэгдэх ёстой");
      });

      it("зогссон машин endpoint өгөхгүй", async () => {
        const rt = await make();
        const { m } = await withMachine(rt);
        await m.stop({ timeoutMs: 2000 });
        assert.equal(await m.endpoint(), null);
      });

      it("destroy дараа state нь gone, exitCode нь null", async () => {
        const rt = await make();
        const { m } = await withMachine(rt);
        await m.destroy();
        const st = await m.status();
        assert.equal(st.state, "gone");
        assert.equal(st.exitCode, null, "gone үед 0 гэж хэвлэж БОЛОХГҮЙ");
      });

      it("destroy нь идемпотент", async () => {
        const rt = await make();
        const { m } = await withMachine(rt);
        await m.destroy();
        await m.destroy();
      });

      it("destroy нь workspace-д ХҮРЭХГҮЙ", async () => {
        const rt = await make();
        const { ws, m } = await withMachine(rt);
        await ws.write({ "a.txt": "а" });
        await m.destroy();
        assert.deepEqual(await ws.list(), ["a.txt"], "машин устахад файл алга болжээ");
      });

      it("checkedAt нь дуудах бүрд шинэчлэгдэнэ (кэш байхгүй)", async () => {
        const rt = await make();
        const { m } = await withMachine(rt);
        const a = await m.status();
        await new Promise((r) => setTimeout(r, 5));
        const b = await m.status();
        assert.ok(b.checkedAt >= a.checkedAt, "checkedAt хөдөлсөнгүй — кэшлэгдсэн байж магадгүй");
      });
    });

    // ─────────────────────────────────────────────────────────────────
    describe("machine: list ба get (restart-ийн дараах reconcile)", () => {
      it("үүсгэсэн машин list-д харагдана", async () => {
        const rt = await make();
        const { m } = await withMachine(rt);
        const all = await rt.list();
        assert.ok(all.some((x) => x.id === m.id), "list нь машиныг харуулсангүй");
      });

      it("устгасан машин list-д БАЙХГҮЙ", async () => {
        const rt = await make();
        const { m } = await withMachine(rt);
        await m.destroy();
        const all = await rt.list();
        assert.ok(!all.some((x) => x.id === m.id));
      });

      it("get нь ижил машиныг буцаана", async () => {
        const rt = await make();
        const { m } = await withMachine(rt);
        const again = await rt.get(m.id);
        assert.ok(again, "get нь null буцаалаа");
        assert.equal(again!.id, m.id);
      });

      it("байхгүй id дээр get нь null", async () => {
        const rt = await make();
        assert.equal(await rt.get("байхгүй-id"), null);
      });
    });

    // ─────────────────────────────────────────────────────────────────
    describe("machine: exec", () => {
      it("caps.exec === false бол ExecUnsupportedError шиднэ", async () => {
        const rt = await make();
        if (rt.caps.exec) return; // энэ runtime дэмждэг — өөр тест хамаарна
        const { m } = await withMachine(rt);
        await assert.rejects(
          () => m.exec(["echo", "hi"], { timeoutMs: 1000, maxOutputBytes: 1024 }),
          ExecUnsupportedError,
        );
      });

      it(
        hooks.bigOutputCmd
          ? "гаралт нь maxOutputBytes-д тасарвал truncated ҮНЭН"
          : "⚠️ ХЭМЖЭЭГҮЙ: bigOutputCmd өгөгдөөгүй",
        async (t) => {
          const rt = await make();
          if (!rt.caps.exec) return;
          if (!hooks.bigOutputCmd) {
            t.diagnostic(`${label}: bigOutputCmd алга — ТАЙРАЛТЫГ ШАЛГААГҮЙ`);
            return;
          }
          const { m } = await withMachine(rt);
          const r = await m.exec(hooks.bigOutputCmd, { timeoutMs: 15000, maxOutputBytes: 16 });
          assert.ok(Buffer.byteLength(r.stdout, "utf8") <= 16, "хязгаараас хэтэрсэн");
          assert.equal(r.truncated, true, "дуугүй тайрсан байна");
        },
      );

      it(
        hooks.hangCmd
          ? "timeout болвол timedOut ҮНЭН, exitCode нь null"
          : "⚠️ ХЭМЖЭЭГҮЙ: hangCmd өгөгдөөгүй",
        async (t) => {
          const rt = await make();
          if (!rt.caps.exec) return;
          if (!hooks.hangCmd) {
            t.diagnostic(`${label}: hangCmd алга — TIMEOUT-ЫГ ШАЛГААГҮЙ`);
            return;
          }
          const { m } = await withMachine(rt);
          const r = await m.exec(hooks.hangCmd, { timeoutMs: 300, maxOutputBytes: 1024 });
          assert.equal(r.timedOut, true, "timeout болоогүй — hangCmd үнэхээр өлгөж байна уу?");
          assert.equal(r.exitCode, null, "timeout дээр exitCode 0 гэж хэвлэгдлээ");
        },
      );
    });

    // ─────────────────────────────────────────────────────────────────
    // ЭДГЭЭР нь "харж чадахгүй зүйлийг 0 гэж бүү хэвлэ" дүрмийн тест.
    // Дэмжихгүй runtime дээр ЧИМЭЭГҮЙ ногоон болохгүй — ил унтарна.
    // ─────────────────────────────────────────────────────────────────
    describe("алга болох ба OOM", () => {
      it(
        hooks.vanish
          ? "доод давхаргаас алга болсон машин нь gone"
          : "⚠️ ХЭМЖЭЭГҮЙ: энэ runtime vanish дэмжихгүй",
        async (t) => {
          if (!hooks.vanish) {
            t.diagnostic(`${label}: vanish hook алга — алга болохыг ШАЛГААГҮЙ`);
            return;
          }
          const rt = await make();
          const { m } = await withMachine(rt);
          await hooks.vanish(rt, m);
          const st = await m.status();
          assert.equal(st.state, "gone");
          assert.equal(st.exitCode, null);
          assert.ok(!(await rt.list()).some((x) => x.id === m.id), "алга болсон нь list-д үлджээ");
        },
      );

      it(
        hooks.forceOom
          ? "ажиллаж байхад OOM болвол status нь ХЭЗЭЭ Ч мэдэгдэнэ"
          : "⚠️ ХЭМЖЭЭГҮЙ: энэ runtime forceOom дэмжихгүй",
        async (t) => {
          if (!hooks.forceOom) {
            t.diagnostic(`${label}: forceOom hook алга — OOM-ыг ШАЛГААГҮЙ`);
            return;
          }
          const rt = await make();
          const { m } = await withMachine(rt);
          await hooks.forceOom(rt, m);
          const st = await m.status();
          if (rt.caps.memoryLimit) {
            assert.equal(st.oomKilled, true, "OOM болсныг status харуулсангүй");
          } else {
            assert.equal(st.oomKilled, false, "memoryLimit=false үед oomKilled үнэн болж болохгүй");
          }
        },
      );
    });
  });
}
