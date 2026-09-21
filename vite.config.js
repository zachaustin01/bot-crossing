import os from 'node:os'
import { defineConfig } from 'vite'
import { apiMiddleware, extraAllowedHosts } from './server/api.mjs'

/** Serves /api from inside the Vite dev server, so `npm run dev` is the whole game. */
const api = () => ({
  name: 'bot-crossing-api',
  configureServer(server) {
    server.middlewares.use(apiMiddleware)
  },
})

const extraHosts = extraAllowedHosts()

// The machine's own LAN IPs, so `http://<lan-ip>:5274` isn't blocked by Vite
// while the API in server/api.mjs already allows it.
const lanIPs = Object.values(os.networkInterfaces())
  .flat()
  .filter((a) => a && a.family === 'IPv4' && !a.internal && a.address)
  .map((a) => a.address)

export default defineConfig({
  plugins: [api()],
  // PORT lets a second copy run alongside the first without a flag on the command line.
  // BOT_CROSSING_ALLOWED_HOSTS adds DNS names (e.g. a .lan/.home host) alongside the
  // localhost default, for both Vite and the /api Host+Origin check in server/api.mjs.
  // When extra names are configured the dev server also listens on all interfaces —
  // otherwise a name resolving to the LAN IP can never connect.
  // BOT_CROSSING_HOST overrides, same as `npm run serve`.
  server: {
    host: process.env.BOT_CROSSING_HOST || (extraHosts.length ? '0.0.0.0' : '127.0.0.1'),
    port: Number(process.env.PORT) || 5274,
    strictPort: false,
    ...(extraHosts.length || lanIPs.length
      ? { allowedHosts: ['localhost', '127.0.0.1', '::1', ...lanIPs, ...extraHosts] }
      : {}),
  },
  build: { target: 'esnext' },
})
