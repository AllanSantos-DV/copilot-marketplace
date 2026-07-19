/* DESIGN SYSTEM · "pathTrace" — marcador que percorre uma rota com rastro.
   params: { points, color, routeColor, width, marker, speed, prog, trail, loop, showRoute } */
(() => {
  function clamp01(v){
    return Math.max(0, Math.min(1, v));
  }

  function pointAt(points, lengths, total, distance){
    if(total <= 0) return points[0];
    if(distance <= 0) return points[0];
    if(distance >= total) return points[points.length - 1];

    let passed = 0;
    for(let i=0; i<lengths.length; i++){
      const len = lengths[i];
      if(len <= 0) continue;
      if(distance <= passed + len){
        const f = (distance - passed) / len;
        return [
          points[i][0] + (points[i + 1][0] - points[i][0]) * f,
          points[i][1] + (points[i + 1][1] - points[i][1]) * f
        ];
      }
      passed += len;
    }
    return points[points.length - 1];
  }

  VXK.register('pathTrace', {
    create(n){ return {}; },
    draw(ctx, inst, n, e, selected){
      const source = Array.isArray(n.points) ? n.points : [];
      const points = [];
      for(let i=0; i<source.length; i++){
        const p = source[i];
        if(Array.isArray(p) && Number.isFinite(p[0]) && Number.isFinite(p[1])){
          points.push([p[0], p[1]]);
        }
      }
      if(!points.length) return;

      const zoom = e && Number.isFinite(e.zoom) && e.zoom > 0 ? e.zoom : 1;
      const color = n.color || '#5b8cff';
      const width = Math.max(0, Number.isFinite(n.width) ? n.width : 2);
      const marker = Math.max(0, Number.isFinite(n.marker) ? n.marker : 5);
      const speed = Number.isFinite(n.speed) ? n.speed : 1;
      const lengths = [];
      let total = 0;

      for(let i=0; i<points.length - 1; i++){
        const dx = points[i + 1][0] - points[i][0];
        const dy = points[i + 1][1] - points[i][1];
        const len = Math.hypot(dx, dy);
        lengths.push(len);
        total += len;
      }

      let u;
      if(n.prog != null){
        u = clamp01(Number.isFinite(n.prog) ? n.prog : 0);
      }else{
        const clock = e && Number.isFinite(e.t) ? e.t : 0;
        const phase = clock * speed;
        u = n.loop === false ? clamp01(phase) : ((phase % 1) + 1) % 1;
      }
      const distance = total * u;

      ctx.save();
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';

      if(n.showRoute !== false && points.length > 1 && total > 0 && width > 0){
        ctx.beginPath();
        ctx.moveTo(points[0][0], points[0][1]);
        for(let i=1; i<points.length; i++) ctx.lineTo(points[i][0], points[i][1]);
        ctx.strokeStyle = n.routeColor || color;
        ctx.globalAlpha = n.routeColor ? 1 : 0.22;
        ctx.lineWidth = width / zoom;
        ctx.stroke();
      }

      if(n.trail !== false && total > 0 && distance > 0 && width > 0){
        const trailLength = Math.min(total * 0.18, distance);
        const segments = 18;
        const start = distance - trailLength;
        ctx.strokeStyle = color;
        ctx.lineWidth = width / zoom;
        for(let i=0; i<segments; i++){
          const f0 = i / segments;
          const f1 = (i + 1) / segments;
          const a = pointAt(points, lengths, total, start + trailLength * f0);
          const b = pointAt(points, lengths, total, start + trailLength * f1);
          ctx.globalAlpha = 0.06 + 0.78 * f1 * f1;
          ctx.beginPath();
          ctx.moveTo(a[0], a[1]);
          ctx.lineTo(b[0], b[1]);
          ctx.stroke();
        }
      }

      const pos = pointAt(points, lengths, total, distance);
      if(marker > 0){
        ctx.globalAlpha = 1;
        ctx.fillStyle = color;
        ctx.beginPath();
        ctx.arc(pos[0], pos[1], marker / zoom, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.restore();
    },
    hit(){ return false; }
  });
})();
