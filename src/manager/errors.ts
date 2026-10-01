// Алдааны гэрээ — бүгд НЭРТЭЙ, бүгд КОДТОЙ.
//
// Яагаад: HTTP давхарга алдааг статус код болгон хөрвүүлэх ёстой. Хэрэв
// алдаанууд зүгээр `Error` байвал тэр хөрвүүлэлт мөрийг тааруулах болж
// (`e.message.includes("дүүрсэн")`), нэг өдөр мессеж засахад чимээгүй
// унана. Код нь гэрээ, мессеж нь хүнд зориулсан.

export type PreviewErrorCode =
  | "capacity-full"       // багтаамж дүүрсэн → HTTP 503 + Retry-After
  | "preview-not-found"   // ийм preview байхгүй → 404
  | "preview-gone"        // байсан, доод давхаргаас алга болсон → 404
  | "workspace-lost"      // машин бий, файлууд алга → 500, сэргээх боломжгүй
  | "runtime-failed";     // доод давхарга унасан → 502

export class PreviewError extends Error {
  readonly code: PreviewErrorCode;
  /** 503-ийн хувьд хэдэн секундын дараа дахин үзэхийг зөвлөх. */
  readonly retryAfterSec: number | null;

  constructor(code: PreviewErrorCode, message: string, retryAfterSec: number | null = null) {
    super(message);
    this.name = "PreviewError";
    this.code = code;
    this.retryAfterSec = retryAfterSec;
  }
}

export const capacityFull = (limit: number, retryAfterSec: number): PreviewError =>
  new PreviewError(
    "capacity-full",
    `багтаамж дүүрсэн (хязгаар ${limit})`,
    retryAfterSec,
  );

export const previewNotFound = (id: string): PreviewError =>
  new PreviewError("preview-not-found", `preview байхгүй: ${id}`);

export const previewGone = (id: string): PreviewError =>
  new PreviewError("preview-gone", `preview алга болсон: ${id}`);

export const workspaceLost = (id: string): PreviewError =>
  new PreviewError("workspace-lost", `preview-ийн файлууд алга: ${id}`);
