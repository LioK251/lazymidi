/* Shared canvas artwork for the player and its settings previews. */
(function () {
  'use strict';

  const styles = {
    classic: {
      name: 'Classic', description: 'Polished keys & colorful light',
      background: ['#131a2e', '#0a0e17', '#05070d'], accent: '#a855f7',
      colors: [[168,85,247], [59,130,246], [16,185,129], [245,158,11], [239,68,68], [236,72,153], [34,211,238], [132,204,22]],
      white: ['#ffffff', '#e8e8ea', '#cfcfd4'], black: ['#3a3a3e', '#1a1a1a', '#0c0c0e'],
      grid: 'rgba(130,150,190,0.13)', border: '#b0b0b0', label: '#666674', particles: true,
    },
    crayon: {
      name: 'Crayon', description: 'Living strokes & warm paper',
      background: ['#f6eedb', '#f0e5cb', '#e8d9b9'], accent: '#b95748',
      colors: [[192,77,66], [66,121,163], [94,142,95], [200,147,43], [140,99,161], [195,105,131], [58,143,143], [167,131,72]],
      white: ['#fff9e9', '#f6ebd2', '#e4d4b4'], black: ['#64574b', '#443c35', '#342d28'],
      grid: 'rgba(119,93,63,0.15)', border: '#bbae92', label: '#796a53', paper: true,
    },
    sketch: {
      name: 'Sketchbook', description: 'Animated pen lines on paper',
      background: ['#f9f7ed', '#f3f0e4', '#e9e5d6'], accent: '#424858',
      colors: [[51,81,117], [145,77,83], [61,112,91], [158,117,50], [113,85,136], [61,126,135], [136,82,61], [88,103,57]],
      white: ['#ffffff', '#f6f4e9', '#e8e5d8'], black: ['#5a6071', '#3b4050', '#252b36'],
      grid: 'rgba(70,76,90,0.13)', border: '#b9b6a9', label: '#666a75', paper: true,
    },
    neon: {
      name: 'Neon', description: 'Electric outlines after dark',
      background: ['#160d2b', '#080d20', '#040814'], accent: '#49e8ed',
      colors: [[60,235,245], [247,86,201], [158,116,255], [248,213,95], [91,245,168], [255,121,96], [100,160,255], [211,125,255]],
      white: ['#24344a', '#17263b', '#101c2c'], black: ['#162139', '#090f21', '#050817'],
      grid: 'rgba(90,193,230,0.12)', border: '#35435e', label: '#9caec5', particles: true,
    },
    watercolor: {
      name: 'Watercolor', description: 'Soft washes & flowing color',
      background: ['#f2f4f2', '#e7efed', '#dbe7e5'], accent: '#678f9d',
      colors: [[104,137,180], [177,117,145], [105,155,134], [200,164,105], [153,130,177], [199,137,121], [94,157,167], [154,165,112]],
      white: ['#fbfcf8', '#edf2ed', '#d7e2dc'], black: ['#637674', '#415654', '#314341'],
      grid: 'rgba(90,119,121,0.12)', border: '#b2c4bf', label: '#5c7772', paper: true,
    },
    arcade: {
      name: 'Arcade', description: 'Pixel blocks & electric color',
      background: ['#17214a', '#101632', '#080c21'], accent: '#ffe16a',
      colors: [[255,103,134], [90,224,250], [255,224,106], [137,255,172], [188,133,255], [255,159,88], [97,164,255], [248,130,218]],
      white: ['#f3f0de', '#e6e3d3', '#cbc8bd'], black: ['#37457a', '#26345f', '#172344'],
      grid: 'rgba(110,161,255,0.16)', border: '#8e94ae', label: '#464d73',
    },
  };
  const normalize = value => Object.prototype.hasOwnProperty.call(styles, value) ? value : 'classic';
  const keyboardStyles = {
    theme: 'Match visualizer style', ivory: 'Ivory', sketch: 'Pencil sketch', neon: 'Neon keys',
  };
  const normalizeKeyboard = value => Object.prototype.hasOwnProperty.call(keyboardStyles, value) ? value : 'theme';
  function keyboard(styleId, theme) {
    if (styleId === 'ivory') return {
      white: ['#ffffff', '#faf9f5', '#e8e6e0'], black: ['#3d424d', '#252b36', '#141a24'],
      border: '#b6b7b5', label: '#666b75', felt: '#252b36', activeLabel: '#202633',
    };
    if (styleId === 'sketch') return {
      white: ['#fff8e7', '#f2e8ce', '#ddceaa'], black: ['#817365', '#594f45', '#342f2b'],
      border: '#887762', label: '#65594a', felt: '#9d664a', activeLabel: '#352e27',
    };
    if (styleId === 'neon') return {
      white: ['#3c205a', '#25183f', '#12162e'], black: ['#181a3c', '#0e1230', '#050b20'],
      border: '#42e4ef', label: '#a7ecf2', felt: '#46ecf1', activeLabel: '#ffffff',
    };
    return { white: theme.white, black: theme.black, border: theme.border,
      label: theme.label, felt: theme.accent, activeLabel: theme.paper ? '#342d28' : '#ffffff' };
  }

  function keyboardDetail(ctx, styleId, x, y, width, height, isBlack) {
    if (styleId === 'sketch') {
      ctx.save();
      ctx.strokeStyle = isBlack ? 'rgba(245,224,185,0.32)' : 'rgba(91,69,51,0.25)';
      ctx.lineWidth = 0.7;
      for (let i = 0; i < 3; i++) {
        ctx.beginPath();
        ctx.moveTo(x + 2 + i * 3, y + 4);
        ctx.lineTo(x + 4 + i * 3, y + Math.min(height - 3, 20));
        ctx.stroke();
      }
      ctx.restore();
    } else if (styleId === 'neon') {
      ctx.save();
      ctx.strokeStyle = isBlack ? '#b875ff' : '#4de7f2';
      ctx.globalAlpha = isBlack ? 0.72 : 0.52;
      ctx.lineWidth = 1.2;
      ctx.beginPath();
      ctx.moveTo(x + 1, y + height - 1);
      ctx.lineTo(x + width - 1, y + height - 1);
      ctx.stroke();
      ctx.restore();
    } else if (styleId === 'ivory' && !isBlack) {
      ctx.fillStyle = 'rgba(255,255,255,0.6)';
      ctx.fillRect(x + 1, y + 5, Math.max(1, width - 2), 1);
    }
  }

  function keyboardPreview(canvas, styleId, themeId) {
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    const palette = keyboard(normalizeKeyboard(styleId), styles[normalize(themeId)]);
    canvas.width = 640; canvas.height = 100;
    const whiteWidth = 32;
    ctx.fillStyle = palette.felt; ctx.fillRect(0, 0, 640, 5);
    for (let i = 0; i < 20; i++) {
      const x = i * whiteWidth;
      const grad = ctx.createLinearGradient(0, 5, 0, 100);
      grad.addColorStop(0, palette.white[0]); grad.addColorStop(0.85, palette.white[1]); grad.addColorStop(1, palette.white[2]);
      ctx.fillStyle = grad; ctx.fillRect(x, 5, whiteWidth, 95);
      ctx.strokeStyle = palette.border; ctx.strokeRect(x, 5, whiteWidth, 95);
      keyboardDetail(ctx, styleId, x, 5, whiteWidth, 95, false);
    }
    for (let i = 0; i < 19; i++) {
      if ([2, 6].includes(i % 7)) continue;
      const x = (i + 1) * whiteWidth - (styleId === 'ivory' ? 7 : 9);
      const blackWidth = styleId === 'ivory' ? 14 : 18;
      const grad = ctx.createLinearGradient(0, 5, 0, 67);
      grad.addColorStop(0, palette.black[0]); grad.addColorStop(0.18, palette.black[1]); grad.addColorStop(1, palette.black[2]);
      ctx.fillStyle = grad; ctx.fillRect(x, 5, blackWidth, 62);
      keyboardDetail(ctx, styleId, x, 5, blackWidth, 62, true);
    }
  }
  const rgba = (color, alpha) => `rgba(${color.join(',')},${alpha})`;
  const textures = new WeakMap();

  function texture(ctx, kind) {
    let cache = textures.get(ctx);
    if (!cache) { cache = {}; textures.set(ctx, cache); }
    if (cache[kind]) return cache[kind];
    const tile = document.createElement('canvas');
    tile.width = tile.height = 128;
    const brush = tile.getContext('2d');
    let seed = 71;
    const random = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
    for (let i = 0; i < (kind === 'wax' ? 2400 : 1600); i++) {
      const x = random() * 128, y = random() * 128;
      brush.fillStyle = kind === 'wax' ? `rgba(255,249,229,${0.15 + random() * 0.5})` : `rgba(99,81,61,${random() * 0.075})`;
      brush.fillRect(x, y, 0.4 + random() * 1.4, 0.4 + random());
    }
    cache[kind] = ctx.createPattern(tile, 'repeat');
    return cache[kind];
  }

  function paper(ctx, width, height) {
    ctx.fillStyle = texture(ctx, 'paper');
    ctx.fillRect(0, 0, width, height);
  }

  function note(ctx, styleId, x, y, width, height, color, velocity, active, seed = 0, motion = null) {
    styleId = normalize(styleId);
    ctx.save();
    // Eight drawings per second gives crayon a gentle stop-motion feel.
    // The caller freezes this clock on pause and omits motion when reduced.
    const sketchFrame = motion ? Math.floor(motion.time * 8) : 0;
    const phase = seed * 7.13 + sketchFrame * 1.73;
    if ((styleId === 'crayon' || styleId === 'sketch') && motion) {
      const sway = Math.min(0.8, width * 0.07);
      ctx.translate(Math.sin(phase) * sway, Math.cos(phase * 0.7) * 0.45);
    }
    const radius = Math.min(styleId === 'watercolor' ? 9 : 3, width / 2, height / 2);
    ctx.beginPath();
    if (styleId === 'crayon' || styleId === 'sketch') {
      const wobble = Math.sin(phase) * Math.min(1.1, width * 0.12);
      ctx.moveTo(x + 1, y + 1);
      ctx.lineTo(x + width - 1, y);
      ctx.lineTo(x + width + wobble, y + height * 0.35);
      ctx.lineTo(x + width - 0.5, y + height - 1);
      ctx.lineTo(x + 1, y + height);
      ctx.lineTo(x - wobble, y + height * 0.65);
      ctx.closePath();
    } else {
      ctx.roundRect(x, y, width, height, radius);
    }
    if (styleId === 'arcade') {
      ctx.fillStyle = rgba(color, active ? 1 : 0.82);
      ctx.fillRect(Math.round(x), Math.round(y), Math.ceil(width), Math.ceil(height));
      ctx.fillStyle = 'rgba(255,255,255,0.25)';
      ctx.fillRect(Math.round(x) + 2, Math.round(y) + 2, Math.max(1, width - 4), Math.min(3, height / 4));
      ctx.strokeStyle = rgba(color, 0.55);
      ctx.lineWidth = 2;
      ctx.strokeRect(Math.round(x) + 1, Math.round(y) + 1, Math.max(1, width - 2), Math.max(1, height - 2));
    } else if (styleId === 'neon') {
      ctx.fillStyle = rgba(color, active ? 0.34 : 0.13 + velocity * 0.12);
      ctx.fill();
      ctx.shadowColor = rgba(color, 0.9);
      ctx.shadowBlur = active ? 18 : 7;
      ctx.strokeStyle = rgba(color, 0.7 + velocity * 0.3);
      ctx.lineWidth = active ? 2 : 1.3;
      ctx.stroke();
    } else if (styleId === 'watercolor') {
      const wash = ctx.createLinearGradient(x, y, x + width, y + height);
      wash.addColorStop(0, rgba(color, 0.65));
      wash.addColorStop(0.38, rgba(color, 0.24 + velocity * 0.2));
      wash.addColorStop(1, rgba(color, active ? 0.8 : 0.6));
      ctx.fillStyle = wash;
      ctx.fill();
      ctx.strokeStyle = rgba(color, 0.36);
      ctx.lineWidth = 1.4;
      ctx.stroke();
      ctx.clip();
      ctx.fillStyle = rgba(color, 0.10);
      ctx.beginPath();
      ctx.ellipse(x + width * 0.65, y + height * 0.45, width * 0.6, height * 0.42, 0.18, 0, Math.PI * 2);
      ctx.fill();
      paper(ctx, x + width, y + height);
    } else if (styleId === 'sketch') {
      ctx.fillStyle = rgba(color, active ? 0.24 : 0.12);
      ctx.fill();
      ctx.strokeStyle = rgba(color, 0.83);
      ctx.lineWidth = 1.6;
      ctx.stroke();
      ctx.clip();
      ctx.strokeStyle = rgba(color, 0.34);
      ctx.lineWidth = 1;
      ctx.beginPath();
      const spacing = Math.max(7, (width + height * 2) / 120);
      for (let offset = -height; offset < width + height; offset += spacing) {
        const wobble = Math.sin(offset * 0.19 + phase) * (motion ? 1.4 : 0.5);
        ctx.moveTo(x + offset + wobble, y + height);
        ctx.lineTo(x + offset + height + wobble, y);
      }
      ctx.stroke();
      if (motion) {
        ctx.strokeStyle = rgba(color, 0.65);
        ctx.lineWidth = 1.2;
        ctx.beginPath();
        const penY = y + ((motion.time * 22 + seed * 13) % Math.max(height, 1));
        ctx.moveTo(x, penY); ctx.lineTo(x + width, penY - 2); ctx.stroke();
      }
    } else if (styleId === 'crayon') {
      // Notes are fully colored from their first frame.
      ctx.fillStyle = rgba(color, 0.18);
      ctx.fill();
      ctx.strokeStyle = rgba(color, 0.75);
      ctx.lineWidth = 1.5;
      ctx.stroke();
      ctx.clip();
      ctx.translate(x, y);
      ctx.fillStyle = rgba(color, 0.56 + velocity * 0.25);
      ctx.fillRect(-2, 0, width + 4, height);

      // Back-and-forth hatching gives the pigment its crayon texture.
      // Cap the stroke count so long MIDI notes remain cheap to render.
      const rows = Math.min(100, Math.max(2, Math.ceil(height / 4)));
      const spacing = height / rows;
      ctx.strokeStyle = rgba(color, 0.3);
      ctx.lineWidth = Math.min(2.2, Math.max(1, width * 0.12));
      ctx.lineJoin = 'round';
      ctx.beginPath();
      for (let row = 0; row <= rows; row++) {
        const strokeY = height - row * spacing;
        const drift = Math.sin(row * 2.1 + phase) * 1.2;
        ctx.moveTo(-1, strokeY + drift);
        ctx.lineTo(width + 1, strokeY - 2 + drift);
      }
      ctx.stroke();

      // Re-drawn grain shifts only a fraction of a pixel with each sketch.
      ctx.save();
      if (motion) ctx.translate(Math.sin(phase) * 0.6, Math.cos(phase) * 0.6);
      ctx.fillStyle = texture(ctx, 'wax');
      ctx.fillRect(-2, -2, width + 4, height + 4);
      ctx.restore();

      if (motion) {
        // A light moving stroke keeps the wax looking alive.
        const sweep = (motion.time * 0.7 + seed * 0.31) % 1;
        const tipY = height * (1 - sweep);
        const tipX = (0.5 + Math.sin(motion.time * 24 + seed) * 0.42) * width;
        ctx.strokeStyle = rgba(color, 0.38);
        ctx.lineWidth = Math.min(3, Math.max(1.2, width * 0.2));
        ctx.lineCap = 'round';
        ctx.beginPath();
        ctx.moveTo(Math.max(0, tipX - width * 0.35), tipY + 1);
        ctx.lineTo(Math.min(width, tipX + width * 0.35), tipY - 1);
        ctx.stroke();
      }
    } else {
      if (active) { ctx.shadowColor = rgba(color, 0.7); ctx.shadowBlur = 14; }
      const gloss = ctx.createLinearGradient(x, 0, x + width, 0);
      gloss.addColorStop(0, rgba(color, 0.55 + velocity * 0.4));
      gloss.addColorStop(1, rgba(color, 0.35 + velocity * 0.45));
      ctx.fillStyle = gloss;
      ctx.fill();
      ctx.shadowBlur = 0;
      ctx.strokeStyle = rgba(color, active ? 1 : 0.6);
      ctx.lineWidth = 1;
      ctx.stroke();
      ctx.fillStyle = 'rgba(255,255,255,0.22)';
      ctx.fillRect(x + 1, y + 1, Math.max(0, width - 2), Math.min(2, height / 4));
    }
    ctx.restore();
  }

  function preview(canvas, id) {
    const ctx = canvas.getContext('2d');
    const theme = styles[id];
    const width = 320, height = 140, keyY = 111;
    canvas.width = width * 2; canvas.height = height * 2;
    ctx.scale(2, 2);
    const bg = ctx.createLinearGradient(0, 0, 0, height);
    theme.background.forEach((color, i) => bg.addColorStop(i / 2, color));
    ctx.fillStyle = bg; ctx.fillRect(0, 0, width, height);
    if (theme.paper) paper(ctx, width, height);
    ctx.strokeStyle = theme.grid;
    for (let x = 0; x < width; x += 40) { ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, keyY); ctx.stroke(); }
    [[34,14,35,0], [75,48,66,1], [115,-9,40,2], [155,24,40,0], [195,73,43,2], [235,5,52,1], [275,57,30,3]].forEach(([x,y,h,c], i) => {
      note(ctx, id, x, y, 13, h, theme.colors[c], 0.85, y + h >= keyY, i);
    });
    for (let i = 0; i < 16; i++) {
      ctx.fillStyle = theme.white[1]; ctx.fillRect(i * 20, keyY, 19, 29);
      if ([0,1,3,4,5].includes(i % 7)) { ctx.fillStyle = theme.black[1]; ctx.fillRect(i * 20 + 14, keyY, 11, 17); }
    }
    ctx.fillStyle = theme.accent; ctx.fillRect(0, keyY, width, 2);
  }

  window.PianoStyles = { styles, normalize, keyboardStyles, normalizeKeyboard, keyboard, keyboardDetail, keyboardPreview, note, paper, preview };
})();
