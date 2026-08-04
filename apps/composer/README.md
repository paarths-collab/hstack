# Agent Recipes Composer

A dependency-free, browser-based Builder for the first Agent Recipes golden path: **Founder Brief**.

It is intentionally written for curious, nontechnical people:

- Every individual information source and delivery destination is optional.
- A user can always create a safe preview.
- A user needs at least one source and one delivery destination before download/copy handoff actions become available.
- Scheduling is unavailable until a delivery destination is selected.
- The interface explains access, verification, and rollback in plain language.
- It never asks for, saves, logs, or places credentials in generated browser downloads.

## Local use

This is a static ES module application. Serve the repository over any local static HTTP server, then open:

```text
/apps/composer/
```

Opening `index.html` directly with `file://` is not supported because modern browsers block ES module imports and JSON fetches from local files.

The Composer imports the product compiler from:

```text
../../packages/recipe-core/index.js
```

It fetches its public recipe registry relative to `app.js` from:

```text
../../recipes/registry.json
```

Until the registry is available, the app uses an embedded, vetted Founder Brief fallback. It includes the same safe metadata the compiler needs, so preview and safe handoff generation remain functional rather than merely decorative.

## Compiler contract

The app calls the following browser-safe API:

```js
getReadiness({ recipe, connectors, selection });
compileFounderBrief({ recipe, connectors, selection });
```

`selection` is always:

```js
{
  sourceIds: string[],
  deliveryIds: string[],
  cadence: "manual" | "weekdays" | "weekly",
  installation: "existing_agent" | "deploy_if_missing"
}
```

The compiler may return a safe preview without a `blueprint`. Export actions require a compiler result marked `deployable` and both a chosen source and a delivery destination.

## Safety boundary

The Composer is a planner, not a hosted runtime or secret manager. Credential entry, runtime installation, and approval happen later in the customer-owned environment. The technical details section is deliberately collapsed and only presents a scrubbed plan structure; it must never contain secret values.
