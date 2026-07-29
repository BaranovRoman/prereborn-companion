import nextCoreWebVitals from "eslint-config-next/core-web-vitals";
import nextTypescript from "eslint-config-next/typescript";

const eslintConfig = [
    ...nextCoreWebVitals,
    ...nextTypescript,
    {
        files: [
            "src/components/pages/stream/overlay-editor/index.tsx",
            "src/entities/steam-integration/lib/use-steam-integration.ts",
        ],
        rules: {
            "react-hooks/refs": "off",
            "react-hooks/set-state-in-effect": "off",
        },
    },
    {
        ignores: [
            ".next/**",
            "node_modules/**",
            "graphify-out/**",
            "vitest.config.ts",
            "playwright.config.ts",
            "playwright.error-boundary.config.ts",
            "playwright-report/**",
            "test-results/**",
            "test-results-error-boundary/**",
            // Playwright e2e-тесты - отдельный раннер (@playwright/test),
            // не часть приложения; React/Next-специфичные правила
            // (no-explicit-any для CDP-сессий/window-кастов и т.д.) им не
            // подходят, как и app-коду не подходят test-only паттерны.
            "e2e/**",
            "e2e-error-boundary/**",
        ],
    },
    {
        // RouteTransitionProvider deliberately reads/mutates refs and calls
        // Date.now() during render (not in useEffect) for the initial-mount
        // and pathname-change token setup. This is required, not an
        // oversight: effects run child-before-parent, so a page deep in the
        // tree calling usePageReady().ready() in its own mount effect could
        // fire before this provider's effect created the token the ready()
        // call needs - the token would never close and the preloader/curtain
        // would hang forever. Confirmed via Playwright (browser QA pass) on
        // both initial load and client-side navigation to /cases and
        // /services before this fix. Render always runs parent-before-child,
        // so doing it synchronously here is the correct fix without a
        // broader transition-architecture rewrite. These specific rules
        // assume React Compiler semantics (not enabled in next.config.js -
        // see ESLint classification in the audit report); revisit if the
        // project adopts the compiler.
        files: ["src/shared/ui/route-transition/RouteTransitionProvider.tsx"],
        rules: {
            "react-hooks/refs": "off",
            "react-hooks/purity": "off",
        },
    },
    {
        // @floating-ui/react's canonical API passes refs into functions
        // called during render (refs.setFloating as a JSX ref callback,
        // arrow({element: arrowRef}) inside the middleware array) - both
        // read ref.current inside floating-ui's own positioning effect, not
        // synchronously during React's render phase, but react-hooks/refs
        // can't see that through the library boundary and flags the call
        // site instead. Same false-positive class as
        // RouteTransitionProvider.tsx above - these rules assume React
        // Compiler semantics, which this project doesn't enable.
        files: ["src/features/home/awards-popover/index.tsx"],
        rules: {
            "react-hooks/refs": "off",
        },
    },
    {
        // app/**/page.tsx here are async Server Components: the try/catch
        // wraps an `await` data fetch, and the catch branch either calls
        // notFound() or rethrows to the nearest error.tsx boundary - JSX is
        // only constructed after the await has already resolved. The
        // react-hooks/error-boundaries rule assumes client-rendering
        // semantics (JSX construction racing ahead of thrown errors) and
        // doesn't model this Server Component data-fetch-then-render shape,
        // so it false-positives here. See app/cases/[id]/page.tsx
        // for the pattern this protects.
        files: ["app/**/page.tsx"],
        rules: {
            "react-hooks/error-boundaries": "off",
        },
    },
];

export default eslintConfig;
