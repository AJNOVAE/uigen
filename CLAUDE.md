# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
# First-time setup (install deps, generate Prisma client, run migrations)
npm run setup

# Development server (uses Turbopack)
npm run dev

# Build for production
npm run build

# Lint
npm run lint

# Run all tests
npm test

# Run a single test file
npx vitest run src/components/chat/__tests__/ChatInterface.test.tsx

# Reset the database
npm run db:reset
```

Tests use **Vitest** with `jsdom` environment. Test files live alongside source under `__tests__/` folders.

## Architecture Overview

UIGen is a Next.js 15 App Router application where users describe React components in a chat, Claude generates the code, and the result renders in a live preview — all without writing files to disk.

### The Virtual File System (VFS)

The core abstraction is `src/lib/file-system.ts` — a `VirtualFileSystem` class that stores files in memory as a `Map<string, FileNode>`. It is never written to disk during a session. Key points:

- The entire VFS is **serialized to JSON** and sent with every chat request (`fileSystem.serialize()`), then reconstructed server-side (`fileSystem.deserializeFromNodes()`).
- For authenticated users, the VFS is persisted in SQLite via Prisma as `Project.data` (a JSON string column).
- `FileSystemProvider` (`src/lib/contexts/file-system-context.tsx`) wraps the VFS in React state and exposes a `refreshTrigger` counter that the preview and editor subscribe to.

### AI Tool Loop

The API route (`src/app/api/chat/route.ts`) uses **Vercel AI SDK `streamText`** with two tools that operate on the server-side VFS instance:

- `str_replace_editor` — create files, string-replace within files, insert lines
- `file_manager` — rename and delete files

On the client, `ChatProvider` (`src/lib/contexts/chat-context.tsx`) uses `useChat` from `@ai-sdk/react`. Each `onToolCall` callback calls `handleToolCall` from `FileSystemProvider`, which mirrors the server-side VFS mutations to the client VFS, triggering a preview refresh.

### Preview Rendering

`PreviewFrame` (`src/components/preview/PreviewFrame.tsx`) renders an `<iframe srcdoc>` that:
1. Reads all files from the client VFS.
2. Calls `createImportMap` + `createPreviewHTML` from `src/lib/transform/jsx-transformer.ts`, which transpiles JSX/TSX via **Babel Standalone** in the browser.
3. Injects an ES module import map so inter-file imports resolve via blob URLs.

The preview looks for an entry point at `/App.jsx` → `/App.tsx` → `/index.jsx` → `/index.tsx` → `/src/App.jsx` → `/src/App.tsx` → first `.jsx`/`.tsx` file found.

### AI Prompt Rules

See `src/lib/prompts/generation.tsx`. Key constraints Claude follows when generating components:
- Every project must have a root `/App.jsx` as the entry point.
- Styling must use **Tailwind CSS**, not inline styles.
- Imports for local files must use the `@/` alias (e.g., `@/components/Button`).
- No HTML files — `App.jsx` is the only entrypoint.

### Authentication

JWT sessions stored in an `httpOnly` cookie (`auth-token`). Logic is in `src/lib/auth.ts` (server-only). Anonymous users can generate components; their work is tracked in `sessionStorage` via `src/lib/anon-work-tracker.ts`. Projects are only persisted to SQLite for authenticated users.

### Mock Provider

When `ANTHROPIC_API_KEY` is absent, `src/lib/provider.ts` returns a `MockLanguageModel` that generates static Counter/Card/Form components without calling the API. The real model used is `claude-haiku-4-5`.

### Data Model

```
User  { id, email, password }
  └── Project { id, name, userId?, messages: JSON[], data: JSON (VFS snapshot) }
```

Projects belong to users optionally — anonymous sessions have no `userId`.

### Node Compatibility Shim

`node-compat.cjs` is required via `NODE_OPTIONS` in all scripts. This patches Node.js globals needed by some dependencies before Next.js starts.
