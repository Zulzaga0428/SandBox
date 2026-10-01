# SandBox

[![CI](https://github.com/Zulzaga0428/SandBox/actions/workflows/ci.yml/badge.svg)](https://github.com/Zulzaga0428/SandBox/actions/workflows/ci.yml)

AI-д зориулсан preview sandbox. Гаднын хүмүүс өөрийн кодоо ажиллуулж
болдог тусгаарлагдсан орчин.

> **Энэ төсөл [SAND](https://github.com/Zulzaga0428/SAND)-д ОГТ ХҮРЭХГҮЙ.**
> SAND бол ажиллаж байгаа прод систем. Энэ бол тусдаа, шинэ суурь.

Яагаад ийм байдлаар барьж байгааг **[docs/WHY.md](docs/WHY.md)**-д бичсэн.
Код засахаас өмнө уншина уу.

## Хурдан эхлэл

```bash
npm test          # 107 тест. Docker ХЭРЭГГҮЙ, интернэт хэрэггүй.
npm run test:docker  # гэрээг ЖИНХЭНЭ Docker дээр. Docker олдохгүй бол УНАНА.
npm run typecheck    # tsc --noEmit
```

`test:docker` нь `test`-д ордоггүй. Санаатай: Docker байхгүй машин дээр
чимээгүй алгасвал «алгасалт нь амжилт гэж уншигдах» болно.

Node ≥ 22.6 хэрэгтэй. TypeScript нь `--experimental-strip-types`-аар
шууд ажиллана — build алхам байхгүй, bundler байхгүй, ялзрах хэрэгсэл
байхгүй.

## Бүтэц

```
src/runtime/types.ts   Runtime интерфейс — төслийн ГЭРЭЭ
src/runtime/paths.ts   Замын шалгалт — хэрэгжүүлэлт БҮР ижлийг ашиглана
src/runtime/fake.ts    FakeRuntime — санах ойд, тестэд зориулсан
src/runtime/docker.ts  DockerRuntime — bind mount, putArchive БИШ

src/manager/errors.ts  Алдааны гэрээ — бүгд нэртэй, бүгд кодтой
src/manager/preview.ts PreviewManager — багтаамж, TTL, reconcile, хэмжигч
                       ⚠️ доод давхаргыг НЭРЭЭР Ч мэдэхгүй

test/contract.ts       Хэрэгжүүлэлт БҮР дамжих ёстой гэрээний тестүүд
test/fake.test.ts      Гэрээ × 2 тохиргоо + мутацийн сорил
test/preview.test.ts   PreviewManager — хиймэл цагаар, хүлээлтгүй
test/docker.test.ts    Гэрээ + PreviewManager ЖИНХЭНЭ Docker дээр
test/no-leak.test.ts   Механик хамгаалалт (доор үзнэ үү)
```

## Хоёр дүрэм

**1. `src/runtime/` -аас гадуур runtime гэж юу ч мэдэхгүй.**

SAND-ийг гацаасан зүйл: dockerode 40+ газар тархсан. Тиймээс энэ нь
сануулга биш, **тест**. `dockerode`, `firecracker`, `putArchive`,
`/dev/kvm` гэж дурдвал `npm test` улаан болно.

**2. Шинэ runtime нэмэх гэж байна уу? `test/contract.ts`-ийг дамжуул.**

```ts
runContractTests("миний-runtime", { make: () => new MyRuntime() });
```

Дамжихгүй бол интерфейс худлаа байсан гэсэн үг — хэрэгжүүлэлтийг биш,
гэрээг засна.

## Эрэмбэ

| # | Runtime | Хаана | Төлөв |
|---|---|---|---|
| 1 | `FakeRuntime` | санах ойд | ✅ 76/76 |
| 2 | `DockerRuntime` | Docker-той ямар ч Linux | ✅ **жинхэнэ Docker дээр 32/32** (CI) |
| 3 | `FirecrackerRuntime` | bare metal | ⬜ мөнгө орсны дараа |

DockerRuntime-д **сервер шаардлагагүй** — GitHub Actions-ийн үнэгүй
runner дээр гэрээ бүрэн гүйцэтгэгддэг. Vultr, SSH, $0.

## Runtime-аас хамаарахгүй давхарга

VMM солигдоход **амьд үлдэх** хэсэг. 10 жил наслах хөрөнгө нь энэ.

| | Төлөв |
|---|---|
| багтаамжийн хаалт (зэрэгцээ хүсэлтийн race-тай) | ✅ |
| TTL / keepalive / sweep | ✅ |
| restart-аас сэргэх (reconcile + getWorkspace) | ✅ |
| хэмжигч (хэмжээгүйг `null`, 0 БИШ) | ✅ |
| алдааны гэрээ (нэртэй код) | ✅ |
| дулаан сан | ⬜ |
| preview домэйн + wildcard TLS + чиглүүлэлт | ⬜ |
| HTTP API | ⬜ |
