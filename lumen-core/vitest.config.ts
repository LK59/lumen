import { defineConfig } from "vitest/config";
import path from "node:path";

// Les réglages de la suite de Laterna d'où ces tests viennent, pour qu'ils disent ici ce qu'ils
// disaient là-bas : `node` par défaut (jsdom se demande fichier par fichier), l'historique des doubles
// gardé entre les tests (`clearMocks: false`, l'ancien défaut de Vitest sous lequel ils ont été
// écrits), des fils isolés. Le fuseau aussi, posé avant le premier fil.
process.env.TZ = "Europe/Paris";

export default defineConfig({
  test: {
    environment: "node",
    testTimeout: 20_000,
    hookTimeout: 30_000,
    pool: "threads",
    globals: true,
    clearMocks: false,
    include: ["tests/**/*.test.{ts,tsx}", "benches/**/*.spec.ts"],
  },
  resolve: {
    // Les bancs d'identité se lancent aussi sur le moteur d'origine, pour comparer les deux sorties :
    // LUMEN_REF désigne alors la racine d'une copie de Laterna, montée en lecture seule, dont le
    // moteur (`src/lib/webcodecs`) prend la place du nôtre et dont `@/` retrouve les modules qu'il
    // importe encore (voir benches/README.md). Sans elle, `@lumen` est `src/`.
    alias: process.env.LUMEN_REF
      ? [
          { find: "@lumen/engine", replacement: path.join(process.env.LUMEN_REF, "src/lib/webcodecs") },
          { find: /^@\//, replacement: path.join(process.env.LUMEN_REF, "src") + "/" },
        ]
      : [{ find: "@lumen", replacement: path.resolve(__dirname, "./src") }],
  },
});
