# eztunes frontend

React 19 + Vite, styled with Tailwind v4 and the shared ez design kit
(`src/ez/`): the ezllm/ezdyndns house style, Motion for transitions and a
three.js backdrop. Dark is the default theme; the choice is stored under
`ez.theme`.

```bash
bun install
bun dev            # :3000, proxies /api and the WebSocket to :5000
bun run build      # dist/, served by the backend in production
bun run lint
```

`preview.html` renders every screen state with fake data, without a
backend: open `http://localhost:3000/preview.html` while `bun dev` runs.

The footer shows `version` from this folder's `package.json`, injected at
build time as `__APP_VERSION__` (see `vite.config.js`).
