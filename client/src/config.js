// In Railway single-service deployments the client and server share the same
// origin, so relative paths work for both fetch() calls and window.location
// navigation. VITE_API_URL can still override this for split-service setups
// or local dev where the server is on a different port.
export const API_URL = import.meta.env.VITE_API_URL ?? ''
