// DockerRuntime-ийн гэрээний тест — ЖИНХЭНЭ Docker шаардана.
//
//   npm run test:docker
//
// ⚠️ Энэ нь `npm test`-д ОРДОГГҮЙ. Санаатай: Docker байхгүй машин дээр
//    чимээгүй алгасвал "алгасалт нь амжилт гэж уншигдах" болно.
//    Энэ файлыг ажиллуулах гэдэг нь "Docker байгаа, шалга" гэсэн үг —
//    Docker олдохгүй бол УНАНА, алгасахгүй.
//
// ⚠️ SAND-д ХҮРЭХГҮЙ. Бүх контейнер өөрийн namespace-ийн шошготой бөгөөд
//    эцэст нь өөрсдөө цэвэрлэгдэнэ. SAND-ийн контейнерууд өөр шошготой
//    тул list() тэднийг ХЭЗЭЭ Ч харахгүй.

import { after, before } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Docker from "dockerode";

import { DockerRuntime } from "../src/runtime/docker.ts";
import { runContractTests } from "./contract.ts";
import type { Machine, Runtime } from "../src/runtime/types.ts";

const IMAGE = process.env.SANDBOX_TEST_IMAGE ?? "busybox:latest";
const NS = "contract-" + Math.random().toString(36).slice(2, 8);

const docker = new Docker();
let root = "";

/** Образыг татах (байхгүй бол). */
async function ensureImage(): Promise<void> {
  const found = await docker.listImages({ filters: { reference: [IMAGE] } });
  if (found.length > 0) return;
  await new Promise<void>((res, rej) => {
    docker.pull(IMAGE, (err: unknown, stream: NodeJS.ReadableStream) => {
      if (err) return rej(err);
      docker.modem.followProgress(stream, (e: unknown) => (e ? rej(e) : res()));
    });
  });
}

before(async () => {
  // Docker олдохгүй бол ЭНД унана — чимээгүй алгасахгүй.
  try {
    await docker.ping();
  } catch (e) {
    throw new Error(
      "Docker-т холбогдож чадсангүй. Энэ тест жинхэнэ Docker шаардана.\n" +
        "  Локал Windows дээр Docker байхгүй бол Vultr сервер дээр ажиллуул.\n" +
        "  Учир шалтгаан: " + String(e),
    );
  }
  await ensureImage();
  root = await mkdtemp(join(tmpdir(), "sandbox-contract-"));
});

after(async () => {
  // Өөрсдийн үлдэгдлийг цэвэрлэнэ. ЗӨВХӨН өөрсдийн шошготойг.
  const rows = await docker.listContainers({
    all: true,
    filters: { label: ["sandbox.managed=1", `sandbox.namespace=${NS}`] },
  });
  for (const r of rows) {
    try {
      await docker.getContainer(r.Id).remove({ force: true });
    } catch {
      /* аль хэдийн устсан */
    }
  }
  if (root) await rm(root, { recursive: true, force: true });
});

const makeRuntime = (): Runtime =>
  new DockerRuntime({ workspaceRoot: root, namespace: NS, docker });

runContractTests("docker (жинхэнэ)", {
  make: makeRuntime,
  spec: {
    image: IMAGE,
    argv: ["sleep", "3600"],
    port: 3000,
    memMb: 64,
    cpus: 1,
    workdir: "/app",
  },
  // busybox дээр жинхэнэ командууд — хуурамч нэр БИШ.
  bigOutputCmd: ["sh", "-c", "yes 0123456789 | head -c 200000"],
  hangCmd: ["sleep", "30"],
  // Контейнерийг controller-ийн мэдэлгүйгээр устгана — "gone"-ыг үүсгэнэ.
  vanish: async (_rt: Runtime, m: Machine) => {
    await docker.getContainer(m.id).remove({ force: true });
  },
  // Санах ойн хязгаараар ЗААВАЛ алагдах машин. Нэрлэгдээгүй санах ойг
  // хоёр дахин ихэсгэсээр cgroup-ийн хязгаарт хүрнэ → цөмийн OOM killer
  // үндсэн процессыг алж State.OOMKilled тавигдана.
  //
  // ⚠️ /dev/shm рүү бичих аргыг ХЭРЭГЛЭХГҮЙ: Docker-ийн /dev/shm нь
  //    өгөгдмөлөөр 64MB тул санах ойн хязгаарт хүрэхээсээ өмнө
  //    "No space left on device" болж, OOM БИШ шалтгаанаар унана.
  oomMachine: async (rt: Runtime) => {
    const ws = await rt.createWorkspace();
    const m = await rt.create({
      workspace: ws,
      image: IMAGE,
      argv: ["sh", "-c", 'A=x; while :; do A="$A$A"; done'],
      port: 3000,
      memMb: 16,
      cpus: 1,
      workdir: "/app",
    });
    await m.start();
    return m;
  },
});
