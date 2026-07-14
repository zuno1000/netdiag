/*
 * 道路メタファー可視化ビュー
 * 診断結果を「スマホ → 入口(Wi-Fi/基地局) → 案内所(DNS) → インターネット → 相手サーバ」
 * という道路に見立て、どこで詰まっているかをアニメーションで示す。
 *
 * 外部ライブラリ不使用（オフライン動作の必要条件のため）。
 * prefers-reduced-motion 設定時はアニメーションせず静止画で表示する。
 */
"use strict";

const NetDiagView = (() => {

  const W = 520, H = 215;
  const ROAD_Y = 110, ROAD_H = 26;
  const X0 = 30, X_GATE = 150, X_DNS = 265, X1 = 490;
  const SEGS = [[X0, X_GATE], [X_GATE, X_DNS], [X_DNS, X1]];
  const BASE_SPEED = 55;      // px/s
  const CAR_GAP = 12;
  const CAR_COLORS = ["#1d9e75", "#378add", "#7f77dd", "#d4537e", "#ef9f27"];
  const TONE_FILL = [null, "rgba(239,159,39,0.40)", "rgba(226,75,74,0.45)"];

  /*
   * 診断キー → シナリオ
   *  mult:  各区間の車速倍率（0=停止, 1=通常）
   *  tones: 各区間の色 0=通常 1=注意(琥珀) 2=障害(赤)
   *  block: 通行止めバリアのx座標（nullなら無し）
   */
  const SCENARIOS = {
    healthy:         { mult: [1, 1, 1],       tones: [0, 0, 0], block: null },
    slow:            { mult: [1, 1, 0.30],    tones: [0, 0, 1], block: null },
    weakOrCongested: { mult: [0.35, 1, 0.30], tones: [1, 0, 1], block: null },
    dnsSlow:         { mult: [1, 0.22, 1],    tones: [0, 1, 0], block: null },
    captivePortal:   { mult: [1, 0, 0],       tones: [0, 2, 2], block: { x: X_GATE } },
    unreachable:     { mult: [1, 1, 0],       tones: [0, 0, 2], block: { x: X_DNS + 14 } },
    noSignal:        { mult: [0, 0, 0],       tones: [2, 2, 2], block: { x: 108 } },

    // 詳細診断の結果
    deepSaturated:       { mult: [1, 1, 0.25],     tones: [0, 0, 1], block: null },
    deepThrottled:       { mult: [0.3, 0.3, 0.3],  tones: [1, 1, 1], block: null },
    deepAccessCongested: { mult: [0.3, 1, 0.35],   tones: [1, 0, 1], block: null },
    deepRemoteSlow:      { mult: [1, 1, 1],        tones: [0, 0, 0], block: null, serverMark: true },
    deepFarPath:         { mult: [0.5, 0.5, 0.5],  tones: [0, 0, 0], block: null },
    deepUnclear:         { mult: [0.5, 0.5, 0.5],  tones: [0, 0, 1], block: null },
  };

  let rafId = null;

  function el(tag, attrs = {}, text = null) {
    const e = document.createElementNS("http://www.w3.org/2000/svg", tag);
    for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
    if (text != null) e.textContent = text;
    return e;
  }

  function label(svg, x, y, lines, size = 11, anchor = "middle") {
    lines.forEach((line, i) => {
      svg.appendChild(el("text", {
        x, y: y + i * 13, "text-anchor": anchor,
        "font-size": size, class: "lbl",
      }, line));
    });
  }

  // ---- 静的な絵（道路・建物・バリア） ----

  function buildScene(svg, sc) {
    // 道路
    svg.appendChild(el("rect", {
      x: X0 - 8, y: ROAD_Y, width: X1 - X0 + 16, height: ROAD_H,
      rx: 6, fill: "#6b6b66",
    }));
    // 区間の色（注意/障害）
    SEGS.forEach(([a, b], i) => {
      const fill = TONE_FILL[sc.tones[i]];
      if (fill) svg.appendChild(el("rect", {
        x: a, y: ROAD_Y, width: b - a, height: ROAD_H, fill,
      }));
    });
    // センターライン
    svg.appendChild(el("line", {
      x1: X0, y1: ROAD_Y + ROAD_H / 2, x2: X1, y2: ROAD_Y + ROAD_H / 2,
      stroke: "#fff", "stroke-width": 2, "stroke-dasharray": "10 9", opacity: 0.55,
    }));

    const top = ROAD_Y - 12; // 建物の下端

    // スマホ
    svg.appendChild(el("rect", {
      x: X0 - 8, y: top - 30, width: 16, height: 28, rx: 3,
      fill: "#444441", stroke: "#fff", "stroke-width": 1,
    }));
    svg.appendChild(el("rect", {
      x: X0 - 5, y: top - 26, width: 10, height: 17, rx: 1, fill: "#9fe1cb",
    }));

    // 入口ゲート
    [[X_GATE - 11, 0], [X_GATE + 7, 0]].forEach(([gx]) => {
      svg.appendChild(el("rect", {
        x: gx, y: top - 26, width: 4, height: 26, fill: "#5f5e5a",
      }));
    });
    svg.appendChild(el("rect", {
      x: X_GATE - 14, y: top - 32, width: 28, height: 6, rx: 2, fill: "#5f5e5a",
    }));

    // 案内所（DNS）
    svg.appendChild(el("rect", {
      x: X_DNS - 12, y: top - 22, width: 24, height: 22, fill: "#85b7eb",
      stroke: "#185fa5", "stroke-width": 1,
    }));
    svg.appendChild(el("polygon", {
      points: `${X_DNS - 15},${top - 22} ${X_DNS + 15},${top - 22} ${X_DNS},${top - 34}`,
      fill: "#185fa5",
    }));
    svg.appendChild(el("text", {
      x: X_DNS, y: top - 6, "text-anchor": "middle",
      "font-size": 13, "font-weight": "bold", fill: "#042c53",
    }, "?"));

    // 相手サーバ
    [0, 1, 2].forEach((i) => {
      svg.appendChild(el("rect", {
        x: X1 - 12, y: top - 30 + i * 10, width: 26, height: 8, rx: 2,
        fill: "#888780", stroke: "#444441", "stroke-width": 1,
      }));
    });

    // ラベル
    const ly = ROAD_Y + ROAD_H + 18;
    label(svg, X0, ly, ["スマホ"]);
    label(svg, X_GATE, ly, ["入口", "(Wi-Fi・基地局)"]);
    label(svg, X_DNS, ly, ["案内所", "(DNS)"]);
    label(svg, (X_DNS + X1) / 2 + 20, ROAD_Y - 20, ["インターネット"]);
    label(svg, X1, ly, ["相手サーバ"]);

    // 相手サーバの注意マーク（サーバ側が遅い場合）
    if (sc.serverMark) {
      svg.appendChild(el("circle", { cx: X1 + 2, cy: ROAD_Y - 60, r: 10, fill: "#ef9f27" }));
      svg.appendChild(el("text", {
        x: X1 + 2, y: ROAD_Y - 55.5, "text-anchor": "middle",
        "font-size": 14, "font-weight": "bold", fill: "#fff",
      }, "!"));
    }

    // 通行止めバリア
    if (sc.block) {
      const bx = sc.block.x;
      svg.appendChild(el("rect", {
        x: bx - 4, y: ROAD_Y - 6, width: 8, height: ROAD_H + 12, rx: 2,
        fill: "#e24b4a", stroke: "#fff", "stroke-width": 1.5,
        "stroke-dasharray": "6 5",
      }));
      svg.appendChild(el("circle", { cx: bx, cy: ROAD_Y - 22, r: 10, fill: "#e24b4a" }));
      svg.appendChild(el("text", {
        x: bx, y: ROAD_Y - 17.5, "text-anchor": "middle",
        "font-size": 14, "font-weight": "bold", fill: "#fff",
      }, "!"));
    }
  }

  // ---- 車のシミュレーション（渋滞・行列は速度差から自然に生まれる） ----

  function segMult(sc, x) {
    for (let i = 0; i < SEGS.length; i++) if (x < SEGS[i][1]) return sc.mult[i];
    return sc.mult[SEGS.length - 1];
  }

  function startSim(svg, sc, n = 9, survey = false) {
    const layer = el("g");
    svg.appendChild(layer);
    const stopX = sc.block ? sc.block.x - 10 : null;
    const spawnEnd = stopX != null ? stopX : X1 - 10;
    const cy = ROAD_Y + ROAD_H / 2;
    const cars = [];
    for (let i = 0; i < n; i++) {
      const c = {
        x: X0 + ((spawnEnd - X0) * i) / n + Math.random() * 6,
        el: el("circle", { cy, r: 4.5, fill: CAR_COLORS[i % CAR_COLORS.length] }),
      };
      if (survey && i === n - 1) {
        // 調査車: 脈動するリング付き
        c.el.setAttribute("fill", "#1d9e75");
        c.ring = el("circle", {
          cy, r: 8, fill: "none", stroke: "#1d9e75",
          "stroke-width": 2, opacity: 0.8,
        });
        layer.appendChild(c.ring);
      }
      layer.appendChild(c.el);
      cars.push(c);
    }

    const still = window.matchMedia &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches;

    let prev = null;
    function tick(t) {
      if (prev == null) prev = t;
      const dt = Math.min((t - prev) / 1000, 0.05);
      prev = t;
      cars.sort((a, b) => b.x - a.x);
      let ahead = Infinity;
      for (const c of cars) {
        const lim = Math.min(ahead - CAR_GAP, stopX != null ? stopX : Infinity);
        const v = BASE_SPEED * segMult(sc, c.x);
        c.x = Math.min(c.x + v * dt, Math.max(lim, c.x));
        if (stopX == null && c.x > X1 - 6) c.x = X0; // 到着したら再出発
        ahead = c.x;
        c.el.setAttribute("cx", c.x.toFixed(1));
        if (c.ring) {
          c.ring.setAttribute("cx", c.x.toFixed(1));
          c.ring.setAttribute("r", (7 + 2 * Math.sin(t / 180)).toFixed(1));
        }
      }
      rafId = requestAnimationFrame(tick);
    }

    // 静止表示でも位置は描画する
    cars.forEach((c) => {
      c.el.setAttribute("cx", c.x.toFixed(1));
      if (c.ring) c.ring.setAttribute("cx", c.x.toFixed(1));
    });
    if (!still) rafId = requestAnimationFrame(tick);
  }

  // ---- 公開API ----

  function stop() {
    if (rafId != null) cancelAnimationFrame(rafId);
    rafId = null;
  }

  /** container 内に診断結果の道路ビューを描画する */
  function show(container, diagnosis) {
    stop();
    container.innerHTML = "";
    const sc = SCENARIOS[diagnosis.key] || SCENARIOS.healthy;
    const svg = el("svg", {
      viewBox: `0 0 ${W} ${H}`,
      role: "img",
      "aria-label": diagnosis.message,
    });
    buildScene(svg, sc);
    startSim(svg, sc);
    container.appendChild(svg);
    container.hidden = false;
  }

  /** 計測中の表示（調査車が道路を巡回する） */
  function scanning(container) {
    stop();
    container.innerHTML = "";
    const svg = el("svg", {
      viewBox: `0 0 ${W} ${H}`, role: "img", "aria-label": "計測中",
    });
    buildScene(svg, SCENARIOS.healthy);
    startSim(svg, SCENARIOS.healthy, 3, true);
    container.appendChild(svg);
    container.hidden = false;
  }

  return { show, scanning, stop };
})();
