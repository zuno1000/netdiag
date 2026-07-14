/*
 * 追加機能: ①用途別の影響表示 ②回復ウォッチ ③回線切り替え比較
 *           ④履歴グラフ ⑤結果の共有カード
 * すべて端末内で完結（外部送信なし）。外部ライブラリ不使用
 */
"use strict";

const NetDiagFeatures = (() => {

  const SHORT = {
    healthy: "正常", slow: "遅い", weakOrCongested: "不安定", noSignal: "圏外",
    unreachable: "不通", captivePortal: "要認証", dnsSlow: "DNS遅延",
    deepSaturated: "回線飽和", deepThrottled: "速度制限?", deepAccessCongested: "回線混雑",
    deepRemoteSlow: "相手側", deepFarPath: "高遅延", deepUnclear: "原因不明",
  };

  // ---- ① 用途別の影響表示（数値を「使えるかどうか」に翻訳する） ----

  const MARKS = ["◯", "△", "✕"];

  function rateUsages(metrics, diagnosis) {
    const dead = ["noSignal", "unreachable", "captivePortal"].includes(diagnosis.key);
    const s = metrics.stability || {};
    const rtt = s.meanRttMs || metrics.httpMs || 0;
    const loss = (s.lossRate || 0) * 100;
    const jit = s.jitterMs || 0;
    const kbps = metrics.deep && metrics.deep.thrKbps != null ? metrics.deep.thrKbps : null;
    const lv = (good, mid) => (good ? 0 : mid ? 1 : 2);
    return [
      { icon: "💬", name: "メッセージ",
        level: dead ? 2 : lv(loss < 30 && rtt < 1500, loss < 60) },
      { icon: "🌐", name: "Web・地図",
        level: dead ? 2 : lv(rtt < 400 && loss < 15, rtt < 1500 && loss < 40) },
      { icon: "🎬", name: "動画",
        level: dead ? 2
          : kbps != null ? lv(kbps > 3000 && loss < 15, kbps > 700)
                         : lv(rtt < 300 && loss < 10, rtt < 800 && loss < 25) },
      { icon: "📞", name: "ビデオ通話",
        level: dead ? 2 : lv(rtt < 200 && jit < 30 && loss < 5,
                             rtt < 450 && jit < 80 && loss < 15) },
    ];
  }

  function renderUsage(container, metrics, diagnosis) {
    container.innerHTML = "";
    rateUsages(metrics, diagnosis).forEach((u) => {
      const cell = document.createElement("div");
      cell.className = "u-cell";
      const icon = document.createElement("div");
      icon.className = "u-icon";
      icon.textContent = u.icon;
      const name = document.createElement("div");
      name.className = "u-name";
      name.textContent = u.name;
      const mark = document.createElement("div");
      mark.className = "u-mark u" + u.level;
      mark.textContent = MARKS[u.level];
      cell.append(icon, name, mark);
      container.appendChild(cell);
    });
    container.hidden = false;
  }

  // ---- ② 回復ウォッチ（30秒ごとに軽く確認し、2回連続良好で回復と判断） ----

  function createWatcher(engine, { intervalMs = 30000, onCheck, onRecovered }) {
    let timer = null;
    let okStreak = 0;
    async function check() {
      const r = await engine.quickCheck();
      const good = r.ok && r.ms < 800;
      okStreak = good ? okStreak + 1 : 0;
      if (onCheck) onCheck(r, okStreak, good);
      if (okStreak >= 2) {
        stop();
        if (onRecovered) onRecovered();
      }
    }
    function start() {
      stop();
      okStreak = 0;
      check();
      timer = setInterval(check, intervalMs);
    }
    function stop() {
      if (timer) clearInterval(timer);
      timer = null;
    }
    return { start, stop, get active() { return timer != null; } };
  }

  // ---- ③ 回線切り替え比較 ----

  function scoreOf(out) {
    const m = out.metrics;
    if (!m.reachable) return 99999;
    const s = m.stability || {};
    return (s.meanRttMs || m.httpMs || 1000) + (s.lossRate || 0) * 100 * 20;
  }

  function fmtNum(v, unit) {
    return typeof v === "number" && isFinite(v) && v > 0 ? Math.round(v) + unit : "—";
  }

  function buildCompareTable(a, b) {
    const val = (out, f) => {
      const s = out.metrics.stability || {};
      if (f === "rtt") return fmtNum(s.meanRttMs || out.metrics.httpMs, "ms");
      if (f === "loss") return s.lossRate != null ? Math.round(s.lossRate * 100) + "%" : "—";
      if (f === "jit") return fmtNum(s.jitterMs, "ms");
      return SHORT[out.diagnosis.key] || "?";
    };
    const rows = [
      ["", "1回目", "2回目（今）"],
      ["判定", val(a, "key"), val(b, "key")],
      ["応答時間", val(a, "rtt"), val(b, "rtt")],
      ["損失", val(a, "loss"), val(b, "loss")],
      ["揺らぎ", val(a, "jit"), val(b, "jit")],
    ];
    const wrap = document.createElement("div");
    const tbl = document.createElement("table");
    rows.forEach((r, ri) => {
      const tr = document.createElement("tr");
      r.forEach((cell) => {
        const td = document.createElement(ri === 0 ? "th" : "td");
        td.textContent = cell;
        tr.appendChild(td);
      });
      tbl.appendChild(tr);
    });
    const v = document.createElement("p");
    v.className = "verdict";
    const sa = scoreOf(a), sb = scoreOf(b);
    v.textContent =
      sb < sa * 0.8 ? "2回目（今の回線）の方が快適そうです。このまま使うのが良さそうです" :
      sa < sb * 0.8 ? "1回目の回線の方が快適そうでした。元の回線に戻すのが良さそうです" :
      "2つの回線に大きな差はありませんでした";
    wrap.append(tbl, v);
    return wrap;
  }

  // ---- ④ 履歴グラフ（RTTの推移。点の色は診断結果） ----

  function drawHistory(canvas, records) {
    const dpr = window.devicePixelRatio || 1;
    const w = canvas.clientWidth || 480;
    const h = 180;
    canvas.width = w * dpr;
    canvas.height = h * dpr;
    const ctx = canvas.getContext("2d");
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, w, h);
    const axis = "#999";
    const pts = records
      .map((r) => ({ rtt: r.meanRttMs != null ? r.meanRttMs : r.httpMs, key: r.key }))
      .filter((p) => typeof p.rtt === "number" && isFinite(p.rtt) && p.rtt > 0)
      .slice(-40);
    if (!pts.length) {
      ctx.fillStyle = axis;
      ctx.font = "13px sans-serif";
      ctx.fillText("まだ記録がありません（診断すると増えていきます）", 12, h / 2);
      return;
    }
    const padL = 46, padR = 10, padT = 10, padB = 24;
    const maxV = Math.max(600, Math.min(3000, Math.max(...pts.map((p) => p.rtt)) * 1.15));
    const X = (i) => padL + (w - padL - padR) * (pts.length === 1 ? 0.5 : i / (pts.length - 1));
    const Y = (v) => padT + (h - padT - padB) * (1 - Math.min(v, maxV) / maxV);
    ctx.strokeStyle = "rgba(150,150,150,0.25)";
    ctx.fillStyle = axis;
    ctx.font = "10px sans-serif";
    for (let i = 0; i <= 3; i++) {
      const v = (maxV / 3) * i;
      const y = Y(v);
      ctx.beginPath(); ctx.moveTo(padL, y); ctx.lineTo(w - padR, y); ctx.stroke();
      ctx.fillText(Math.round(v) + "ms", 4, y + 3);
    }
    ctx.strokeStyle = "#378add";
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    pts.forEach((p, i) => { i ? ctx.lineTo(X(i), Y(p.rtt)) : ctx.moveTo(X(i), Y(p.rtt)); });
    ctx.stroke();
    const colorOf = (key) =>
      key === "healthy" ? "#1d9e75" :
      ["noSignal", "unreachable", "captivePortal"].includes(key) ? "#e24b4a" : "#ef9f27";
    pts.forEach((p, i) => {
      ctx.fillStyle = colorOf(p.key);
      ctx.beginPath();
      ctx.arc(X(i), Y(p.rtt), 3.5, 0, Math.PI * 2);
      ctx.fill();
    });
    ctx.fillStyle = axis;
    ctx.font = "10px sans-serif";
    ctx.fillText(`直近${pts.length}回の応答時間 ／ 緑=正常 橙=遅い・不安定 赤=不通`, padL, h - 6);
  }

  // ---- ⑤ 結果の共有カード（画像化してWeb Share / ダウンロード） ----

  function wrapText(ctx, text, x, y, maxW, lh) {
    let line = "";
    for (const ch of String(text)) {
      if (ctx.measureText(line + ch).width > maxW) {
        ctx.fillText(line, x, y);
        line = ch;
        y += lh;
      } else {
        line += ch;
      }
    }
    if (line) ctx.fillText(line, x, y);
    return y + lh;
  }

  async function shareCard({ diagnosis, metrics, tag }) {
    const c = document.createElement("canvas");
    c.width = 600;
    c.height = 420;
    const ctx = c.getContext("2d");
    ctx.fillStyle = "#f5f5f2";
    ctx.fillRect(0, 0, 600, 420);
    ctx.fillStyle = "#0f6e56";
    ctx.fillRect(0, 0, 600, 64);
    ctx.fillStyle = "#fff";
    ctx.font = "bold 24px sans-serif";
    ctx.fillText("通信診断", 24, 41);
    ctx.fillStyle = "#666";
    ctx.font = "14px sans-serif";
    ctx.fillText(new Date().toLocaleString("ja-JP") + (tag ? `（${tag}）` : ""), 24, 94);
    ctx.fillStyle = "#1a1a1a";
    ctx.font = "bold 24px sans-serif";
    let y = wrapText(ctx, diagnosis.message, 24, 134, 552, 32);
    ctx.fillStyle = "#555";
    ctx.font = "16px sans-serif";
    y = wrapText(ctx, diagnosis.suggestion, 24, y + 10, 552, 24);
    const s = metrics.stability || {};
    const parts = [];
    if (s.meanRttMs) parts.push("応答 " + Math.round(s.meanRttMs) + "ms");
    if (s.lossRate != null) parts.push("損失 " + Math.round(s.lossRate * 100) + "%");
    if (s.jitterMs != null) parts.push("揺らぎ " + Math.round(s.jitterMs) + "ms");
    if (metrics.deep && metrics.deep.thrKbps != null) {
      parts.push("実効 " + metrics.deep.thrKbps + "kbps");
    }
    if (parts.length) {
      ctx.fillStyle = "#333";
      ctx.font = "15px sans-serif";
      ctx.fillText(parts.join("　"), 24, Math.min(y + 18, 380));
    }
    ctx.fillStyle = "#999";
    ctx.font = "12px sans-serif";
    ctx.fillText(location.href.split("?")[0], 24, 404);

    const blob = await new Promise((res) => c.toBlob(res, "image/png"));
    if (!blob) return;
    const file = new File([blob], "tsushin-shindan.png", { type: "image/png" });
    if (navigator.canShare && navigator.canShare({ files: [file] })) {
      try {
        await navigator.share({ files: [file], title: "通信診断の結果" });
        return;
      } catch {
        return; // 共有キャンセル
      }
    }
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "tsushin-shindan.png";
    a.click();
    URL.revokeObjectURL(a.href);
  }

  return { rateUsages, renderUsage, createWatcher, buildCompareTable, drawHistory, shareCard };
})();
