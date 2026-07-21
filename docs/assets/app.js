// Progressive enhancement da vitrine. Sem isto a página funciona: os comandos já
// estão no HTML e os links também. Aqui só adicionamos copiar-com-um-clique e a
// digitação do comando no hero (desligada com prefers-reduced-motion).
(() => {
  "use strict";

  const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  // ---- copiar comando ----
  async function copy(text) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      // fallback p/ contexto sem clipboard API
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.setAttribute("readonly", "");
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      let ok = false;
      try { ok = document.execCommand("copy"); } catch { ok = false; }
      document.body.removeChild(ta);
      return ok;
    }
  }

  document.querySelectorAll(".copy").forEach((btn) => {
    const original = btn.textContent;
    btn.addEventListener("click", async () => {
      const ok = await copy(btn.getAttribute("data-copy") || "");
      btn.textContent = ok ? "copiado ✓" : "erro";
      btn.classList.toggle("is-done", ok);
      window.clearTimeout(btn._t);
      btn._t = window.setTimeout(() => {
        btn.textContent = original;
        btn.classList.remove("is-done");
      }, 1500);
    });
  });

  // ---- scrollspy da TOC (só nas páginas dedicadas) ----
  const tocLinks = Array.from(document.querySelectorAll(".toc__list a"));
  if (tocLinks.length && "IntersectionObserver" in window) {
    const byId = new Map();
    tocLinks.forEach((a) => {
      const id = decodeURIComponent((a.getAttribute("href") || "").replace(/^#/, ""));
      if (id) byId.set(id, a);
    });
    const sections = Array.from(document.querySelectorAll(".doc-section")).filter((s) => byId.has(s.id));
    if (sections.length) {
      const visible = new Set();
      let active = null;
      const paint = () => {
        const top = sections.find((s) => visible.has(s.id));
        const id = top ? top.id : active;
        if (!id || id === active) return;
        active = id;
        tocLinks.forEach((a) => a.classList.remove("is-active"));
        byId.get(id)?.classList.add("is-active");
      };
      const obs = new IntersectionObserver(
        (entries) => {
          entries.forEach((e) => (e.isIntersecting ? visible.add(e.target.id) : visible.delete(e.target.id)));
          paint();
        },
        { rootMargin: "-84px 0px -68% 0px", threshold: 0 }
      );
      sections.forEach((s) => obs.observe(s));
    }
  }

  // ---- assinatura da embed-house: RAM do modelo × consumidores ----
  // Progressive enhancement ISOLADO a esta página (guarda por pathname + presença
  // da seção). Sem JS, a seção "Por que a casa existe" já explica tudo em prosa;
  // aqui só desenhamos a prova visual: a cópia local cresce O(N), a casa fica O(1).
  function mountRamViz(host) {
    const PER = 147; // MB de RAM por sessão, só do modelo (fato medido)
    const MAXN = 20; // teto de consumidores no controle
    const YMAX = 3000; // topo do eixo em MB (20 × 147 = 2.940 cabe abaixo)
    const W = 680, H = 280, L = 58, Rr = 16, Tt = 18, Bb = 34;
    const x0 = L, x1 = W - Rr, y0 = Tt, y1 = H - Bb;
    const NS = "http://www.w3.org/2000/svg";
    const fmt = (v) => v.toLocaleString("pt-BR");
    const sx = (i) => x0 + ((i - 1) / (MAXN - 1)) * (x1 - x0);
    const sy = (v) => y1 - (Math.min(v, YMAX) / YMAX) * (y1 - y0);
    const svgEl = (tag, attrs, parent) => {
      const n = document.createElementNS(NS, tag);
      for (const k in attrs) n.setAttribute(k, String(attrs[k]));
      if (parent) parent.appendChild(n);
      return n;
    };

    const fig = document.createElement("figure");
    fig.className = "ram-viz";
    fig.setAttribute("aria-label", "RAM do modelo conforme os consumidores crescem");

    const cap = document.createElement("figcaption");
    cap.className = "ram-viz__cap";
    cap.innerHTML = '<span class="ram-viz__glyph" aria-hidden="true">\u2301</span> ram do modelo \u00d7 consumidores';
    fig.appendChild(cap);

    const chart = document.createElement("div");
    chart.className = "ram-viz__chart";
    const svg = svgEl("svg", { viewBox: `0 0 ${W} ${H}`, "aria-hidden": "true", focusable: "false", preserveAspectRatio: "xMidYMid meet" }, chart);
    fig.appendChild(chart);

    for (let v = 0; v <= YMAX; v += 1000) {
      svgEl("line", { class: "ram-viz__grid", x1: x0, y1: sy(v), x2: x1, y2: sy(v) }, svg);
      svgEl("text", { class: "ram-viz__ytick", x: x0 - 8, y: sy(v) + 4, "text-anchor": "end" }, svg).textContent = v === 0 ? "0" : fmt(v);
    }
    [1, 5, 10, 15, 20].forEach((i) => {
      svgEl("text", { class: "ram-viz__xtick", x: sx(i), y: H - 12, "text-anchor": "middle" }, svg).textContent = String(i);
    });
    svgEl("line", { class: "ram-viz__axis", x1: x0, y1: y1, x2: x1, y2: y1 }, svg);

    const waste = svgEl("polygon", { class: "ram-viz__waste", points: "" }, svg);
    const houseLine = svgEl("polyline", { class: "ram-viz__line ram-viz__line--house", points: "" }, svg);
    const costLine = svgEl("polyline", { class: "ram-viz__line ram-viz__line--cost", points: "" }, svg);
    const gap = svgEl("line", { class: "ram-viz__gap", x1: 0, y1: 0, x2: 0, y2: 0 }, svg);
    const houseDot = svgEl("circle", { class: "ram-viz__dot ram-viz__dot--house", r: 4, cx: 0, cy: 0 }, svg);
    const costDot = svgEl("circle", { class: "ram-viz__dot ram-viz__dot--cost", r: 4, cx: 0, cy: 0 }, svg);

    const read = document.createElement("div");
    read.className = "ram-viz__read";
    read.innerHTML =
      '<div class="ram-viz__stat ram-viz__stat--cost"><span class="ram-viz__k"><span class="ram-viz__swatch ram-viz__swatch--cost" aria-hidden="true"></span>cada um carrega o seu</span><span class="ram-viz__v" data-cost>\u2014</span><span class="ram-viz__u" data-cost-note>\u2014</span></div>' +
      '<div class="ram-viz__stat ram-viz__stat--house"><span class="ram-viz__k"><span class="ram-viz__swatch ram-viz__swatch--house" aria-hidden="true"></span>todos usam a casa</span><span class="ram-viz__v" data-house>\u2014</span><span class="ram-viz__u">1 \u00d7 147 MB \u00b7 O(1)</span></div>';
    fig.appendChild(read);

    const ctl = document.createElement("label");
    ctl.className = "ram-viz__ctl";
    ctl.innerHTML = '<span class="ram-viz__ctl-lab">consumidores <output data-n>8</output></span>';
    const slider = document.createElement("input");
    slider.type = "range";
    slider.min = "1";
    slider.max = String(MAXN);
    slider.step = "1";
    slider.value = "8";
    slider.className = "ram-viz__slider";
    slider.setAttribute("aria-label", "N\u00famero de consumidores");
    ctl.appendChild(slider);
    fig.appendChild(ctl);

    const save = document.createElement("p");
    save.className = "ram-viz__save";
    fig.appendChild(save);

    const $cost = read.querySelector("[data-cost]");
    const $costNote = read.querySelector("[data-cost-note]");
    const $house = read.querySelector("[data-house]");
    const $n = ctl.querySelector("[data-n]");

    const line = (fn, n) => {
      let s = "";
      for (let i = 1; i <= n; i++) s += `${sx(i).toFixed(1)},${sy(fn(i)).toFixed(1)} `;
      return s.trim();
    };

    function render(n) {
      const cost = PER * n;
      costLine.setAttribute("points", line((i) => PER * i, n));
      houseLine.setAttribute("points", line(() => PER, n));
      let poly = "";
      for (let i = 1; i <= n; i++) poly += `${sx(i).toFixed(1)},${sy(PER * i).toFixed(1)} `;
      for (let i = n; i >= 1; i--) poly += `${sx(i).toFixed(1)},${sy(PER).toFixed(1)} `;
      waste.setAttribute("points", poly.trim());
      const ex = sx(n);
      costDot.setAttribute("cx", ex);
      costDot.setAttribute("cy", sy(cost));
      houseDot.setAttribute("cx", ex);
      houseDot.setAttribute("cy", sy(PER));
      gap.setAttribute("x1", ex);
      gap.setAttribute("y1", sy(cost));
      gap.setAttribute("x2", ex);
      gap.setAttribute("y2", sy(PER));
      $cost.textContent = fmt(cost) + " MB";
      $costNote.textContent = `${n} \u00d7 147 MB \u00b7 O(N)`;
      $house.textContent = "147 MB";
      $n.textContent = String(n);
      const saved = PER * (n - 1);
      save.innerHTML =
        n <= 1
          ? "Com <strong>1</strong> consumidor, a casa e a c\u00f3pia local empatam \u2014 a economia come\u00e7a no segundo."
          : `Com <strong>${n}</strong> consumidores, a casa poupa <strong>${fmt(saved)} MB</strong> de RAM do <em>mesmo</em> modelo.`;
    }

    slider.addEventListener("input", () => render(parseInt(slider.value, 10) || 1));
    render(8);
    host.appendChild(fig);
  }

  try {
    if (location.pathname.includes("/p/embed-house/")) {
      const host = document.getElementById("por-que-existe");
      if (host) mountRamViz(host);
    }
  } catch (_) {
    /* enhancement: nunca quebra a p\u00e1gina */
  }

  // ---- digitação do hero (uma vez, no load) ----
  const cmd = document.getElementById("hero-cmd");
  const prompt = cmd && cmd.closest(".prompt--hero");
  if (!cmd || !prompt) return;

  if (reduced) {
    prompt.classList.add("is-typed"); // só o caret estático
    return;
  }

  const full = cmd.textContent;
  cmd.textContent = "";
  prompt.classList.add("is-typed");
  let i = 0;
  const tick = () => {
    cmd.textContent = full.slice(0, i);
    if (i < full.length) {
      i += 1;
      window.setTimeout(tick, 22 + Math.random() * 22);
    }
  };
  window.setTimeout(tick, 260);
})();
