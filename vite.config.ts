import { defineConfig } from 'vite'

// The browser only talks to this origin; Vite proxies MCP and trace traffic to the loopback server.
const server = `http://127.0.0.1:${process.env.PORT ?? 8787}`
const port = Number(process.env.WEB_PORT ?? 5173)

export default defineConfig({
  root: 'web',
  server: { host: '127.0.0.1', port, strictPort: true, proxy: { '/mcp': server, '/api': server } },
  build: { outDir: '../dist/web', emptyOutDir: true },
})
