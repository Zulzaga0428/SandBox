// Замын шалгалт — хэрэгжүүлэлт БҮР ижил дүрэм ашиглана.
//
// Хэрэгжүүлэлт бүр өөрийн гэсэн шалгалт бичвэл нэг нь цоорхойтой байна.
// Гаднын хүний код ажиллуулж байгаа тул энэ нь аюулгүй байдлын хил.

import type { RejectReason } from "./types.ts";

/** Зөв бол null, буруу бол шалтгаан. */
export function checkPath(p: string): RejectReason | null {
  if (typeof p !== "string" || p.length === 0) return "path-invalid";
  if (p.length > 1024) return "path-invalid";
  if (p.includes("\0")) return "path-invalid";
  // Абсолют зам: POSIX ("/etc") ба Windows ("C:\") хоёуланг нь.
  if (p.startsWith("/") || /^[a-zA-Z]:/.test(p)) return "path-escape";
  // Backslash-ийг ОГТ зөвшөөрөхгүй: Windows дээр тусгаарлагч, Linux дээр
  // файлын нэрийн хэсэг болж хоёр талд өөр утгатай болно.
  if (p.includes("\\")) return "path-escape";
  const parts = p.split("/");
  if (parts.some((s) => s === "..")) return "path-escape";
  // Хоосон хэсэг = "a//b" эсвэл "a/". Мөн "." нь утгагүй.
  if (parts.some((s) => s === "" || s === ".")) return "path-invalid";
  return null;
}

export const byteLen = (v: string | Uint8Array): number =>
  typeof v === "string" ? Buffer.byteLength(v, "utf8") : v.byteLength;
