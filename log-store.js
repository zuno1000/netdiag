/*
 * 研究用ログ収集
 * 診断結果と生の計測値を localStorage に保存し、CSVでエクスポートする。
 * 完全に端末内で完結（外部送信なし）。PWAなのでアプリを閉じても保持される。
 */
"use strict";

const NetDiagLog = (() => {

  const KEY = "netdiag-log";
  const MAX = 1000; // 上限を超えたら古い順に破棄

  const COLS = [
    "time", "key", "message", "detail", "tag",
    "online", "reachable", "portalSuspect",
    "httpStatus", "httpMs",
    "lossRate", "jitterMs", "meanRttMs",
    "dnsMs", "tcpMs", "tlsMs", "waitMs", "connReused",
    "thrKbps", "idleRttMs", "loadedRttMs", "targets",
  ];

  function round1(v) {
    return typeof v === "number" && isFinite(v) ? Math.round(v * 10) / 10 : null;
  }

  function all() {
    try {
      return JSON.parse(localStorage.getItem(KEY)) || [];
    } catch {
      return [];
    }
  }

  function save(list) {
    try {
      localStorage.setItem(KEY, JSON.stringify(list));
    } catch {
      /* 容量超過等。ログ保存の失敗でアプリを止めない */
    }
  }

  /** 診断1回分を記録する */
  function add(diagnosis, metrics = {}, tag = "") {
    const p = metrics.phases || {};
    const s = metrics.stability || {};
    const d = metrics.deep || {};
    const list = all();
    list.push({
      time: new Date().toISOString(),
      key: diagnosis.key,
      message: diagnosis.message,
      detail: diagnosis.detail || "",
      tag: tag || "",
      online: metrics.online ?? null,
      reachable: metrics.reachable ?? null,
      portalSuspect: metrics.portalSuspect ?? null,
      httpStatus: metrics.httpStatus ?? null,
      httpMs: round1(metrics.httpMs),
      lossRate: s.lossRate ?? null,
      jitterMs: round1(s.jitterMs),
      meanRttMs: round1(s.meanRttMs),
      dnsMs: round1(p.dnsMs),
      tcpMs: round1(p.tcpMs),
      tlsMs: round1(p.tlsMs),
      waitMs: round1(p.waitMs),
      connReused: p.reused ?? null,
      thrKbps: d.thrKbps ?? null,
      idleRttMs: round1(d.idleRttMs),
      loadedRttMs: round1(d.loadedRttMs),
      targets: d.targets
        ? d.targets.map((t) => t.name + ":" + (t.ms != null ? Math.round(t.ms) : "x")).join(" ")
        : null,
    });
    if (list.length > MAX) list.splice(0, list.length - MAX);
    save(list);
  }

  function count() {
    return all().length;
  }

  function clear() {
    try { localStorage.removeItem(KEY); } catch { /* noop */ }
  }

  function toCSV() {
    const esc = (v) => {
      if (v == null) return "";
      const s = String(v);
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const rows = all().map((r) => COLS.map((c) => esc(r[c])).join(","));
    return [COLS.join(",")].concat(rows).join("\n");
  }

  return { add, all, count, clear, toCSV };
})();
