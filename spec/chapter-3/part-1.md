# Глава 3. РЕАЛИЗАЦИЯ НА СИСТЕМАТА

Тази глава описва детайлно програмната реализация на платформата Grape, следвайки архитектурните принципи, дефинирани в Глава 2. Реализацията обхваща три основни компонента: управление на кодовата база (Monorepo), Контролен панел (Web) и Изпълнителен панел (CLI).

## 3.1. Организация на кодовата база (Monorepo)

За да се осигури ефективно управление на зависимостите и споделяне на код между уеб интерфейса и CLI инструмента, проектът е структуриран като монохранилище (Monorepo), използвайки инструмента **Turborepo**.

### 3.1.1. Структура на проекта
Кодовата база е разделена на работни пространства (workspaces), дефинирани в `package.json` и `turbo.json`. Общата структура на директориите е следната:

```text
bb-thesis-2026/
├── apps/
│   ├── cli/
│   ├── docs/
│   └── web/
├── packages/
│   ├── eslint-config/
│   ├── templates/
│   ├── typescript-config/
│   └── ui/
├── spec/
│   ├── chapter-1/
│   ├── chapter-2/
│   ├── chapter-3/
│   ├── chapter-4/
│   └── conclusion/
├── terraform/
└── (root files: package.json, README.md, etc.)
```

Основните директории включват:

*   **apps/**: Съдържа основните приложения.
    *   `apps/web`: Уеб порталът, реализиран с Next.js.
    *   `apps/cli`: Инструментът за команден ред, реализиран с Go. Въпреки че Go използва `go.mod` за управление на зависимости, той е включен в структурата на директориите за унифицирано версииране и CI/CD процеси.
    *   `apps/docs`: Документацията на проекта.
*   **packages/**: Споделени библиотеки и конфигурации.
    *   `packages/ui`: Библиотека с React компоненти (на базата на Shadcn/UI), използвани в уеб приложението.
    *   `packages/templates`: Колекция от Terraform "Златни шаблони" (Golden Templates), описващи стандартни инфраструктурни конфигурации (VPC, EKS, RDS и др.).
    *   `packages/eslint-config`, `packages/typescript-config`: Споделени правила за линтиране и компилация, гарантиращи консистентен стил на кода.

Конфигурацията на `turbo.json` дефинира зависимостта между задачите (tasks) за изграждане (`build`), тестване (`test`) и стартиране в режим на разработка (`dev`). Това позволява паралелно изпълнение и кеширане на резултатите от компилацията.

```json
// turbo.json (съкратен)
{
  "$schema": "https://turbo.build/schema.json",
  "tasks": {
    "build": {
      "dependsOn": ["^build"],
      "outputs": [".next/**", "!.next/cache/**", "dist/**"]
    },
    "dev": {
      "cache": false,
      "persistent": true
    }
  }
}
```

## 3.2. Реализация на Контролния панел (Web Application)

Контролният панел е централният компонент за управление на конфигурациите. Той е реализиран чрез **Next.js** (версия 14+) с използване на **App Router** архитектурата, което позволява разделяне на логиката на сървърни (Server Components) и клиентски (Client Components) компоненти.

### 3.2.1. Архитектура на Next.js приложението
Приложението следва йерархична структура на маршрутите в директорията `app/`:

*   **Публични маршрути (`(public)/`):** Страници за вход (`/auth/signin`), потвърждение на имейл и начална страница. Те са достъпни за неавтентикирани потребители.
*   **Защитени маршрути (`(private)/`):** Таблото за управление (`/dashboard`), профилни настройки и форми за конфигурация. Достъпът до тях се контролира чрез `middleware.ts`.
*   **API маршрути (`api/`):** REST endpoints за взаимодействие с базата данни и външни услуги (напр. GitHub API).

Използването на Route Groups (директориите в скоби) позволява логическо разделение на лейаутите (layouts), без да се променя URL структурата.

### 3.2.2. Модул за автентикация (Auth Integration)
Автентикацията е реализирана чрез библиотека `@supabase/ssr`, която предоставя инструменти за работа със Supabase Auth в Next.js среда (сървърна и клиентска).

**Middleware за защита:**
Файлът `middleware.ts` прихваща всяка заявка и обновява сесията на потребителя. Това е критично за поддържане на валидни токени за достъп при използване на Server Components.

```typescript
// apps/web/lib/supabase/middleware.ts
export async function updateSession(request: NextRequest) {
    let supabaseResponse = NextResponse.next({ request });

    const supabase = createServerClient(
        process.env.NEXT_PUBLIC_SUPABASE_URL!,
        process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
        {
            cookies: {
                getAll() { return request.cookies.getAll(); },
                setAll(cookiesToSet) {
                    // Логика за обновяване на бисквитките в отговора
                    // ...
                },
            },
        }
    );
    // Важно: Извикването на getUser обновява Auth токена ако е изтекъл
    await supabase.auth.getUser();
    return supabaseResponse;
}
```

**Методи за вход:**
Поддържат се OAuth доставчици (GitHub, GitLab, Bitbucket, Google) и Magic Links (вход без парола чрез имейл). Логиката за вход е капсулирана в `apps/web/app/(public)/auth/signin/actions.ts`, използвайки Server Actions за сигурност.

### 3.2.3. Управление на конфигурации
Сърцевината на уеб приложението е формата за създаване на инфраструктурни конфигурации (`ConfigurationForm`).

**Валидация на данни (Zod):**
За гарантиране на интегритета на данните се използва библиотеката **Zod**. Схемите са дефинирани в `apps/web/lib/validations/database.schemas.ts` и описват типовете данни за всяко поле (напр. `aws_account_id` трябва да е низ, `db_min_capacity` число). Тези схеми се използват както за валидация на формата от страна на клиента (чрез `react-hook-form`), така и за типизиране на TypeScript интерфейсите.

**Генериране на конфигурация:**
При успешно попълване на формата, данните се изпращат към `api/configurations`. API маршрутът извършва запис в таблица `configurations` в Supabase.

```typescript
// apps/web/app/api/configurations/route.ts (съкратен)
export async function POST(request: Request) {
    const supabase = await createClient();
    const { data: { user } } = await supabase.auth.getUser();

    const body = await request.json();

    // Запис на новата конфигурация, свързана с текущия потребител
    const { data, error } = await supabase
        .from("configurations")
        .insert({
            user_id: user.id,
            ...body,
        })
        .select()
        .single();
    
    // ... обработка на грешки и връщане на отговор
}
```

### 3.2.4. API за CLI взаимодействие
За да позволи на CLI инструмента да комуникира с платформата, уеб приложението излага специализирани API endpoints.

*   **Device Flow (`api/auth/cli/`):** Реализира OAuth 2.0 Device Authorization Grant поток. CLI инструментът генерира код, който потребителят потвърждава в браузъра. Ендпойнтът `api/auth/cli/exchange` разменя потвърдения код за Access и Refresh токени, генерирани чрез библиотеката `jose`.
*   **Извличане на конфигурации:** Ендпойнтът `api/cli/configurations` позволява на CLI да изтегли списък с проектите на потребителя, използвайки Bearer Token за автентикация.

Тази архитектура осигурява сигурна и скалируема основа за управление на сложните инфраструктурни процеси.
