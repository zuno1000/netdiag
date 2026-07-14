/*
 * 通信診断プローブエンジン（PWA版）— Swift版 ProbeEngine.swift の移植
 *
 * 設計方針（Swift版と同じ）:
 *  - 完全クライアントサイド。静的ホスティングのみで動作し、維持費ゼロ
 *  - 各プローブは短いタイムアウト付き。失敗も「計測結果」として扱う
 *  - オフライン時は一切通信を試みない
 *
 * 二段構え:
 *  - run():     通常診断（数KB・約5秒）
 *  - deepRun(): 詳細診断（最大約2MB・約10秒）。「遅い/不安定」の後段でのみ使う
 *
 * ブラウザ制約による差分:
 *  - 回線種別・電波状態は取得不可（iOS SafariはNetwork Information API非対応）
 *  - DNS/TCP/TLSは「失敗の区別」ではなく「所要時間の内訳」として取得する
 *    （Resource Timing API。計測先が Timing-Allow-Origin を返す場合のみ）
 *  - キャプティブポータルは間接推定のみ
 */
"use strict";

const NetDiag = (() => {

  const DEFAULT_CONFIG = {
    // CORS / Timing-Allow-Origin 対応の無料公開エンドポイント。
    // 自前のCloudflare Worker（無料枠）に差し替え可能（README参照）
    probeUrl: "https://speed.cloudflare.com/__down?bytes=0",
    // 予備: probeUrl 失敗時に到達性のみ再確認（no-corsで内容は読まない）
    fallbackUrl: "https://www.gstatic.com/generate_204",
    timeoutMs: 3000,
    stabilitySamples: 5,
    stabilityIntervalMs: 200,

    // ---- 詳細診断用 ----
    // 運営主体の異なる計測先。全部遅い=自分側、特定だけ遅い=相手/経路側
    deepTargets: [
      { name: "Cloudflare", url: "https://speed.cloudflare.com/__down?bytes=0", mode: "cors" },
      { name: "Google", url: "https://www.gstatic.com/generate_204", mode: "no-cors" },
      { name: "jsDelivr", url: "https://cdn.jsdelivr.net/npm/lodash@4.17.21/package.json", mode: "cors" },
    ],
    deepDownloadUrl: "https://speed.cloudflare.com/__down?bytes=2000000",
    deepThroughputBytes: 200000, // 実効速度計測はここで打ち切り（データ節約）
    deepTimeoutMs: 5000,
    deepLoadMs: 2500,            // 負荷時遅延計測の背景ダウンロード継続時間
  };

  const StageNames = {
    connectivity: "接続性",
    breakdown: "内訳（DNS/TCP/TLS）",
    http: "HTTP応答",
    stability: "安定性",
    targets: "計測先の比較",
    throughput: "実効速度",
    loaded: "負荷時の遅延",
  };

  // ---- 診断カタログ（決定木の出力。Swift版 Diagnosis に対応） ----

  const CATALOG = {
    noSignal: {
      message: "ネットワークに接続されていません",
      suggestion: "機内モードやWi-Fiの設定を確認し、電波の届く場所へ移動してみてください",
    },
    captivePortal: {
      message: "このWi-Fiはログイン（認証）が必要な可能性があります",
      suggestion: "ブラウザで適当なページを開き、表示されるログインページで認証してください",
    },
    unreachable: {
      message: "回線にはつながっていますが、インターネットに出られません",
      suggestion: "Wi-Fiの入れ直し・ルーター再起動・モバイル回線への切り替えを試してください",
    },
    dnsSlow: {
      message: "宛先の住所案内係（DNS）の応答が遅くなっています",
      suggestion: "Wi-Fiを一度切って入れ直すか、時間をおいて再度お試しください",
    },
    weakOrCongested: {
      message: "電波が弱いか、回線が混雑しています",
      suggestion: "場所を少し移動するか、時間をおいて再度お試しください",
    },
    slow: {
      message: "つながっていますが、応答が遅い状態です",
      suggestion: "動画などの大きな通信は控えると快適になります",
    },
    healthy: {
      message: "通信は正常です",
      suggestion: "問題があれば相手のアプリ・サーバ側の可能性があります",
    },

    // ---- 詳細診断の出力 ----
    deepSaturated: {
      message: "回線が飽和しています（同じ回線で大きな通信が流れている可能性）",
      suggestion: "他の機器の動画視聴やアップロードを一時停止するか、時間をおいてください",
    },
    deepThrottled: {
      message: "通信速度が制限されている可能性があります（データ容量の使い切りなど）",
      suggestion: "契約のデータ残量を確認してください。Wi-Fiがあれば切り替えると改善します",
    },
    deepAccessCongested: {
      message: "お使いの回線全体が遅くなっています",
      suggestion: "場所を移動するか、Wi-Fiとモバイル回線を切り替えてみてください",
    },
    deepRemoteSlow: {
      message: "回線は正常で、特定の相手側の応答が遅いようです",
      suggestion: "時間をおいて再度アクセスしてください。相手側の復旧を待つ状況です",
    },
    deepFarPath: {
      message: "遅延は大きいものの、通信量は確保できています",
      suggestion: "ページ表示や動画は概ね使えます。通話やゲームなど即時性が必要な用途は苦手な状態です",
    },
    deepUnclear: {
      message: "追加調査でも単一のはっきりした原因は特定できませんでした",
      suggestion: "時間をおいて再診断し、記録（CSV）を見比べてみてください",
    },
  };

  const THRESHOLDS = {
    highLossRate: 0.2,   // 20%以上の失敗で「不安定」
    highJitterMs: 50,
    highRttMs: 300,
    slowDnsMs: 500,
    // 詳細診断
    bloatFactor: 3,      // 負荷時RTTが無負荷の3倍以上で「飽和」
    throttleKbps: 300,   // 実効速度がこれ未満なら「速度制限の疑い」
    goodKbps: 2000,      // これ以上出ていれば帯域は健全
    slowTargetMs: 300,
  };

  // ---- ユーティリティ ----

  const delay = (ms) => new Promise((r) => setTimeout(r, ms));

  function withBust(url) {
    const sep = url.includes("?") ? "&" : "?";
    return url + sep + "nd=" + Date.now() + "-" + Math.random().toString(36).slice(2);
  }

  /**
   * タイムアウト付きfetch。失敗も結果オブジェクトとして返す（throwしない）
   * mode:"no-cors" の場合、応答内容は読めないが「到達したか」は分かる
   */
  async function fetchProbe(url, timeoutMs, mode = "cors") {
    const target = withBust(url);
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    const t0 = performance.now();
    try {
      const res = await fetch(target, {
        mode,
        cache: "no-store",
        redirect: "follow",
        signal: ctrl.signal,
      });
      await res.arrayBuffer();
      return {
        ok: true,
        status: res.status,        // no-cors(opaque)時は0
        redirected: res.redirected,
        totalMs: performance.now() - t0,
        entry: performance.getEntriesByName(target).pop() || null,
      };
    } catch (e) {
      return {
        ok: false,
        error: e.name === "AbortError" ? "タイムアウト" : "接続失敗",
        totalMs: performance.now() - t0,
        entry: null,
      };
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Resource Timing から DNS/TCP/TLS/応答待ち の内訳を抽出。
   * 計測先が Timing-Allow-Origin を返さない場合は null（内訳は取れない）
   */
  function extractPhases(entry) {
    if (!entry || entry.requestStart === 0) return null;
    const reused = entry.connectEnd === entry.connectStart &&
                   entry.domainLookupEnd === entry.domainLookupStart;
    const tlsMs = entry.secureConnectionStart > 0
      ? entry.connectEnd - entry.secureConnectionStart : 0;
    const tcpEnd = entry.secureConnectionStart > 0
      ? entry.secureConnectionStart : entry.connectEnd;
    return {
      reused, // 既存接続の再利用（DNS/TCP/TLSは発生していない）
      dnsMs: entry.domainLookupEnd - entry.domainLookupStart,
      tcpMs: tcpEnd - entry.connectStart,
      tlsMs,
      waitMs: entry.responseStart - entry.requestStart, // サーバ往復+処理
    };
  }

  /** 実効速度計測。maxBytes か maxMs で打ち切り、部分計測も結果にする */
  async function measureThroughput(url, maxBytes, maxMs) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), maxMs);
    const t0 = performance.now();
    let bytes = 0;
    try {
      const res = await fetch(withBust(url), { cache: "no-store", signal: ctrl.signal });
      const reader = res.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        bytes += value.byteLength;
        if (bytes >= maxBytes) { ctrl.abort(); break; }
      }
    } catch { /* 中断・失敗も部分計測として扱う */ }
    finally { clearTimeout(timer); }
    const sec = (performance.now() - t0) / 1000;
    return { bytes, kbps: sec > 0 ? (bytes * 8) / 1000 / sec : 0 };
  }

  /** 背景ダウンロードを開始し、stop()で確実に打ち切るハンドルを返す */
  function startBackgroundLoad(url, maxMs) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), maxMs);
    (async () => {
      try {
        const res = await fetch(withBust(url), { cache: "no-store", signal: ctrl.signal });
        const reader = res.body.getReader();
        for (;;) { const { done } = await reader.read(); if (done) break; }
      } catch { /* 中断は正常系 */ }
    })();
    return { stop: () => { clearTimeout(timer); ctrl.abort(); } };
  }

  function fmtKbps(kbps) {
    return kbps >= 1000 ? (kbps / 1000).toFixed(1) + "Mbps" : Math.round(kbps) + "kbps";
  }

  // ---- 判定エンジン（決定木。Swift版 DiagnosisEngine に対応） ----

  function diagnose({ online, reachable, portalSuspect, phases, stability }) {
    const D = (key, detail = "") => ({ key, detail, ...CATALOG[key] });

    if (!online) return D("noSignal");
    if (!reachable) return D("unreachable");
    if (portalSuspect) return D("captivePortal");
    if (phases && !phases.reused && phases.dnsMs >= THRESHOLDS.slowDnsMs) {
      return D("dnsSlow", `DNS ${Math.round(phases.dnsMs)}ms`);
    }
    if (stability && (stability.lossRate >= THRESHOLDS.highLossRate ||
                      stability.jitterMs >= THRESHOLDS.highJitterMs)) {
      return D("weakOrCongested",
        `損失${Math.round(stability.lossRate * 100)}% / 揺らぎ${Math.round(stability.jitterMs)}ms`);
    }
    if (stability && stability.meanRttMs >= THRESHOLDS.highRttMs) {
      return D("slow", `平均${Math.round(stability.meanRttMs)}ms`);
    }
    return D("healthy");
  }

  /** 詳細診断の決定木（「遅い」をさらに4方向へ切り分ける） */
  function diagnoseDeep({ targets, kbps, bytes, idleRtt, loadedRtt }) {
    const D = (key, detail = "") => ({ key, detail, ...CATALOG[key] });

    // ① 飽和（バッファブロート）: 負荷をかけた時だけ遅延が膨らむ
    if (loadedRtt != null && idleRtt != null && idleRtt > 0 &&
        loadedRtt > idleRtt * THRESHOLDS.bloatFactor && loadedRtt > 200) {
      return D("deepSaturated",
        `無負荷${Math.round(idleRtt)}ms → 負荷時${Math.round(loadedRtt)}ms`);
    }

    // ② 速度制限: 遅延はともかく帯域が極端に細い
    if (bytes > 0 && kbps < THRESHOLDS.throttleKbps) {
      return D("deepThrottled", `実効 約${fmtKbps(kbps)}`);
    }

    const ok = targets.filter((t) => t.ms != null);
    if (ok.length >= 2) {
      const vals = ok.map((t) => t.ms);
      const min = Math.min(...vals);
      const max = Math.max(...vals);

      // ③ 全計測先が遅い → 自分側。帯域が出ていれば「遠い」だけ
      if (min >= THRESHOLDS.slowTargetMs) {
        return kbps >= THRESHOLDS.goodKbps
          ? D("deepFarPath", `RTT ${Math.round(min)}ms〜 / 約${fmtKbps(kbps)}`)
          : D("deepAccessCongested", `全計測先で${Math.round(min)}ms以上`);
      }
      // ④ 特定の計測先だけ遅い → 相手・経路側
      if (max >= THRESHOLDS.slowTargetMs && max > min * 3) {
        const slowT = ok.find((t) => t.ms === max);
        return D("deepRemoteSlow", `${slowT.name}のみ${Math.round(max)}ms`);
      }
    }

    // ⑤ 接続は速いのに応答待ちだけ長い → サーバ処理が遅い
    const sv = ok.find((t) => t.tcpMs != null && t.tcpMs < 100 &&
                              t.waitMs != null && t.waitMs > 500);
    if (sv) {
      return D("deepRemoteSlow",
        `${sv.name}: 接続${Math.round(sv.tcpMs)}ms / 応答待ち${Math.round(sv.waitMs)}ms`);
    }

    return D("deepUnclear");
  }

  // ---- オーケストレータ（Swift版 ProbeEngine に対応） ----

  class Engine {
    constructor(config = {}) {
      this.config = { ...DEFAULT_CONFIG, ...config };
      this.running = false;
    }

    /**
     * 通常診断。段階プローブを順に実行し、onStage(result) が段階ごとに呼ばれる。
     * 戻り値: { results: [...], diagnosis: {...}, metrics: {...} }
     */
    async run(onStage) {
      if (this.running) return null;
      this.running = true;
      const results = [];
      const push = (stage, outcome, detail, latencyMs = null) => {
        const r = { stage, outcome, detail, latencyMs };
        results.push(r);
        if (onStage) onStage(r);
      };

      try {
        // ① 接続性（通信なし。ブラウザの自己申告なので過信しない）
        const online = navigator.onLine;
        const conn = navigator.connection || null; // iOS Safariは非対応でnull
        const connDetail = conn
          ? `${conn.effectiveType || "?"} / 推定${conn.downlink ?? "?"}Mbps`
          : "回線種別は取得不可（iOS Safari）";
        push("connectivity", online ? "success" : "failure", connDetail);

        // オフラインなら以降は一切通信しない（必要条件: 悪環境でも固まらない）
        if (!online) {
          push("breakdown", "skipped", "オフラインのため未実施");
          push("http", "skipped", "オフラインのため未実施");
          push("stability", "skipped", "オフラインのため未実施");
          return {
            results,
            diagnosis: diagnose({ online }),
            metrics: { online, reachable: false, portalSuspect: false,
                       phases: null, stability: null, httpMs: null, httpStatus: null },
          };
        }

        // ② HTTP到達性 + DNS/TCP/TLS内訳（Resource Timing）
        const first = await fetchProbe(this.config.probeUrl, this.config.timeoutMs);
        let reachable = first.ok;
        let portalSuspect = false;
        let phases = null;
        let httpMs = null;
        let httpStatus = null;

        if (first.ok) {
          portalSuspect = first.redirected ||
                          (first.status >= 300 && first.status < 400);
          phases = extractPhases(first.entry);
          if (phases) {
            const d = phases.reused
              ? "接続を再利用（内訳なし）"
              : `DNS ${Math.round(phases.dnsMs)}ms / TCP ${Math.round(phases.tcpMs)}ms` +
                ` / TLS ${Math.round(phases.tlsMs)}ms / 応答待ち ${Math.round(phases.waitMs)}ms`;
            push("breakdown", "success", d);
          } else {
            push("breakdown", "failure",
              "計測先がTiming-Allow-Origin非対応のため総時間のみ");
          }
          httpMs = first.totalMs;
          httpStatus = first.status;
          push("http", "success", `status ${first.status}`, first.totalMs);
        } else {
          // 予備エンドポイントで到達性のみ再確認
          const fb = await fetchProbe(this.config.fallbackUrl,
                                      this.config.timeoutMs, "no-cors");
          reachable = fb.ok;
          // 主要先だけ失敗して予備には到達 → 選択的遮断（ポータル等）の疑い
          portalSuspect = fb.ok;
          if (fb.ok) httpMs = fb.totalMs;
          push("breakdown", "skipped", "到達失敗のため内訳なし");
          push("http", fb.ok ? "success" : "failure",
            fb.ok ? "予備の計測先のみ到達（要注意）" : first.error,
            fb.ok ? fb.totalMs : null);
        }

        // ③ 安定性（損失率・揺らぎ。Swift版 stability に対応）
        let stability = null;
        if (reachable) {
          const rtts = [];
          let failures = 0;
          const n = this.config.stabilitySamples;
          for (let i = 0; i < n; i++) {
            const r = await fetchProbe(this.config.probeUrl, this.config.timeoutMs);
            if (r.ok) rtts.push(r.totalMs);
            else failures++;
            await delay(this.config.stabilityIntervalMs);
          }
          const mean = rtts.length
            ? rtts.reduce((a, b) => a + b, 0) / rtts.length : 0;
          const jitter = rtts.length
            ? Math.sqrt(rtts.map((v) => (v - mean) ** 2)
                            .reduce((a, b) => a + b, 0) / rtts.length) : 0;
          stability = {
            samples: n,
            lossRate: failures / n,
            meanRttMs: mean,
            jitterMs: jitter,
          };
          push("stability",
            failures < n ? "success" : "failure",
            `損失${Math.round(stability.lossRate * 100)}% / 揺らぎ${Math.round(jitter)}ms`,
            mean || null);
        } else {
          push("stability", "skipped", "到達失敗のため未実施");
        }

        const diagnosis = diagnose({ online, reachable, portalSuspect, phases, stability });
        return {
          results,
          diagnosis,
          metrics: { online, reachable, portalSuspect, phases, stability, httpMs, httpStatus },
        };
      } finally {
        this.running = false;
      }
    }

    /**
     * 詳細診断（「遅い/不安定」の後段。追加で最大約2MB通信する）
     * idleRttMs には直前の run() の stability.meanRttMs を渡すとよい
     */
    async deepRun(onStage, idleRttMs = null) {
      if (this.running) return null;
      this.running = true;
      const results = [];
      const push = (stage, outcome, detail, latencyMs = null) => {
        const r = { stage, outcome, detail, latencyMs };
        results.push(r);
        if (onStage) onStage(r);
      };

      try {
        // ① 計測先の比較（自分側か相手・経路側かの切り分け）
        const targets = [];
        for (const t of this.config.deepTargets) {
          let best = null;
          let bestPhases = null;
          for (let i = 0; i < 2; i++) { // 2回測って良い方（瞬間ノイズ除去）
            const r = await fetchProbe(t.url, this.config.timeoutMs, t.mode);
            if (r.ok && (best == null || r.totalMs < best)) {
              best = r.totalMs;
              bestPhases = extractPhases(r.entry);
            }
          }
          targets.push({
            name: t.name,
            ms: best,
            tcpMs: bestPhases && !bestPhases.reused ? bestPhases.tcpMs : null,
            waitMs: bestPhases ? bestPhases.waitMs : null,
          });
        }
        const okT = targets.filter((t) => t.ms != null);
        push("targets", okT.length ? "success" : "failure",
          targets.map((t) =>
            `${t.name} ${t.ms != null ? Math.round(t.ms) + "ms" : "×"}`).join(" / "));

        // ② 実効速度（最大200KB・5秒で打ち切り）
        const thr = await measureThroughput(this.config.deepDownloadUrl,
          this.config.deepThroughputBytes, this.config.deepTimeoutMs);
        push("throughput", thr.bytes > 0 ? "success" : "failure",
          thr.bytes > 0
            ? `約${fmtKbps(thr.kbps)}（${Math.round(thr.bytes / 1000)}KB計測）`
            : "計測失敗");

        // ③ 負荷時の遅延（バッファブロート検出）
        let idle = idleRttMs;
        if (idle == null && okT.length) idle = Math.min(...okT.map((t) => t.ms));
        let loaded = null;
        if (idle != null && thr.bytes > 0) {
          const bg = startBackgroundLoad(this.config.deepDownloadUrl,
                                         this.config.deepLoadMs);
          await delay(600); // 帯域が埋まるのを待ってから測る
          const rtts = [];
          for (let i = 0; i < 3; i++) {
            const r = await fetchProbe(this.config.probeUrl, this.config.timeoutMs);
            if (r.ok) rtts.push(r.totalMs);
          }
          bg.stop();
          if (rtts.length) loaded = rtts.reduce((a, b) => a + b, 0) / rtts.length;
          push("loaded", loaded != null ? "success" : "failure",
            loaded != null
              ? `無負荷${Math.round(idle)}ms → 負荷時${Math.round(loaded)}ms`
              : "計測失敗");
        } else {
          push("loaded", "skipped", "基準値が無いため未実施");
        }

        const diagnosis = diagnoseDeep({
          targets, kbps: thr.kbps, bytes: thr.bytes,
          idleRtt: idle, loadedRtt: loaded,
        });
        return {
          results,
          diagnosis,
          metrics: {
            deep: {
              targets,
              thrKbps: Math.round(thr.kbps),
              idleRttMs: idle,
              loadedRttMs: loaded,
            },
          },
        };
      } finally {
        this.running = false;
      }
    }
  }

  return {
    Engine, StageNames, THRESHOLDS,
    _internals: { diagnose, diagnoseDeep }, // ユニットテスト用
  };
})();
