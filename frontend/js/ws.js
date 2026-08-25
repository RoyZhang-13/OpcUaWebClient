import { state } from "./state.js";
import { updateTableRow } from "./monitor.js";

// ─── WebSocket (live data-change push) ─────────────────
export function initWS() {
  if (state.ws) state.ws.close();
  const proto = location.protocol === "https:" ? "wss" : "ws";
  state.ws = new WebSocket(`${proto}://${location.host}/ws`);
  state.ws.onmessage = (evt) => {
    try {
      const msg = JSON.parse(evt.data);
      if (msg.type === "datachange") {
        const m = state.monitored.get(msg.seq);
        if (m) {
          m.value = msg.value;
          m.value_raw = msg.value_raw ?? null;
          if (msg.data_type != null) m.data_type = msg.data_type;
          if (msg.source_timestamp != null) m.source_ts = msg.source_timestamp;
          if (msg.server_timestamp != null) m.server_ts = msg.server_timestamp;
          if (msg.status_code != null) m.status_code = msg.status_code;
          updateTableRow(msg.seq);
        }
      }
    } catch {
      // Ignore malformed payloads.
    }
  };
  state.ws.onclose = () => {
    setTimeout(initWS, 3000);
  };
}
