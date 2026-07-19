// Importador de TEMA a partir do arquivo-modelo do usuário (build-time, offline).
// Foco principal: PowerPoint (.pptx) — que é um ZIP OOXML e traz o tema legível por
// máquina em ppt/theme/theme1.xml (paleta accent1-6 + fundo/texto + fontes major/minor).
// Também: HTML/CSS (variáveis :root + font-family) e tokens (JSON/CSS).
// Saída: um objeto `theme` de tokens VXK: { accent, accents[], bg, surface, text, muted, fontHead, fontBody, source }.
import { readFileSync } from 'node:fs';
import { extname } from 'node:path';
import { unzipSync, strFromU8 } from 'fflate';

function norm(hex){ if(!hex) return null; hex=String(hex).replace('#','').trim(); if(!/^[0-9a-fA-F]{6,8}$/.test(hex)) return null; return '#'+hex.slice(0,6).toUpperCase(); }
function pick(re, xml){ const m=re.exec(xml); return m ? m[1] : null; }
// dentro de um slot de cor (<a:accent1>...</a:accent1>) pega srgbClr val OU sysClr lastClr
function slotColor(xml, slot){
  const seg = new RegExp('<a:'+slot+'\\b[^>]*>([\\s\\S]*?)</a:'+slot+'>').exec(xml);
  const body = seg ? seg[1] : '';
  return norm(pick(/<a:srgbClr\s+val="([0-9a-fA-F]{6,8})"/, body) || pick(/<a:sysClr\b[^>]*lastClr="([0-9a-fA-F]{6})"/, body));
}

export function importPptxTheme(pptxPath){
  const buf = readFileSync(pptxPath);
  const zip = unzipSync(new Uint8Array(buf));
  // acha o theme principal (ppt/theme/theme1.xml) ou o primeiro theme disponível
  let themeKey = Object.keys(zip).find(k=>/^ppt\/theme\/theme1\.xml$/i.test(k))
              || Object.keys(zip).find(k=>/^ppt\/theme\/theme\d+\.xml$/i.test(k));
  if(!themeKey) throw new Error('theme não encontrado no .pptx (ppt/theme/themeN.xml ausente)');
  const xml = strFromU8(zip[themeKey]);
  const clr = /<a:clrScheme[\s\S]*?<\/a:clrScheme>/.exec(xml); const cs = clr ? clr[0] : xml;
  const colors = {};
  for(const slot of ['dk1','lt1','dk2','lt2','accent1','accent2','accent3','accent4','accent5','accent6','hlink','folHlink'])
    colors[slot] = slotColor(cs, slot);
  const fnt = /<a:fontScheme[\s\S]*?<\/a:fontScheme>/.exec(xml); const fs2 = fnt ? fnt[0] : xml;
  const major = pick(/<a:majorFont>[\s\S]*?<a:latin\s+typeface="([^"]*)"/, fs2);
  const minor = pick(/<a:minorFont>[\s\S]*?<a:latin\s+typeface="([^"]*)"/, fs2);
  const theme = toTheme(colors, major, minor, 'pptx:'+pptxPath.split(/[\\/]/).pop());
  const fonts = extractPptxFonts(zip);            // fontes EMBUTIDAS (se o deck as embarcou) -> @font-face offline
  if(fonts.length) theme.embeddedFonts = fonts;
  return theme;
}

// Extrai fontes embutidas do pptx (ppt/fonts/*.fntdata) mapeando typeface+peso via presentation.xml + rels.
function extractPptxFonts(zip){
  const presBuf = zip['ppt/presentation.xml'], relsBuf = zip['ppt/_rels/presentation.xml.rels'];
  if(!presBuf || !relsBuf) return [];
  const px = strFromU8(presBuf), rels = strFromU8(relsBuf);
  const relMap = {};
  for(const m of rels.matchAll(/<Relationship\b[^>]*?Id="([^"]+)"[^>]*?Target="([^"]+)"[^>]*>/g)) relMap[m[1]] = m[2];
  const out = [], seen = new Set();
  for(const ef of px.matchAll(/<p:embeddedFont>([\s\S]*?)<\/p:embeddedFont>/g)){
    const body = ef[1];
    const fam = (/<p:font\b[^>]*typeface="([^"]*)"/.exec(body) || [])[1]; if(!fam) continue;
    for(const [tag, style, weight] of [['regular','normal','400'],['bold','normal','700'],['italic','italic','400'],['boldItalic','italic','700']]){
      const rid = (new RegExp('<p:'+tag+'\\b[^>]*r:id="([^"]+)"').exec(body) || [])[1]; if(!rid) continue;
      let tgt = relMap[rid]; if(!tgt) continue; tgt = tgt.replace(/^\.\.\//,'').replace(/^\//,'');
      const key = tgt.startsWith('ppt/') ? tgt : 'ppt/'+tgt;
      const data = zip[key] || zip[tgt]; if(!data) continue;
      const id = fam+'|'+style+'|'+weight; if(seen.has(id)) continue; seen.add(id);
      out.push({ family:fam, style, weight, dataUrl:'data:font/ttf;base64,'+Buffer.from(data).toString('base64') });
    }
  }
  return out;
}

export function importHtmlTheme(htmlPath){
  const html = readFileSync(htmlPath,'utf8');
  // variáveis CSS em :root
  const root = /:root\s*\{([\s\S]*?)\}/.exec(html); const vars = {};
  if(root) for(const m of root[1].matchAll(/(--[\w-]+)\s*:\s*(#[0-9a-fA-F]{3,8}|[a-z]+\([^)]*\))/g)) vars[m[1]]=m[2];
  const accent = norm(vars['--accent']||vars['--primary']||vars['--brand']||vars['--color-primary']);
  const bg = norm(vars['--bg']||vars['--background']||vars['--surface-0']);
  const text = norm(vars['--text']||vars['--fg']||vars['--color-text']);
  // font-family (primeira família declarada)
  const ff = pick(/font-family\s*:\s*([^;]+);/i, html);
  const font = ff ? ff.split(',')[0].replace(/['"]/g,'').trim() : null;
  // se não achou por var, coleta as cores hex mais citadas
  let accents=[];
  if(!accent){ const freq={}; for(const m of html.matchAll(/#([0-9a-fA-F]{6})\b/g)){ const c='#'+m[1].toUpperCase(); freq[c]=(freq[c]||0)+1; } accents=Object.entries(freq).sort((a,b)=>b[1]-a[1]).slice(0,6).map(x=>x[0]); }
  const colors = { accent1:accent||accents[0], lt1:bg, dk1:text, accent2:accents[1], accent3:accents[2], accent4:accents[3], accent5:accents[4], accent6:accents[5] };
  return toTheme(colors, font, font, 'html:'+htmlPath.split(/[\\/]/).pop());
}

export function importTokensTheme(jsonPath){
  const t = JSON.parse(readFileSync(jsonPath,'utf8'));
  const g = (...ks)=>{ for(const k of ks){ const v=k.split('.').reduce((o,p)=>o&&o[p], t); if(v) return v; } return null; };
  const colors = {
    accent1: norm(g('accent','colors.accent','colors.primary','brand.primary','primary')),
    lt1: norm(g('bg','background','colors.bg','colors.background')),
    dk1: norm(g('text','fg','colors.text')),
  };
  const font = g('font','fontFamily','typography.fontFamily','fonts.body');
  return toTheme(colors, g('fonts.heading','typography.heading')||font, font, 'tokens:'+jsonPath.split(/[\\/]/).pop());
}

// mapeia o esquema OOXML/CSS -> tokens VXK
function toTheme(c, major, minor, source){
  const accents = ['accent1','accent2','accent3','accent4','accent5','accent6'].map(k=>c[k]).filter(Boolean);
  const dark = c.lt1 && isDark(c.lt1) ? true : (c.lt1 ? false : true);   // fundo escuro? (VXK é dark por padrão)
  const bg = c.lt1 || (dark ? '#0d1424' : '#ffffff');
  let text = c.dk1 || (dark ? '#eef3ff' : '#10151f');
  if(isDark(bg) === isDark(text)) text = isDark(bg) ? '#eef3ff' : '#10151f';   // garante contraste (dk1/lt1 podem vir trocados no master)
  return {
    accent: accents[0] || '#5b8cff',
    accents,
    bg,
    surface: c.lt2 || null,
    text,
    muted: c.dk2 || null,
    fontHead: major || null,
    fontBody: minor || null,
    source
  };
}
function isDark(hex){ const h=hex.replace('#',''); const r=parseInt(h.slice(0,2),16),g=parseInt(h.slice(2,4),16),b=parseInt(h.slice(4,6),16); return (0.2126*r+0.7152*g+0.0722*b) < 128; }

// CLI: node kit/lib/theme-import.mjs <arquivo>
if(process.argv[1] && process.argv[1].endsWith('theme-import.mjs')){
  const p = process.argv[2]; if(!p){ console.error('uso: node kit/lib/theme-import.mjs <arquivo.pptx|.html|.json>'); process.exit(1); }
  const ext = extname(p).toLowerCase();
  const t = ext==='.pptx' ? importPptxTheme(p) : ext==='.html'||ext==='.htm' ? importHtmlTheme(p) : importTokensTheme(p);
  console.log(JSON.stringify(t, null, 2));
}
