# SandBox

AI-д зориулсан preview sandbox. Гаднын хүмүүс өөрийн кодоо ажиллуулж
болдог тусгаарлагдсан орчин.

> **Энэ төсөл [SAND](https://github.com/Zulzaga0428/SAND)-д ОГТ ХҮРЭХГҮЙ.**
> SAND бол ажиллаж байгаа прод систем. Энэ бол тусдаа, шинэ суурь.

Яагаад ийм байдлаар барьж байгааг **[docs/WHY.md](docs/WHY.md)**-д бичсэн.
Код засахаас өмнө уншина уу.

## Хурдан эхлэл

```bash
npm test          # 76 тест, хамаарал ТЭГ, Docker хэрэггүй
npm run typecheck # tsc --noEmit  (эхлээд: npm install)
```

Node ≥ 22.6 хэрэгтэй. TypeScript нь `--experimental-strip-types`-аар
шууд ажиллана — build алхам байхгүй, bundler байхгүй, ялзрах хэрэгсэл
байхгүй.

## Бүтэц

```
src/runtime/types.ts   Runtime интерфейс — төслийн ГЭРЭЭ
src/runtime/fake.ts    FakeRuntime — санах ойд, тестэд зориулсан
test/contract.ts       Хэрэгжүүлэлт БҮР дамжих ёстой гэрээний тестүүд
test/fake.test.ts      Гэрээ × 2 тохиргоо + мутацийн сорил
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
| 1 | `FakeRuntime` | санах ойд | ✅ бэлэн |
| 2 | `DockerRuntime` | Vultr, $0 | ⬜ |
| 3 | `FirecrackerRuntime` | bare metal | ⬜ |

Дараа нь runtime-аас хамаарахгүй хэсгүүд — дулаан сан, preview домэйн +
wildcard TLS, TTL/keepalive, хэмжигч, багтаамжийн хаалт.
