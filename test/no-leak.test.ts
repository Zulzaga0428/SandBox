// МЕХАНИК ХАМГААЛАЛТ — runtime нэвчихээс сэргийлнэ.
//
// SAND-ийг гацаасан зүйл: dockerode-ийн дуудлага sandbox.js дотор 40+
// газар тархсан. Хэн ч санаатай хийгээгүй — өдөр бүр нэг мөрөөр нэмэгдсэн.
// Сануулга бичих нь тусалсангүй ("бичсэн сануулга нь ЗАСВАР БИШ").
//
// Тиймээс энэ нь тест. src/runtime/-аас ГАДУУР хэн нэгэн docker эсвэл
// firecracker гэж дурдвал энэ тест УЛААН болно.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(fileURLToPath(new URL(".", import.meta.url)), "..");

/** Зөвхөн эдгээр хавтас runtime-ийн нэрийг мэдэж болно. */
const ALLOWED = [
  join("src", "runtime"),
  "docs",
  "test", // тестүүд гэрээг тайлбарлахдаа нэрлэж болно
];

/** Хоригдсон тэмдэгтүүд. */
const BANNED = [
  /\bdockerode\b/i,
  /\bfirecracker\b/i,
  /\bputArchive\b/,
  /\bdemuxStream\b/i,
  /\bHostConfig\b/,
  /\bdocker\.sock\b/i,
  /\/dev\/kvm/i,
];

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === ".git" || name === "dist") continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (p.endsWith(".ts") || p.endsWith(".js")) out.push(p);
  }
  return out;
}

const isAllowed = (rel: string) =>
  ALLOWED.some((a) => rel === a || rel.startsWith(a + sep) || rel.startsWith(a + "/"));

describe("механик хамгаалалт", () => {
  it("runtime-ийн нэр src/runtime/-аас гадуур нэвчээгүй", () => {
    const leaks: string[] = [];
    for (const file of walk(ROOT)) {
      const rel = relative(ROOT, file);
      if (isAllowed(rel)) continue;
      const text = readFileSync(file, "utf8");
      for (const pat of BANNED) {
        const m = text.match(pat);
        if (m) leaks.push(`${rel}: ${m[0]}`);
      }
    }
    assert.deepEqual(
      leaks,
      [],
      "runtime нэвчсэн байна — эдгээрийг src/runtime/ доор нуу:\n  " + leaks.join("\n  "),
    );
  });

  it("хамгаалалт өөрөө ажилладгийг батална (мутацийн сорил)", () => {
    // Хориотой тэмдэгт агуулсан хуурамч файлын агуулга — хэв шинжүүд
    // ҮНЭХЭЭР таардаг эсэхийг шалгана. Энэ нь унавал дээрх тест нь
    // хэзээ ч улаан болохгүй гэсэн үг.
    const sample = "const d = require('dockerode'); c.putArchive(x); /dev/kvm";
    const hits = BANNED.filter((p) => p.test(sample));
    assert.ok(hits.length >= 3, `хэв шинж таарахгүй байна: ${hits.length}`);
  });
});
