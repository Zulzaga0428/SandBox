// PreviewManager-ийн тест. Docker хэрэггүй, ЖИНХЭНЭ ХҮЛЭЭЛТ ХЭРЭГГҮЙ.
//
// Хугацааг `Clock`-оор хийсвэрлэсэн тул TTL-ийн логикийг секунд
// хүлээлгүйгээр хэмжинэ. `setTimeout`-оор хүлээдэг тест нь удаан бөгөөд
// машины ачааллаас хамаарч хэлбэлздэг — тэр нь дохио биш шуугиан.

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { FakeRuntime, makeWorld } from "../src/runtime/fake.ts";
import { PreviewManager } from "../src/manager/preview.ts";
import { PreviewError } from "../src/manager/errors.ts";
import type { Clock } from "../src/manager/preview.ts";

/** Гараар хөдөлгөдөг цаг. */
function fakeClock(start = 1_000_000): Clock & { advance(ms: number): void } {
  let t = start;
  return {
    now: () => t,
    advance(ms: number) {
      t += ms;
    },
  };
}

const TTL = 60_000;

function setup(opts: { max?: number } = {}) {
  const clock = fakeClock();
  const rt = new FakeRuntime({ world: makeWorld({ now: () => clock.now() }) });
  const mgr = new PreviewManager({
    runtime: rt,
    image: "test",
    workdir: "/app",
    port: 3000,
    memMb: 256,
    cpus: 1,
    maxPreviews: opts.max ?? 3,
    ttlMs: TTL,
    clock,
  });
  return { rt, mgr, clock };
}

describe("PreviewManager: үүсгэх ба багтаамж", () => {
  it("үүсгэсэн preview нь list ба stats-д харагдана", async () => {
    const { mgr } = setup();
    const p = await mgr.create({ "index.html": "<h1>сайн уу</h1>" });
    assert.equal(mgr.list().length, 1);
    assert.equal(mgr.get(p.id)?.id, p.id);
    const s = mgr.stats();
    assert.equal(s.active, 1);
    assert.equal(s.created, 1);
    assert.equal(s.rejected, 0);
  });

  it("endpoint нь ажиллаж байгаа preview-д гарна", async () => {
    const { mgr } = setup();
    const p = await mgr.create({ "a.txt": "а" });
    const ep = await mgr.endpoint(p.id);
    assert.ok(ep, "endpoint null байна");
    assert.equal(typeof ep!.port, "number");
  });

  it("багтаамж дүүрэхэд capacity-full + Retry-After", async () => {
    const { mgr } = setup({ max: 2 });
    await mgr.create({ "a": "1" });
    await mgr.create({ "b": "2" });
    await assert.rejects(
      () => mgr.create({ "c": "3" }),
      (e: unknown) => {
        assert.ok(e instanceof PreviewError);
        assert.equal((e as PreviewError).code, "capacity-full");
        assert.equal(typeof (e as PreviewError).retryAfterSec, "number");
        return true;
      },
    );
    assert.equal(mgr.stats().rejected, 1);
    assert.equal(mgr.stats().active, 2);
  });

  // ⚠️ SAND-ийн ЖИНХЭНЭ АЛДААНЫ ТЕСТ.
  // Слотыг `await`-аас өмнө нөөцлөхгүй бол зэрэг ирсэн хүсэлтүүд бүгд
  // «сул байна» гэж уншаад хязгаарыг давна.
  it("ЗЭРЭГЦЭЭ хүсэлтүүд хязгаарыг давахгүй", async () => {
    const { mgr } = setup({ max: 2 });
    const results = await Promise.allSettled(
      Array.from({ length: 8 }, (_, i) => mgr.create({ [`f${i}.txt`]: String(i) })),
    );
    const ok = results.filter((r) => r.status === "fulfilled").length;
    const no = results.filter((r) => r.status === "rejected").length;
    assert.equal(ok, 2, `хязгаар давсан: ${ok} preview үүссэн`);
    assert.equal(no, 6);
    assert.equal(mgr.stats().active, 2);
    assert.equal(mgr.stats().rejected, 6);
  });

  it("унасан create нь слотыг ЧӨЛӨӨЛНӨ", async () => {
    const { mgr } = setup({ max: 1 });
    // Зугтах зам → write нь rejected өгнө → create унана.
    await assert.rejects(() => mgr.create({ "../гадна.txt": "х" }));
    assert.equal(mgr.stats().active, 0);
    // Слот чөлөөлөгдсөн тул дараагийнх ажиллана.
    const p = await mgr.create({ "ok.txt": "за" });
    assert.ok(p.id);
  });

  it("унасан create нь үлдэгдэл хаяхгүй", async () => {
    const { rt, mgr } = setup();
    await assert.rejects(() => mgr.create({ "/абсолют": "х" }));
    assert.deepEqual(await rt.list(), [], "өнчин машин үлдсэн");
  });
});

describe("PreviewManager: TTL ба keepAlive", () => {
  it("хугацаа хэтрэхэд sweep чөлөөлнө", async () => {
    const { mgr, clock } = setup();
    const p = await mgr.create({ "a": "1" });

    clock.advance(TTL - 1);
    let r = await mgr.sweep();
    assert.deepEqual(r.expired, [], "хугацаа хүрээгүй байхад чөлөөлөв");
    assert.equal(mgr.stats().active, 1);

    clock.advance(2);
    r = await mgr.sweep();
    assert.deepEqual(r.expired, [p.id]);
    assert.equal(mgr.stats().active, 0);
    assert.equal(mgr.stats().expired, 1);
  });

  it("keepAlive нь хугацааг сунгана", async () => {
    const { mgr, clock } = setup();
    const p = await mgr.create({ "a": "1" });
    clock.advance(TTL - 10);
    const after = mgr.keepAlive(p.id);
    assert.equal(after.expiresAt, clock.now() + TTL);

    clock.advance(TTL - 10);
    const r = await mgr.sweep();
    assert.deepEqual(r.expired, [], "keepAlive-ийн дараа ч чөлөөлөгдөв");
    assert.equal(mgr.stats().active, 1);
  });

  it("байхгүй preview дээр keepAlive нь preview-not-found", () => {
    const { mgr } = setup();
    assert.throws(
      () => mgr.keepAlive("алга"),
      (e: unknown) => (e as PreviewError).code === "preview-not-found",
    );
  });

  it("stop нь слотыг чөлөөлнө", async () => {
    const { mgr } = setup({ max: 1 });
    const p = await mgr.create({ "a": "1" });
    await mgr.stop(p.id);
    assert.equal(mgr.stats().active, 0);
    await mgr.create({ "b": "2" });
    assert.equal(mgr.stats().active, 1);
  });
});

describe("PreviewManager: алга болох ба OOM", () => {
  // Эдгээр нь «харж чадахгүй зүйлийг 0 гэж бүү хэвлэ» дүрмийн тест.
  it("алга болсон нь vanished, expired БИШ", async () => {
    const { rt, mgr } = setup();
    const p = await mgr.create({ "a": "1" });
    rt.world.vanished.add(p.id);

    const r = await mgr.sweep();
    assert.deepEqual(r.vanished, [p.id]);
    assert.deepEqual(r.expired, [], "алга болсныг expired гэж тоолов");
    assert.equal(mgr.stats().vanished, 1);
    assert.equal(mgr.stats().expired, 0);
  });

  it("OOM-оор алагдсаныг sweep тоолно", async () => {
    const { rt, mgr } = setup();
    const p = await mgr.create({ "a": "1" });
    rt.world.oomed.add(p.id);

    const r = await mgr.sweep();
    assert.deepEqual(r.oomKilled, [p.id]);
    assert.equal(mgr.stats().oomKilled, 1);
  });

  it("memoryLimit=false үед stats.oomKilled нь null — 0 БИШ", async () => {
    const clock = fakeClock();
    const rt = new FakeRuntime({
      caps: { memoryLimit: false },
      world: makeWorld({ now: () => clock.now() }),
    });
    const mgr = new PreviewManager({
      runtime: rt,
      image: "t",
      workdir: "/app",
      port: 3000,
      memMb: 256,
      cpus: 1,
      maxPreviews: 2,
      ttlMs: TTL,
      clock,
    });
    const p = await mgr.create({ "a": "1" });
    rt.world.oomed.add(p.id);
    await mgr.sweep();

    const s = mgr.stats();
    assert.equal(s.oomKilled, null, "хэмжиж чадахгүй үед 0 гэж хэвлэв — SAND яг ингэж хуурсан");
    assert.notEqual(s.oomKilled, 0);
  });

  it("алга болсон preview дээр updateFiles нь preview-gone", async () => {
    const { rt, mgr } = setup();
    const p = await mgr.create({ "a": "1" });
    rt.world.vanished.add(p.id);
    await assert.rejects(
      () => mgr.updateFiles(p.id, { "b": "2" }),
      (e: unknown) => (e as PreviewError).code === "preview-gone",
    );
  });

  it("файлууд алга бол updateFiles нь workspace-lost — ЧИМЭЭГҮЙ 'бичигдлээ' гэхгүй", async () => {
    const { rt, mgr } = setup();
    const p = await mgr.create({ "a": "1" });
    const ws = await rt.getWorkspace(mgr.get(p.id)!.workspaceId);
    await ws!.dispose();
    await assert.rejects(
      () => mgr.updateFiles(p.id, { "b": "2" }),
      (e: unknown) => (e as PreviewError).code === "workspace-lost",
    );
    assert.equal(mgr.stats().workspaceLost, 1);
  });

  it("updateFiles нь бичилтийн татгалзлыг НЭРЛЭЖ буцаана", async () => {
    const { mgr } = setup();
    const p = await mgr.create({ "a": "1" });
    const r = await mgr.updateFiles(p.id, { "сайн.txt": "за", "../муу": "үгүй" });
    assert.deepEqual(r.written, ["сайн.txt"]);
    assert.equal(r.rejected.length, 1);
  });
});

describe("PreviewManager: restart-аас сэргэх", () => {
  /** Ижил runtime дээр ШИНЭ manager — controller дахин эхэлсэн дүр. */
  const restart = (rt: FakeRuntime, clock: Clock, max = 3) =>
    new PreviewManager({
      runtime: rt,
      image: "test",
      workdir: "/app",
      port: 3000,
      memMb: 256,
      cpus: 1,
      maxPreviews: max,
      ttlMs: TTL,
      clock,
    });

  it("амьд үлдсэн preview-ийг сэргээж, ФАЙЛУУД нь хүртэл сэргэнэ", async () => {
    const { rt, mgr, clock } = setup();
    const p = await mgr.create({ "src/App.tsx": "export default App" });

    const fresh = restart(rt, clock);
    assert.equal(fresh.list().length, 0, "шинэ manager хоосон байх ёстой");

    const r = await fresh.reconcile();
    assert.deepEqual(r.adopted, [p.id]);
    assert.equal(fresh.stats().active, 1);
    assert.equal(fresh.stats().adopted, 1);
    assert.equal(fresh.get(p.id)?.adopted, true);

    // Хамгийн чухал: файл шинэчлэх боломж сэргэсэн эсэх.
    const w = await fresh.updateFiles(p.id, { "src/App.tsx": "шинэчлэв" });
    assert.deepEqual(w.rejected, []);
  });

  it("сэргээсэн preview-д ШИНЭ TTL өгнө", async () => {
    const { rt, mgr, clock } = setup();
    await mgr.create({ "a": "1" });
    clock.advance(TTL - 5);

    const fresh = restart(rt, clock);
    await fresh.reconcile();
    // Шинэ лизинг тул дараа нь шууд хугацаа хэтрэхгүй.
    clock.advance(10);
    assert.deepEqual((await fresh.sweep()).expired, []);
  });

  it("файлууд алга бол сэргээхгүй, УСТГАНА (тахир дутуу preview үлдээхгүй)", async () => {
    const { rt, mgr, clock } = setup();
    const p = await mgr.create({ "a": "1" });
    const ws = await rt.getWorkspace(mgr.get(p.id)!.workspaceId);
    await ws!.dispose();

    const fresh = restart(rt, clock);
    const r = await fresh.reconcile();
    assert.deepEqual(r.adopted, []);
    assert.deepEqual(r.dropped, [{ id: p.id, reason: "workspace-lost" }]);
    assert.equal(fresh.stats().active, 0);
    assert.equal(fresh.stats().workspaceLost, 1);
    assert.deepEqual(await rt.list(), [], "өнчин машин үлдсэн");
  });

  it("reconcile нь аль хэдийн бүртгэгдсэнийг хоёр дахин нэмэхгүй", async () => {
    const { rt, mgr } = setup();
    await mgr.create({ "a": "1" });
    const r = await mgr.reconcile();
    assert.deepEqual(r.adopted, []);
    assert.equal(mgr.stats().active, 1);
  });

  it("сэргээсэн preview нь багтаамжид тооцогдоно", async () => {
    const { rt, mgr, clock } = setup({ max: 1 });
    await mgr.create({ "a": "1" });

    const fresh = restart(rt, clock, 1);
    await fresh.reconcile();
    await assert.rejects(
      () => fresh.create({ "b": "2" }),
      (e: unknown) => (e as PreviewError).code === "capacity-full",
    );
  });
});
