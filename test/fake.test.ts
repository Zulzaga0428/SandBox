import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { FakeRuntime, makeWorld } from "../src/runtime/fake.ts";
import { runContractTests } from "./contract.ts";
import type { Machine, Runtime } from "../src/runtime/types.ts";

// ── 1. Бүрэн чадвартай fake — гэрээг бүхэлд нь дамжина ────────────────
runContractTests("fake (бүрэн)", {
  make: () => new FakeRuntime(),
  vanish: (rt, m) => {
    (rt as FakeRuntime).world.vanished.add(m.id);
  },
  forceOom: (rt, m) => {
    (rt as FakeRuntime).world.oomed.add(m.id);
  },
});

// ── 2. Хязгаарлагдмал fake — Firecracker-ийн хэлбэрийг дуурайна ───────
// exec байхгүй, лог нэгдсэн, ажиллаж байхад бичиж болохгүй, OOM хэмжихгүй.
// Гэрээ ЯГ ижил дамжих ёстой — энэ нь хийсвэрлэл жинхэнэ гэдгийн шалгуур.
runContractTests("fake (Firecracker маягийн хязгаартай)", {
  make: () =>
    new FakeRuntime({
      caps: {
        fileWatch: "poll",
        logStreams: "merged",
        writeWhileRunning: false,
        memoryLimit: false,
        diskQuota: false,
        exec: false,
      },
    }),
  vanish: (rt, m) => {
    (rt as FakeRuntime).world.vanished.add(m.id);
  },
  forceOom: (rt, m) => {
    (rt as FakeRuntime).world.oomed.add(m.id);
  },
});

// ── 3. Мутацийн сорил — ДОХИО УЛААН БОЛЖ ЧАДДАГИЙГ БАТЛАХ ────────────
//
// SAND дээр сурсан: "хяналт нь ч унасан бол тест өөрөө эвдэрсэн".
// Доорх тестүүд гажуудлыг ЗОРИУД үүсгээд, гэрээний шалгуур үнэхээр
// улаан болохыг батална. Эдгээр нь ногоон бол дээрх 2 багц утгагүй.

describe("мутацийн сорил: дохио улаан болж чадна", () => {
  const spec = { image: "i", port: 3000, memMb: 512, cpus: 1, workdir: "/app" };

  const boot = async (rt: Runtime): Promise<Machine> => {
    const ws = await rt.createWorkspace();
    const m = await rt.create({ ...spec, workspace: ws });
    await m.start();
    return m;
  };

  it("vanished машин нь ҮНЭХЭЭР gone болдог (өөрчлөхгүй бол running)", async () => {
    const rt = new FakeRuntime();
    const m = await boot(rt);
    assert.equal((await m.status()).state, "running", "суурь нөхцөл буруу");
    rt.world.vanished.add(m.id);
    assert.equal((await m.status()).state, "gone", "vanish дохио ажиллахгүй байна");
  });

  it("oomed машин нь ҮНЭХЭЭР oomKilled болдог", async () => {
    const rt = new FakeRuntime();
    const m = await boot(rt);
    assert.equal((await m.status()).oomKilled, false, "суурь нөхцөл буруу");
    rt.world.oomed.add(m.id);
    const st = await m.status();
    assert.equal(st.oomKilled, true);
    assert.equal(st.exitCode, 137);
  });

  it("memoryLimit=false үед OOM нь ЧИМЭЭГҮЙ false — тэр нь 'болоогүй' гэсэн үг БИШ", async () => {
    const rt = new FakeRuntime({ caps: { memoryLimit: false } });
    const m = await boot(rt);
    rt.world.oomed.add(m.id);
    const st = await m.status();
    assert.equal(st.state, "exited");
    assert.equal(st.exitCode, 137, "процесс үхсэн нь харагдах ёстой");
    assert.equal(st.oomKilled, false, "хэмжиж чадахгүй тул false");
    // Гол санаа: дээд давхарга caps.memoryLimit-ийг хамт уншихгүй бол
    // "OOM 0" гэж худал самбар гаргана. SAND яг ингэж хуурсан.
    assert.equal(rt.caps.memoryLimit, false);
  });

  it("файлын тооны хязгаар ҮНЭХЭЭР ажиллана", async () => {
    const rt = new FakeRuntime({ world: makeWorld({ maxFiles: 2 }) });
    const ws = await rt.createWorkspace();
    const r = await ws.write({ "a": "1", "b": "2", "c": "3" });
    assert.equal(r.written.length, 2);
    assert.equal(r.rejected.length, 1);
    assert.equal(r.rejected[0]!.reason, "too-many");
  });

  it("файлын хэмжээний хязгаар ҮНЭХЭЭР ажиллана", async () => {
    const rt = new FakeRuntime({ world: makeWorld({ maxFileBytes: 4 }) });
    const ws = await rt.createWorkspace();
    const r = await ws.write({ "том.txt": "12345" });
    assert.deepEqual(r.written, []);
    assert.equal(r.rejected[0]!.reason, "too-large");
  });

  it("нийт квот ҮНЭХЭЭР ажиллана", async () => {
    const rt = new FakeRuntime({ world: makeWorld({ maxTotalBytes: 6 }) });
    const ws = await rt.createWorkspace();
    const r = await ws.write({ "a": "1234", "b": "5678" });
    assert.equal(r.written.length, 1);
    assert.equal(r.rejected[0]!.reason, "quota");
  });

  it("exec-ийн timeout нь exitCode-ыг null болгодог (0 БИШ)", async () => {
    const world = makeWorld();
    world.execResults.set("hang", { timedOut: true, exitCode: 0 });
    const rt = new FakeRuntime({ world });
    const m = await boot(rt);
    const r = await m.exec(["hang"], { timeoutMs: 10, maxOutputBytes: 1024 });
    assert.equal(r.timedOut, true);
    assert.equal(r.exitCode, null, "timeout дээр 0 гэж хэвлэгдлээ");
  });

  it("exec-ийн гаралт ҮНЭХЭЭР тасарч, truncated үнэн болно", async () => {
    const world = makeWorld();
    world.execResults.set("huge", { stdout: "x".repeat(1000) });
    const rt = new FakeRuntime({ world });
    const m = await boot(rt);
    const r = await m.exec(["huge"], { timeoutMs: 1000, maxOutputBytes: 10 });
    assert.equal(r.stdout.length, 10);
    assert.equal(r.truncated, true);
  });

  it("logStreams=merged үед stderr ҮРГЭЛЖ хоосон", async () => {
    const world = makeWorld();
    world.execResults.set("noisy", { stdout: "гарц", stderr: "алдаа" });
    const rt = new FakeRuntime({ caps: { logStreams: "merged" }, world });
    const m = await boot(rt);
    const r = await m.exec(["noisy"], { timeoutMs: 1000, maxOutputBytes: 1024 });
    assert.equal(r.stderr, "", "merged үед stderr дүүрсэн байна");
    // Занга: дуудагч тал stderr хоосныг "алдаагүй" гэж уншиж БОЛОХГҮЙ.
    assert.equal(rt.caps.logStreams, "merged");
  });

  it("caps.exec=false үед exec нь ЧИМЭЭГҮЙ хоосон биш, шиднэ", async () => {
    const rt = new FakeRuntime({ caps: { exec: false } });
    const m = await boot(rt);
    await assert.rejects(() => m.exec(["ls"], { timeoutMs: 10, maxOutputBytes: 10 }));
  });
});
