#!/usr/bin/env node
/* =====================================================================
   VXK build-artifact — monta um HTML autocontido a partir de uma spec.
   O agente escreve só a spec (JSON); este builder inlina o motor escolhido.
     node build-artifact.mjs <spec.json> [saida.html]
   engine "vxk"  (default) -> inlina vxk-core + componentes usados + spec
   engine "konva"          -> inlina konva.min.js + konva-adapter + spec
   Sem saída explícita: grava em <Desktop>\visual-explanations\<slug>.html
   ===================================================================== */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import os from 'node:os';

const __dirname = dirname(fileURLToPath(import.meta.url));
const KIT = join(__dirname, 'kit');
const read = p => readFileSync(p, 'utf8');
const escHtml = s => String(s).replace(/[&<>]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;'}[c]));

function slug(s){
  return (String(s||'arte').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'')
    .replace(/[^a-z0-9]+/g,'-').replace(/(^-|-$)/g,'').slice(0,60)) || 'arte';
}
function desktopDir(){ return join(os.homedir(), 'Desktop', 'visual-explanations'); }

function page(spec, headExtra, bodyScripts){
  return '<!DOCTYPE html>\n<html lang="'+(spec.language||'pt-BR')+'">\n<head>' +
    '<meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">' +
    '<title>'+escHtml(spec.title||'Explicação visual')+'</title>' + headExtra +
    '</head>\n<body><div id="vxk-root"></div>\n' + bodyScripts + '\n</body>\n</html>\n';
}

function buildVxk(spec){
  const css = read(join(KIT,'vxk-core.css'));
  const core = read(join(KIT,'vxk-core.js'));
  const types = [...new Set((spec.nodes||[]).map(n=>n.type))];
  const comps = types.map(t => {
    const f = join(KIT,'components',t+'.js');
    if(!existsSync(f)) throw new Error('Componente ausente no design system: "'+t+'"  -> crie kit/components/'+t+'.js');
    return read(f);
  });
  const head = '<style>'+css+(spec.css||'')+'</style>';
  const scripts = '<script>'+core+'</script>\n' +
    comps.map(c => '<script>'+c+'</script>').join('\n') + '\n' +
    '<script>VXK.mount('+JSON.stringify(spec)+', "#vxk-root");</script>';
  return page(spec, head, scripts);
}

function buildKonva(spec){
  const adapterPath = join(KIT,'konva','konva-adapter.js');
  if(!existsSync(adapterPath)) throw new Error('Motor Konva ainda não implementado (F3): falta kit/konva/konva-adapter.js');
  const konva = read(join(KIT,'konva','konva.min.js'));
  const adapter = read(adapterPath);
  const css = read(join(KIT,'vxk-core.css'));
  const head = '<style>'+css+(spec.css||'')+'</style>';
  const scripts = '<script>'+konva+'</script>\n<script>'+adapter+'</script>\n' +
    '<script>VXKKonva.mount('+JSON.stringify(spec)+', "#vxk-root");</script>';
  return page(spec, head, scripts);
}

function main(){
  const specPath = process.argv[2];
  if(!specPath){ console.error('uso: node build-artifact.mjs <spec.json> [saida.html]'); process.exit(1); }
  const spec = JSON.parse(read(resolve(specPath)));
  const engine = spec.engine || 'vxk';
  const html = engine === 'konva' ? buildKonva(spec) : buildVxk(spec);
  let out = process.argv[3];
  if(!out){ const d=desktopDir(); if(!existsSync(d)) mkdirSync(d,{recursive:true}); out=join(d, slug(spec.slug||spec.title)+'.html'); }
  writeFileSync(out, html, 'utf8');
  console.log('OK  '+out+'  ('+Buffer.byteLength(html,'utf8')+' bytes, engine='+engine+', componentes='+[...new Set((spec.nodes||[]).map(n=>n.type))].join(',')+')');
}
main();
