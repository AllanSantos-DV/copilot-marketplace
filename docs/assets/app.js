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
