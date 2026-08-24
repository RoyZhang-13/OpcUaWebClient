import { API } from "./state.js";

// ─── Generic fetch wrapper ─────────────────────────────
export async function apiFetch(path, method = "GET", body = null) {
  try {
    const opts = {
      method,
      headers: body ? { "Content-Type": "application/json" } : {},
      body: body ? JSON.stringify(body) : undefined,
    };
    const res = await fetch(API + path, opts);
    return await res.json();
  } catch (e) {
    return { error: e.message };
  }
}
