/* KiLive — dependency-free WebGL2 board viewer */
(function () {
  'use strict';
  const N = window.Noeti;

  // ---------------------------------------------------------------- math
  const M = {
    persp(fovy, aspect, near, far) {
      const f = 1 / Math.tan(fovy / 2), nf = 1 / (near - far);
      return new Float32Array([f / aspect, 0, 0, 0, 0, f, 0, 0, 0, 0, (far + near) * nf, -1, 0, 0, 2 * far * near * nf, 0]);
    },
    lookAt(e, c, u) {
      let zx = e[0] - c[0], zy = e[1] - c[1], zz = e[2] - c[2];
      let l = Math.hypot(zx, zy, zz); zx /= l; zy /= l; zz /= l;
      let xx = u[1] * zz - u[2] * zy, xy = u[2] * zx - u[0] * zz, xz = u[0] * zy - u[1] * zx;
      l = Math.hypot(xx, xy, xz) || 1; xx /= l; xy /= l; xz /= l;
      const yx = zy * xz - zz * xy, yy = zz * xx - zx * xz, yz = zx * xy - zy * xx;
      return new Float32Array([xx, yx, zx, 0, xy, yy, zy, 0, xz, yz, zz, 0,
        -(xx * e[0] + xy * e[1] + xz * e[2]), -(yx * e[0] + yy * e[1] + yz * e[2]), -(zx * e[0] + zy * e[1] + zz * e[2]), 1]);
    },
    mul(a, b) {
      const o = new Float32Array(16);
      for (let i = 0; i < 4; i++) for (let j = 0; j < 4; j++) {
        let s = 0;
        for (let k = 0; k < 4; k++) s += a[k * 4 + j] * b[i * 4 + k];
        o[i * 4 + j] = s;
      }
      return o;
    },
    inv(m) {
      const inv = new Float32Array(16);
      inv[0] = m[5] * m[10] * m[15] - m[5] * m[11] * m[14] - m[9] * m[6] * m[15] + m[9] * m[7] * m[14] + m[13] * m[6] * m[11] - m[13] * m[7] * m[10];
      inv[4] = -m[4] * m[10] * m[15] + m[4] * m[11] * m[14] + m[8] * m[6] * m[15] - m[8] * m[7] * m[14] - m[12] * m[6] * m[11] + m[12] * m[7] * m[10];
      inv[8] = m[4] * m[9] * m[15] - m[4] * m[11] * m[13] - m[8] * m[5] * m[15] + m[8] * m[7] * m[13] + m[12] * m[5] * m[11] - m[12] * m[7] * m[9];
      inv[12] = -m[4] * m[9] * m[14] + m[4] * m[10] * m[13] + m[8] * m[5] * m[14] - m[8] * m[6] * m[13] - m[12] * m[5] * m[10] + m[12] * m[6] * m[9];
      inv[1] = -m[1] * m[10] * m[15] + m[1] * m[11] * m[14] + m[9] * m[2] * m[15] - m[9] * m[3] * m[14] - m[13] * m[2] * m[11] + m[13] * m[3] * m[10];
      inv[5] = m[0] * m[10] * m[15] - m[0] * m[11] * m[14] - m[8] * m[2] * m[15] + m[8] * m[3] * m[14] + m[12] * m[2] * m[11] - m[12] * m[3] * m[10];
      inv[9] = -m[0] * m[9] * m[15] + m[0] * m[11] * m[13] + m[8] * m[1] * m[15] - m[8] * m[3] * m[13] - m[12] * m[1] * m[11] + m[12] * m[3] * m[9];
      inv[13] = m[0] * m[9] * m[14] - m[0] * m[10] * m[13] - m[8] * m[1] * m[14] + m[8] * m[2] * m[13] + m[12] * m[1] * m[10] - m[12] * m[2] * m[9];
      inv[2] = m[1] * m[6] * m[15] - m[1] * m[7] * m[14] - m[5] * m[2] * m[15] + m[5] * m[3] * m[14] + m[13] * m[2] * m[7] - m[13] * m[3] * m[6];
      inv[6] = -m[0] * m[6] * m[15] + m[0] * m[7] * m[14] + m[4] * m[2] * m[15] - m[4] * m[3] * m[14] - m[12] * m[2] * m[7] + m[12] * m[3] * m[6];
      inv[10] = m[0] * m[5] * m[15] - m[0] * m[7] * m[13] - m[4] * m[1] * m[15] + m[4] * m[3] * m[13] + m[12] * m[1] * m[7] - m[12] * m[3] * m[5];
      inv[14] = -m[0] * m[5] * m[14] + m[0] * m[6] * m[13] + m[4] * m[1] * m[14] - m[4] * m[2] * m[13] - m[12] * m[1] * m[6] + m[12] * m[2] * m[5];
      inv[3] = -m[1] * m[6] * m[11] + m[1] * m[7] * m[10] + m[5] * m[2] * m[11] - m[5] * m[3] * m[10] - m[9] * m[2] * m[7] + m[9] * m[3] * m[6];
      inv[7] = m[0] * m[6] * m[11] - m[0] * m[7] * m[10] - m[4] * m[2] * m[11] + m[4] * m[3] * m[10] + m[8] * m[2] * m[7] - m[8] * m[3] * m[6];
      inv[11] = -m[0] * m[5] * m[11] + m[0] * m[7] * m[9] + m[4] * m[1] * m[11] - m[4] * m[3] * m[9] - m[8] * m[1] * m[7] + m[8] * m[3] * m[5];
      inv[15] = m[0] * m[5] * m[10] - m[0] * m[6] * m[9] - m[4] * m[1] * m[10] + m[4] * m[2] * m[9] + m[8] * m[1] * m[6] - m[8] * m[2] * m[5];
      let det = m[0] * inv[0] + m[1] * inv[4] + m[2] * inv[8] + m[3] * inv[12];
      if (!det) return inv;
      det = 1 / det;
      for (let i = 0; i < 16; i++) inv[i] *= det;
      return inv;
    },
    ortho(l, r, b, t, n, f) { return new Float32Array([2 / (r - l), 0, 0, 0, 0, 2 / (t - b), 0, 0, 0, 0, -2 / (f - n), 0, -(r + l) / (r - l), -(t + b) / (t - b), -(f + n) / (f - n), 1]); },
    xform(m, v) {
      const x = v[0], y = v[1], z = v[2], w = v[3] == null ? 1 : v[3];
      return [m[0] * x + m[4] * y + m[8] * z + m[12] * w, m[1] * x + m[5] * y + m[9] * z + m[13] * w, m[2] * x + m[6] * y + m[10] * z + m[14] * w, m[3] * x + m[7] * y + m[11] * z + m[15] * w];
    },
  };

  const ID4 = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
  const OUTSIDE4 = new Float32Array([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 10, 0, 0, 1]);
  const hex = h => { const n = parseInt(h.slice(1), 16); return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255]; };

  // ---------------------------------------------------------------- shaders
  const COMMON = `
  uniform vec3 uEye, uKeyDir, uKeyCol, uFillDir, uFillCol, uSky, uGround, uUp;
  uniform float uSpec;
  vec3 shade(vec3 base, vec3 N, vec3 P, float metal, float rough) {
    vec3 V = normalize(uEye - P);
    if (dot(N, V) < 0.0) N = -N;
    vec3 L = normalize(uKeyDir);
    float ndl = max(dot(N, L), 0.0);
    float hemi = 0.5 + 0.5 * dot(N, uUp);
    vec3 amb = mix(uGround, uSky, hemi);
    vec3 R = reflect(-V, N);
    vec3 env = mix(uGround * 0.8, uSky * 1.15, smoothstep(-0.4, 0.8, dot(R, uUp)));
    vec3 diff = base * (amb * (1.0 - metal * 0.55) + uKeyCol * ndl * (1.0 - metal * 0.5) + uFillCol * max(dot(N, normalize(uFillDir)), 0.0));
    vec3 H = normalize(L + V);
    float sh = mix(140.0, 10.0, rough);
    float spec = pow(max(dot(N, H), 0.0), sh) * mix(0.9, 0.12, rough) * uSpec;
    float fres = pow(1.0 - max(dot(N, V), 0.0), 5.0);
    vec3 specCol = mix(vec3(1.0), base, metal);
    vec3 col = diff + base * env * metal * 0.9 + specCol * uKeyCol * spec + env * fres * (0.04 + 0.2 * (1.0 - rough)) * uSpec;
    return col;
  }`;

  const VS_MESH = `#version 300 es
  precision highp float;
  layout(location=0) in vec3 aPos;
  layout(location=1) in vec3 aNrm;
  layout(location=2) in vec3 iPos;
  layout(location=3) in vec3 iSize;
  layout(location=4) in float iRot;
  layout(location=5) in vec3 iCol;
  layout(location=6) in vec3 iMat;
  uniform mat4 uVP;
  out vec3 vP; out vec3 vN; out vec3 vCol; out vec3 vMat; out vec3 vLocal;
  void main() {
    vec3 p = aPos * iSize;
    float c = cos(iRot), s = sin(iRot);
    vec3 pr = vec3(p.x * c + p.z * s, p.y, -p.x * s + p.z * c);
    vec3 n = normalize(aNrm / iSize);
    vec3 nr = vec3(n.x * c + n.z * s, n.y, -n.x * s + n.z * c);
    vP = pr + iPos; vN = nr; vCol = iCol; vMat = iMat; vLocal = aPos;
    gl_Position = uVP * vec4(vP, 1.0);
  }`;
  const FS_MESH = `#version 300 es
  precision highp float;
  in vec3 vP; in vec3 vN; in vec3 vCol; in vec3 vMat; in vec3 vLocal;
  out vec4 o;
  ${COMMON}
  void main() {
    vec3 base = vCol;
    // subtle top-edge darkening so boxes read as solid bodies
    float edge = max(abs(vLocal.x), abs(vLocal.z));
    bool glow = vMat.z > 1.5;
    if (!glow && vMat.z > 0.5) base = mix(base, vec3(1.0, 0.82, 0.12), 0.5);
    vec3 col = shade(base, normalize(vN), vP, vMat.x, vMat.y);
    if (!glow && vMat.z > 0.5) col += vec3(0.16, 0.12, 0.0);
    if (glow) col = mix(col, vCol * 1.3 + vec3(0.12), 0.85);
    col *= 1.0 - 0.10 * smoothstep(0.42, 0.5, edge) * step(0.99, vLocal.y);
    o = vec4(pow(col, vec3(1.0 / 1.08)), 1.0);
  }`;

  const VS_FACE = `#version 300 es
  precision highp float;
  layout(location=0) in vec3 aPos;
  layout(location=1) in vec2 aUV;
  uniform mat4 uVP;
  out vec2 vUV; out vec3 vP;
  void main() { vUV = aUV; vP = aPos; gl_Position = uVP * vec4(aPos, 1.0); }`;
  const FS_FACE = `#version 300 es
  precision highp float;
  in vec2 vUV; in vec3 vP;
  uniform sampler2D uTex; uniform sampler2D uMatTex; uniform vec3 uNormal; uniform float uBlend;
  out vec4 o;
  ${COMMON}
  void main() {
    vec4 t = texture(uTex, vUV);
    if (uBlend < 0.5 && t.a < 0.5) discard;
    if (uBlend > 0.5 && t.a < 0.02) discard;
    vec3 m = texture(uMatTex, vUV).rgb;
    float metal = m.r;
    float rough = mix(0.18, 0.95, m.g);
    vec3 col = uBlend > 0.5 ? t.rgb : shade(t.rgb, uNormal, vP, metal, rough);
    o = vec4(pow(col, vec3(1.0 / 1.08)), uBlend > 0.5 ? t.a : 1.0);
  }`;

  function compile(gl, vs, fs) {
    const p = gl.createProgram();
    for (const [type, src] of [[gl.VERTEX_SHADER, vs], [gl.FRAGMENT_SHADER, fs]]) {
      const s = gl.createShader(type);
      gl.shaderSource(s, src);
      gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error('Shader: ' + gl.getShaderInfoLog(s));
      gl.attachShader(p, s);
    }
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error('Link: ' + gl.getProgramInfoLog(p));
    const u = {};
    const n = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS);
    for (let i = 0; i < n; i++) { const info = gl.getActiveUniform(p, i); u[info.name] = gl.getUniformLocation(p, info.name); }
    return { p, u };
  }

  // unit box: x,z in [-.5,.5], y in [0,1]
  function boxGeom() {
    const P = [], Nn = [];
    const faces = [
      [[0, 1, 0], [[-.5, 1, -.5], [-.5, 1, .5], [.5, 1, .5], [.5, 1, -.5]]],
      [[0, -1, 0], [[-.5, 0, -.5], [.5, 0, -.5], [.5, 0, .5], [-.5, 0, .5]]],
      [[1, 0, 0], [[.5, 0, -.5], [.5, 1, -.5], [.5, 1, .5], [.5, 0, .5]]],
      [[-1, 0, 0], [[-.5, 0, -.5], [-.5, 0, .5], [-.5, 1, .5], [-.5, 1, -.5]]],
      [[0, 0, 1], [[-.5, 0, .5], [.5, 0, .5], [.5, 1, .5], [-.5, 1, .5]]],
      [[0, 0, -1], [[-.5, 0, -.5], [-.5, 1, -.5], [.5, 1, -.5], [.5, 0, -.5]]],
    ];
    for (const [n, q] of faces) for (const i of [0, 1, 2, 0, 2, 3]) { P.push(...q[i]); Nn.push(...n); }
    return { pos: new Float32Array(P), nrm: new Float32Array(Nn), count: 36 };
  }
  function cylGeom(seg = 24) {
    const P = [], Nn = [];
    for (let i = 0; i < seg; i++) {
      const a0 = i / seg * Math.PI * 2, a1 = (i + 1) / seg * Math.PI * 2;
      const x0 = Math.cos(a0) * .5, z0 = Math.sin(a0) * .5, x1 = Math.cos(a1) * .5, z1 = Math.sin(a1) * .5;
      const n0 = [Math.cos(a0), 0, Math.sin(a0)], n1 = [Math.cos(a1), 0, Math.sin(a1)];
      P.push(x0, 0, z0, x1, 0, z1, x1, 1, z1, x0, 0, z0, x1, 1, z1, x0, 1, z0);
      Nn.push(...n0, ...n1, ...n1, ...n0, ...n1, ...n0);
      P.push(0, 1, 0, x0, 1, z0, x1, 1, z1); Nn.push(0, 1, 0, 0, 1, 0, 0, 1, 0);
      P.push(0, 0, 0, x1, 0, z1, x0, 0, z0); Nn.push(0, -1, 0, 0, -1, 0, 0, -1, 0);
    }
    return { pos: new Float32Array(P), nrm: new Float32Array(Nn), count: P.length / 3 };
  }

  const LIGHTS = {
    studio: { sky: '#e9edf3', ground: '#5d6470', key: '#ffffff', keyI: 0.78, fill: '#b9c6ff', fillI: 0.22, spec: 1.0, keyDir: [-0.35, 0.75, 0.55], fillDir: [0.75, 0.1, 0.3] },
    bench: { sky: '#f3e6cf', ground: '#4b4038', key: '#ffe6bd', keyI: 0.95, fill: '#8fb0ff', fillI: 0.18, spec: 1.1, keyDir: [-0.7, 0.6, 0.35], fillDir: [0.8, 0.2, 0.2] },
    inspect: { sky: '#ffffff', ground: '#c9ced6', key: '#ffffff', keyI: 0.35, fill: '#ffffff', fillI: 0.15, spec: 0.35, keyDir: [0, 0.3, 1], fillDir: [0, 0.8, 0.5] },
    night: { sky: '#6a7a99', ground: '#1b1e26', key: '#dfe8ff', keyI: 0.9, fill: '#5ad1b0', fillI: 0.35, spec: 1.2, keyDir: [0.6, 0.7, 0.3], fillDir: [-0.9, 0.2, -0.4] },
  };

  // the same studio as the photo renderer, per light mode. key: [right, forward, up] relative to the camera
  const REAL = {
    studio: { key: [-0.62, -0.32, 1.05], keyCol: [2.55, 2.47, 2.36], keyAng: 0.11, envK: 1, tint: [1, 1, 1], exposure: 1.0, soft: 0.45 },
    bench: { key: [-1.0, 0.15, 0.62], keyCol: [3.1, 2.5, 1.75], keyAng: 0.06, envK: 0.62, tint: [1.06, 0.95, 0.8], exposure: 1.0, soft: 0.25 },
    inspect: { key: [0.0, -0.25, 1.0], keyCol: [1.15, 1.15, 1.15], keyAng: 0.2, envK: 1.55, tint: [1, 1, 1], exposure: 1.05, shadow: false },
    night: { key: [0.7, 0.25, 0.8], keyCol: [0.75, 0.95, 1.45], keyAng: 0.08, envK: 0.2, tint: [0.72, 0.84, 1.12], exposure: 1.15, soft: 0.3 },
  };
  REAL.photo = REAL.studio;
  const VS_DEPTH = `#version 300 es
  precision highp float;
  layout(location=0) in vec3 aPos; uniform mat4 uLVP;
  void main() { gl_Position = uLVP * vec4(aPos, 1.0); }`;
  const FS_DEPTH = `#version 300 es
  precision highp float;
  void main() {}`;
  const VS_DEPTHF = `#version 300 es
  precision highp float;
  layout(location=0) in vec3 aPos; layout(location=1) in vec2 aUV; uniform mat4 uLVP; out vec2 vUV;
  void main() { vUV = aUV; gl_Position = uLVP * vec4(aPos, 1.0); }`;
  const FS_DEPTHF = `#version 300 es
  precision highp float;
  in vec2 vUV; uniform sampler2D uTex;
  void main() { if (texture(uTex, vUV).a < 0.5) discard; }`;
  // the live overlay: board millimetres (centred) -> the current cut of the overlay texture
  const VS_OVL = `#version 300 es
  precision highp float;
  layout(location=0) in vec3 aPos;
  uniform mat4 uVP; uniform vec4 uRect;
  out vec2 vUV;
  void main() { vUV = (aPos.xz - uRect.xy) * uRect.zw; gl_Position = uVP * vec4(aPos, 1.0); }`;
  const FS_OVL = `#version 300 es
  precision highp float;
  in vec2 vUV; uniform sampler2D uTex;
  out vec4 o;
  void main() {
    if (vUV.x < 0.0 || vUV.y < 0.0 || vUV.x > 1.0 || vUV.y > 1.0) discard;
    vec4 t = texture(uTex, vUV);
    if (t.a < 0.02) discard;
    o = t;
  }`;
  // board faces under the studio light: glossy clear-coated mask, rough silk, metal pads (from the baked colour + material maps)
  const fsFaceReal = LIGHTING => `#version 300 es
  precision highp float;
  in vec2 vUV; in vec3 vP;
  uniform sampler2D uTex, uMatTex; uniform vec3 uNormal;
  out vec4 o;
  ${LIGHTING}
  void main() {
    vec4 t = texture(uTex, vUV);
    if (t.a < 0.5) discard;
    vec3 m = texture(uMatTex, vUV).rgb;
    float metal = m.r;
    float coat = (1.0 - metal) * (1.0 - smoothstep(0.45, 0.65, m.g));
    float rough = metal > 0.5 ? mix(0.12, 0.6, m.g) : mix(0.5, 0.85, smoothstep(0.35, 0.8, m.g));
    vec3 n = uNormal;
    vec3 q = vec3(vUV * 900.0, uNormal.y);
    n.xz += (vec2(vnoise(q), vnoise(q + 17.0)) - 0.5) * 0.03 * (0.3 + coat);
    o = vec4(tonemap(shade(pow(t.rgb, vec3(2.2)), normalize(n), vP, metal, rough, coat, 1.0)), 1.0);
  }`;

  // a half-size copy of a canvas (material maps need far less detail than colour)
  let halfCv = null;
  function halfCanvas(src) {
    if (!src || src.width < 512) return src;
    const c = halfCv || (halfCv = document.createElement('canvas'));
    const w = Math.ceil(src.width / 2), h = Math.ceil(src.height / 2);
    if (c.width !== w || c.height !== h) { c.width = w; c.height = h; }
    const g = c.getContext('2d'); g.imageSmoothingEnabled = true; g.imageSmoothingQuality = 'medium';
    g.clearRect(0, 0, w, h); g.drawImage(src, 0, 0, w, h);
    return c;
  }
  class Viewer3D {
    constructor(host) {
      this.host = host;
      this.canvas = N.el('canvas', { class: 'gl-canvas', 'aria-label': '3D board view. Drag to orbit, right-drag to pan, scroll to zoom.' });
      host.append(this.canvas);
      const gl = (this.gl = this.canvas.getContext('webgl2', { antialias: true, alpha: true, premultipliedAlpha: true, preserveDrawingBuffer: !!host.dataset.snapshot }));
      if (!gl) throw new Error('WebGL2 is not available in this browser.');
      this.mesh = compile(gl, VS_MESH, FS_MESH);
      this.face = compile(gl, VS_FACE, FS_FACE);
      this.box = this.makeGeomVAO(boxGeom());
      this.cyl = this.makeGeomVAO(cylGeom());
      this.real = null;
      try { if (N.photoKit) this.initReal(); } catch (e) { console.warn('3D: realistic parts unavailable,', e.message || e); this.real = null; }
      // software rasterisers (no GPU) get the simple shapes unless asked otherwise
      const dbg = gl.getExtension('WEBGL_debug_renderer_info');
      this.renderer = String((dbg && gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL)) || gl.getParameter(gl.RENDERER) || '');
      this.software = /swiftshader|llvmpipe|softpipe|software|basic render/i.test(this.renderer);
      this.realOn = !!this.real && !this.software;
      this.realAuto = true;
      this.cam = { yaw: 0, pitch: 42 * Math.PI / 180, dist: 200, target: [0, 0, 0], fov: 32 * Math.PI / 180 };
      this.light = 'studio';
      this.assembled = true;
      this.showRuler = false;
      this.hl = { refs: new Set(), nets: new Set() };
      this.listeners = {};
      this.dirty = true;
      this.bindInput();
      this.ro = new ResizeObserver(() => { this.resize(); });
      this.ro.observe(host);
      this.resize();
      this.loop = this.loop.bind(this);
      this.raf = requestAnimationFrame(this.loop);
    }
    on(ev, fn) { (this.listeners[ev] = this.listeners[ev] || []).push(fn); }
    emit(ev, d) { (this.listeners[ev] || []).forEach(f => f(d)); }

    makeGeomVAO(g) {
      const gl = this.gl;
      const vao = gl.createVertexArray();
      gl.bindVertexArray(vao);
      const b0 = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, b0); gl.bufferData(gl.ARRAY_BUFFER, g.pos, gl.STATIC_DRAW);
      gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 0, 0);
      const b1 = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, b1); gl.bufferData(gl.ARRAY_BUFFER, g.nrm, gl.STATIC_DRAW);
      gl.enableVertexAttribArray(1); gl.vertexAttribPointer(1, 3, gl.FLOAT, false, 0, 0);
      const inst = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, inst);
      const stride = 14 * 4;
      const layout = [[2, 3, 0], [3, 3, 3], [4, 1, 6], [5, 3, 7], [6, 3, 10]];
      for (const [loc, size, off] of layout) {
        gl.enableVertexAttribArray(loc);
        gl.vertexAttribPointer(loc, size, gl.FLOAT, false, stride, off * 4);
        gl.vertexAttribDivisor(loc, 1);
      }
      gl.bindVertexArray(null);
      return { vao, inst, count: g.count, n: 0, data: null, b0, b1 };
    }

    setInstances(geo, arr) {
      const gl = this.gl;
      geo.data = arr;
      geo.n = arr.length / 14;
      gl.bindBuffer(gl.ARRAY_BUFFER, geo.inst);
      gl.bufferData(gl.ARRAY_BUFFER, arr, gl.DYNAMIC_DRAW);
    }

    // custom (non-instanced geometry) drawn through the instanced shader with one identity instance
    makeStatic(pos, nrm, color, mat) {
      const g = this.makeGeomVAO({ pos: new Float32Array(pos), nrm: new Float32Array(nrm), count: pos.length / 3 });
      const c = hex(color);
      this.setInstances(g, new Float32Array([0, 0, 0, 1, 1, 1, 0, c[0], c[1], c[2], mat[0], mat[1], 0, 0]));
      return g;
    }

    faceQuad(x0, z0, x1, z1, y, down) {
      const gl = this.gl;
      const vao = gl.createVertexArray();
      gl.bindVertexArray(vao);
      // uv: u along x, v along z (board y)
      const v = down
        ? [x0, y, z0, 0, 0, x1, y, z1, 1, 1, x1, y, z0, 1, 0, x0, y, z0, 0, 0, x0, y, z1, 0, 1, x1, y, z1, 1, 1]
        : [x0, y, z0, 0, 0, x1, y, z0, 1, 0, x1, y, z1, 1, 1, x0, y, z0, 0, 0, x1, y, z1, 1, 1, x0, y, z1, 0, 1];
      const b = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, b);
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(v), gl.STATIC_DRAW);
      gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 20, 0);
      gl.enableVertexAttribArray(1); gl.vertexAttribPointer(1, 2, gl.FLOAT, false, 20, 12);
      gl.bindVertexArray(null);
      return { vao, buf: b };
    }

    texFrom(canvas, tex) {
      const gl = this.gl;
      tex = tex || gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, canvas);
      gl.generateMipmap(gl.TEXTURE_2D);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      const ext = gl.getExtension('EXT_texture_filter_anisotropic');
      if (ext) gl.texParameterf(gl.TEXTURE_2D, ext.TEXTURE_MAX_ANISOTROPY_EXT, Math.min(8, gl.getParameter(ext.MAX_TEXTURE_MAX_ANISOTROPY_EXT)));
      return tex;
    }

    // ---------------------------------------------------------- realistic parts (the photo renderer's meshes and materials)
    initReal() {
      const gl = this.gl, K = N.photoKit;
      const R = { gen: 0 };
      // shadow map (hardware-filtered depth compare)
      const SM = (R.SM = Math.min(2048, gl.getParameter(gl.MAX_TEXTURE_SIZE)));
      R.shTex = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, R.shTex);
      gl.texStorage2D(gl.TEXTURE_2D, 1, gl.DEPTH_COMPONENT24, SM, SM);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_COMPARE_MODE, gl.COMPARE_REF_TO_TEXTURE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_COMPARE_FUNC, gl.LEQUAL);
      R.shFbo = gl.createFramebuffer();
      gl.bindFramebuffer(gl.FRAMEBUFFER, R.shFbo);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.TEXTURE_2D, R.shTex, 0);
      gl.drawBuffers([gl.NONE]); gl.readBuffer(gl.NONE);
      R.shadows = gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE;
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      const def = src => K.define(src, R.shadows ? 'FAST_SHADOW' : 'NO_SHADOW');
      R.mesh = K.compile(gl, K.VS_MESH, def(K.FS_MESH));
      R.face = K.compile(gl, VS_FACE, def(fsFaceReal(K.LIGHTING)));
      R.depth = K.compile(gl, VS_DEPTH, FS_DEPTH);
      R.depthF = K.compile(gl, VS_DEPTHF, FS_DEPTHF);
      R.stateTex = gl.createTexture();
      this.real = R;
    }
    buildReal() {
      const R = this.real;
      if (!R) return;
      const gl = this.gl, K = N.photoKit;
      this.disposeRealMesh();
      try {
        const t0 = performance.now();
        const P = K.parts(this.B, this.t, this.center[0], this.center[1]);
        R.vao = K.meshVAO(gl, P.M);
        R.partsCount = P.partsCount;
        R.atlas = K.tex(gl, P.atlas);
        R.yr = [Math.min(-this.t / 2, P.M.minY), Math.max(this.t / 2, P.M.maxY)];
        // per-part state for the shader: RGB the colour a lit LED shows, A flags (1 selected, 2 lit)
        const n = Math.max(1, this.B.fps.length);
        R.sw = 1024; R.sh = Math.ceil(n / 1024);
        R.state = new Uint8Array(R.sw * R.sh * 4);
        this.B.fps.forEach((f, fi) => { if (this.hl.refs.has(f.r)) R.state[fi * 4 + 3] = 1; });
        R.stateDirty = true;
        R.gen++; R.shKey = null;
        R.ms = performance.now() - t0;
        R.tris = P.M.I.length / 3;
      } catch (e) {
        console.warn('3D: could not build realistic parts,', e.message || e);
        this.disposeRealMesh();
      }
    }
    // realistic parts on/off (user = an explicit choice: no automatic fallback afterwards)
    setReal(on, user) {
      on = !!on && !!this.real;
      if (user) this.realAuto = false;
      if (on && this.real.shadowOff && user) { this.real.shadowOff = false; this.real.shKey = null; }
      this.realOn = on;
      if (on && this.B && !this.real.vao) this.buildReal();
      if (on && this.live) { for (const d of this.live.leds || []) d._q3 = undefined; this._pixQ = null; this.liveLeds(this.live); }
      this._spd = [];
      this.dirty = true;
    }
    disposeRealMesh() {
      const R = this.real, gl = this.gl;
      if (!R || !R.vao) return;
      gl.deleteVertexArray(R.vao.vao);
      for (const b of R.vao.bufs) gl.deleteBuffer(b);
      if (R.atlas) gl.deleteTexture(R.atlas);
      R.vao = null; R.atlas = null; R.state = null;
    }
    // a part's look in the realistic view: selected and/or glowing with an RGB colour (0..1)
    partState(fi, sel, glow) {
      const R = this.real;
      if (!R || !R.state || fi < 0 || fi * 4 + 3 >= R.state.length) return;
      const o = fi * 4;
      if (glow) { R.state[o] = Math.round(Math.min(1, glow[0]) * 255); R.state[o + 1] = Math.round(Math.min(1, glow[1]) * 255); R.state[o + 2] = Math.round(Math.min(1, glow[2]) * 255); }
      R.state[o + 3] = (sel ? 1 : 0) | (glow ? 2 : 0);
      R.stateDirty = true;
    }
    realLight() {
      const c = this.cam, L = REAL[this.light] || REAL.studio, s = c.pitch >= 0 ? 1 : -1;
      const camF = [-Math.sin(c.yaw), 0, -Math.cos(c.yaw)], camR = [Math.cos(c.yaw), 0, -Math.sin(c.yaw)];
      const k = [0, 1, 2].map(i => camR[i] * L.key[0] + camF[i] * L.key[1] + (i === 1 ? L.key[2] * s : 0));
      const kl = Math.hypot(k[0], k[1], k[2]) || 1;
      return { L, s, camF, camR, keyDir: k.map(v => v / kl) };
    }
    // orthographic depth along the key light, re-rendered only when the light (it rides with the camera) or the scene changes
    shadowPass(R, lt) {
      const gl = this.gl, bb = this.B.bbox, [cx, cy] = this.center;
      const xs = [bb[0] - cx, bb[2] - cx], zs = [bb[1] - cy, bb[3] - cy], ys = R.yr;
      const corners = [];
      for (const x of xs) for (const y of ys) for (const z of zs) corners.push([x, y, z]);
      const lc = [(xs[0] + xs[1]) / 2, (ys[0] + ys[1]) / 2, (zs[0] + zs[1]) / 2], kd = lt.keyDir;
      const lview = M.lookAt([lc[0] + kd[0] * 1000, lc[1] + kd[1] * 1000, lc[2] + kd[2] * 1000], lc, Math.abs(kd[1]) > 0.99 ? [0, 0, 1] : [0, 1, 0]);
      let x0 = 1e9, x1 = -1e9, y0 = 1e9, y1 = -1e9, z0 = 1e9, z1 = -1e9;
      for (const c of corners) { const p = M.xform(lview, [c[0], c[1], c[2], 1]); x0 = Math.min(x0, p[0]); x1 = Math.max(x1, p[0]); y0 = Math.min(y0, p[1]); y1 = Math.max(y1, p[1]); z0 = Math.min(z0, -p[2]); z1 = Math.max(z1, -p[2]); }
      const mx = (x1 - x0) * 0.03 + 1, my = (y1 - y0) * 0.03 + 1;
      R.LVP = M.mul(M.ortho(x0 - mx, x1 + mx, y0 - my, y1 + my, z0 - 5, z1 + 5), lview);
      R.lw = Math.max(x1 - x0 + 2 * mx, y1 - y0 + 2 * my);
      R.depthRange = z1 - z0 + 10;
      gl.bindFramebuffer(gl.FRAMEBUFFER, R.shFbo);
      gl.viewport(0, 0, R.SM, R.SM);
      gl.clearDepth(1); gl.clear(gl.DEPTH_BUFFER_BIT);
      gl.enable(gl.DEPTH_TEST); gl.depthMask(true);
      gl.enable(gl.POLYGON_OFFSET_FILL); gl.polygonOffset(1.5, 3.0);
      gl.useProgram(R.depth.p); gl.uniformMatrix4fv(R.depth.u.uLVP, false, R.LVP);
      gl.bindVertexArray(R.vao.vao);
      if (this.assembled) gl.drawElements(gl.TRIANGLES, R.vao.count, gl.UNSIGNED_INT, 0);
      else gl.drawElements(gl.TRIANGLES, R.vao.count - R.partsCount, gl.UNSIGNED_INT, R.partsCount * 4);
      gl.useProgram(R.depthF.p); gl.uniformMatrix4fv(R.depthF.u.uLVP, false, R.LVP); gl.uniform1i(R.depthF.u.uTex, 0);
      gl.activeTexture(gl.TEXTURE0);
      for (const [q, tx] of [[this.topQuad, this.gTop], [this.botQuad, this.gBot]]) { gl.bindTexture(gl.TEXTURE_2D, tx); gl.bindVertexArray(q.vao); gl.drawArrays(gl.TRIANGLES, 0, 6); }
      gl.disable(gl.POLYGON_OFFSET_FILL);
      gl.bindVertexArray(null);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    }
    realUniforms(pr, eye, vp, lt, sh) {
      const gl = this.gl, u = pr.u, L = lt.L, R = this.real;
      gl.uniformMatrix4fv(u.uVP, false, vp);
      if (u.uModel) gl.uniformMatrix4fv(u.uModel, false, ID4);
      gl.uniform3fv(u.uEye, eye); gl.uniform3fv(u.uCamF, lt.camF); gl.uniform3fv(u.uCamR, lt.camR);
      gl.uniform3fv(u.uKeyDir, lt.keyDir); gl.uniform3fv(u.uKeyCol, L.keyCol);
      gl.uniform1f(u.uKeyAng, L.keyAng); gl.uniform1f(u.uSbEl, Math.min(1.35, Math.max(0.3, Math.abs(this.cam.pitch) + 0.16)));
      gl.uniform1f(u.uExposure, L.exposure); gl.uniform1f(u.uCoatRough, 0.16);
      gl.uniform1f(u.uEnvK, L.envK); gl.uniform1f(u.uUpS, lt.s); gl.uniform3fv(u.uEnvTint, L.tint);
      if (u.uShadowC) {
        gl.activeTexture(gl.TEXTURE7); gl.bindTexture(gl.TEXTURE_2D, R.shTex); gl.uniform1i(u.uShadowC, 7);
        if (sh) {
          gl.uniformMatrix4fv(u.uLVP, false, R.LVP);
          gl.uniform1f(u.uBias, 0.04 / R.depthRange);
          gl.uniform1f(u.uNormOff, R.lw / R.SM * 1.5);
          gl.uniform1f(u.uSearch, Math.max(1.5 / R.SM, (L.soft || 0.4) / R.lw));
        } else {
          // no shadow this frame: a light matrix that puts everything outside the map
          gl.uniformMatrix4fv(u.uLVP, false, OUTSIDE4);
        }
      }
    }
    renderReal(vp, eye) {
      const gl = this.gl, R = this.real, lt = this.realLight();
      const sh = R.shadows && !R.shadowOff && lt.L.shadow !== false;
      if (sh) {
        const key = lt.keyDir.map(v => v.toFixed(4)).join() + '|' + this.assembled + '|' + R.gen;
        if (key !== R.shKey) { this.shadowPass(R, lt); R.shKey = key; }
      }
      if (R.stateDirty && R.state) {
        gl.activeTexture(gl.TEXTURE2);
        gl.bindTexture(gl.TEXTURE_2D, R.stateTex);
        gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, R.sw, R.sh, 0, gl.RGBA, gl.UNSIGNED_BYTE, R.state);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
        R.stateDirty = false;
      }
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.viewport(0, 0, this.canvas.width, this.canvas.height);
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
      gl.enable(gl.DEPTH_TEST);
      gl.disable(gl.CULL_FACE);
      // board faces
      gl.useProgram(R.face.p);
      this.realUniforms(R.face, eye, vp, lt, sh);
      gl.uniform1i(R.face.u.uTex, 0); gl.uniform1i(R.face.u.uMatTex, 1);
      for (const [q, tx, mt, n] of [[this.topQuad, this.gTop, this.gTopMat, [0, 1, 0]], [this.botQuad, this.gBot, this.gBotMat, [0, -1, 0]]]) {
        gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, tx);
        gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, mt);
        gl.uniform3fv(R.face.u.uNormal, n);
        gl.bindVertexArray(q.vao);
        gl.drawArrays(gl.TRIANGLES, 0, 6);
      }
      // parts, board edge, drill walls
      gl.useProgram(R.mesh.p);
      this.realUniforms(R.mesh, eye, vp, lt, sh);
      gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, R.atlas); gl.uniform1i(R.mesh.u.uAtlas, 0);
      gl.activeTexture(gl.TEXTURE2); gl.bindTexture(gl.TEXTURE_2D, R.stateTex); gl.uniform1i(R.mesh.u.uState, 2);
      gl.uniform1f(R.mesh.u.uStateN, R.state ? 1 : 0);
      gl.bindVertexArray(R.vao.vao);
      if (this.assembled) gl.drawElements(gl.TRIANGLES, R.vao.count, gl.UNSIGNED_INT, 0);
      else gl.drawElements(gl.TRIANGLES, R.vao.count - R.partsCount, gl.UNSIGNED_INT, R.partsCount * 4);
      gl.bindVertexArray(null);
    }

    // ---------------------------------------------------------- scene
    setBoard(B) {
      this.clearScene();
      this.B = B;
      const gl = this.gl;
      const bb = B.bbox;
      const cx = (bb[0] + bb[2]) / 2, cy = (bb[1] + bb[3]) / 2;
      this.center = [cx, cy];
      const t = B.meta.thickness || 1.6;
      this.t = t;
      // board faces: up to 3072 px a side (colour), material maps at half that - plenty for the view, a third of the memory
      const maxTex = Math.min(gl.getParameter(gl.MAX_TEXTURE_SIZE), 3072);
      const wmm = bb[2] - bb[0] + 1, hmm = bb[3] - bb[1] + 1;
      this.pxPerMm = Math.max(8, Math.min(40, (maxTex - 8) / Math.max(wmm, hmm)));
      // faces
      this.bakeFaces();
      const T = this.texTop;
      this.topQuad = this.faceQuad(T.x0 - cx, T.y0 - cy, T.x0 + T.wmm - cx, T.y0 + T.hmm - cy, t / 2 + 0.004, false);
      this.botQuad = this.faceQuad(T.x0 - cx, T.y0 - cy, T.x0 + T.wmm - cx, T.y0 + T.hmm - cy, -t / 2 - 0.004, true);
      // edges (outline walls) + drill walls
      const pos = [], nrm = [];
      const loops = B.pcb.outline.outer.map(l => ({ l, hole: false })).concat(B.pcb.outline.holes.map(l => ({ l, hole: true })));
      const pip = (x, y, flat) => {
        let inside = false;
        for (let i = 0, j = flat.length - 2; i < flat.length; j = i, i += 2) {
          const xi = flat[i], yi = flat[i + 1], xj = flat[j], yj = flat[j + 1];
          if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) inside = !inside;
        }
        return inside;
      };
      for (const { l, hole } of loops) {
        const n = l.length / 2;
        for (let i = 0; i < n; i++) {
          const x0 = l[i * 2], y0 = l[i * 2 + 1], x1 = l[((i + 1) % n) * 2], y1 = l[((i + 1) % n) * 2 + 1];
          const dx = x1 - x0, dy = y1 - y0, L = Math.hypot(dx, dy);
          if (L < 1e-6) continue;
          let nx = dy / L, ny = -dx / L;
          const mx = (x0 + x1) / 2 + nx * 0.05, my = (y0 + y1) / 2 + ny * 0.05;
          const inside = pip(mx, my, l);
          if (hole ? !inside : inside) { nx = -nx; ny = -ny; }
          const X0 = x0 - cx, Z0 = y0 - cy, X1 = x1 - cx, Z1 = y1 - cy;
          pos.push(X0, -t / 2, Z0, X1, -t / 2, Z1, X1, t / 2, Z1, X0, -t / 2, Z0, X1, t / 2, Z1, X0, t / 2, Z0);
          for (let k = 0; k < 6; k++) nrm.push(nx, 0, ny);
        }
      }
      const edgeColor = N.mixColor('#b9a46e', B.meta.mask, 0.35);
      this.edges = this.makeStatic(pos, nrm, edgeColor, [0, 0.8, 0]);
      const hp = [], hn = [], np = [], nn = [];
      for (const p of B.pads) {
        const d = Math.max(p[11], p[12]);
        if (d < 0.5) continue;
        const target = p[2] === 2 ? [np, nn] : [hp, hn];
        // the drill wall: a circle, or a slot along the pad (never a circle as wide as the slot is long)
        const poly = B.drillPoly(p);
        if (!poly) continue;
        const n = poly.length / 2;
        for (let i = 0; i < n; i++) {
          const j = (i + 1) % n;
          const x0 = poly[i * 2] - cx, z0 = poly[i * 2 + 1] - cy, x1 = poly[j * 2] - cx, z1 = poly[j * 2 + 1] - cy;
          const L = Math.hypot(x1 - x0, z1 - z0); if (L < 1e-6) continue;
          let nx = (z1 - z0) / L, nz = -(x1 - x0) / L;
          if (nx * (p[4] - cx - (x0 + x1) / 2) + nz * (p[5] - cy - (z0 + z1) / 2) < 0) { nx = -nx; nz = -nz; }
          target[0].push(x0, -t / 2, z0, x1, -t / 2, z1, x1, t / 2, z1, x0, -t / 2, z0, x1, t / 2, z1, x0, t / 2, z0);
          for (let k = 0; k < 6; k++) target[1].push(nx, 0, nz);
        }
      }
      this.plated = hp.length ? this.makeStatic(hp, hn, N.finishColor(B.meta.finish), [1, 0.35, 0]) : null;
      this.npthWalls = np.length ? this.makeStatic(np, nn, edgeColor, [0, 0.8, 0]) : null;
      this.buildParts();
      if (this.realOn) this.buildReal(); else this.disposeRealMesh();
      this.buildRuler();
      this.fit(true);
      this.dirty = true;
    }

    bakeFaces() {
      const B = this.B;
      const common = { pxPerMm: this.pxPerMm, highlightNets: this.hl.nets, highlightRefs: this.hl.refs };
      this.texTop = N.bakeBoardTexture(B, Object.assign({ side: 'F', canvas: this.texTop && this.texTop.canvas, matCanvas: this.texTop && this.texTop.mat }, common));
      this.texBot = N.bakeBoardTexture(B, Object.assign({ side: 'B', canvas: this.texBot && this.texBot.canvas, matCanvas: this.texBot && this.texBot.mat }, common));
      this.gTop = this.texFrom(this.texTop.canvas, this.gTop);
      this.gTopMat = this.texFrom(halfCanvas(this.texTop.mat), this.gTopMat);
      this.gBot = this.texFrom(this.texBot.canvas, this.gBot);
      this.gBotMat = this.texFrom(halfCanvas(this.texBot.mat), this.gBotMat);
    }

    buildParts() {
      this.liveOrig = null;
      const B = this.B;
      const [cx, cy] = this.center;
      const t = this.t;
      const boxes = [], cyls = [];
      this.partIndex = []; // instance -> fp index (boxes)
      this.cylIndex = [];
      const metalCls = { metal: [1, 0.3], gold: [1, 0.28], xtal: [0.9, 0.35], elco: [0.75, 0.4] };
      const push = (arr, idx, fi, X, Y, Z, sx, sy, sz, rotRad, color, mat) => {
        const c = hex(color);
        const sel = this.hl.refs.has(B.fps[fi].r) ? 1 : 0;
        arr.push(X, Y, Z, sx, sy, sz, rotRad, c[0], c[1], c[2], mat[0], mat[1], sel, 0);
        idx.push(fi);
      };
      const bbA = Math.max(1, (B.bbox[2] - B.bbox[0]) * (B.bbox[3] - B.bbox[1]));
      const bodies = B.bodies ? B.bodies() : null;
      B.fps.forEach((f, fi) => {
        const z = bodies ? bodies[fi].z : f.z;
        if (!z || z[0] === 'none' || !f.b || f.dnp) return;
        // outlines, keep-outs and pinout drawings that cover the whole board are not parts
        if ((f.b[2] - f.b[0]) * (f.b[3] - f.b[1]) > 0.8 * bbA) return;
        const [cls, h0, color] = z;
        if (!h0) return;
        const b = f.b;
        let sx = b[2] - b[0], sz = b[3] - b[1];
        if (sx < 0.05 || sz < 0.05) return;
        const bx = (b[0] + b[2]) / 2, by = (b[1] + b[3]) / 2;
        const r = N.rot(bx, by, f.a);
        const X = f.x + r[0] - cx, Z = f.y + r[1] - cy;
        const top = f.s === 0;
        const Y = top ? t / 2 : -t / 2;
        const sgn = top ? 1 : -1;
        const h = h0;
        const rotRad = f.a * Math.PI / 180;
        const mat = metalCls[cls] || (cls === 'ic' ? [0, 0.55] : cls === 'module' ? [0.1, 0.5] : [0, 0.7]);
        if ((cls === 'res' || cls === 'cap' || cls === 'ind' || cls === 'led') && Math.max(sx, sz) < 8) {
          // chip part: body + two metal terminations along the long axis
          const alongX = sx >= sz;
          const L = alongX ? sx : sz;
          const cap = L * 0.17;
          const bodyL = L - cap * 2;
          const dx = alongX ? 1 : 0, dz = alongX ? 0 : 1;
          const bsx = alongX ? bodyL : sx * 0.98, bsz = alongX ? sz * 0.98 : bodyL;
          push(boxes, this.partIndex, fi, X, Y, Z, bsx, sgn * h, bsz, rotRad, color, mat);
          for (const s of [-1, 1]) {
            const off = N.rot(dx * s * (L / 2 - cap / 2), dz * s * (L / 2 - cap / 2), f.a);
            push(boxes, this.partIndex, fi, X + off[0], Y, Z + off[1], alongX ? cap : sx, sgn * h * 1.01, alongX ? sz : cap, rotRad, '#c8ccd1', [1, 0.32]);
          }
          return;
        }
        if (cls === 'frame') {
          // shield fence: four thin walls, open top
          const wt = 0.3;
          const walls = [[0, -sz / 2 + wt / 2, sx, wt], [0, sz / 2 - wt / 2, sx, wt], [-sx / 2 + wt / 2, 0, wt, sz], [sx / 2 - wt / 2, 0, wt, sz]];
          for (const [ox, oz, wx, wz] of walls) {
            const off = N.rot(ox, oz, f.a);
            push(boxes, this.partIndex, fi, X + off[0], Y, Z + off[1], wx, sgn * h, wz, rotRad, color, [1, 0.35]);
          }
          return;
        }
        if (cls === 'elco') {
          const d = Math.min(sx, sz) * 0.96;
          push(cyls, this.cylIndex, fi, X, Y, Z, d, sgn * h, d, rotRad, color, mat);
          return;
        }
        if (cls === 'header') {
          // test-pad rows, castellated edges and SMD pads are not pin headers: nothing sticks out of the board there
          const pads = f.pads.map(pi => B.pads[pi]);
          const tht = pads.filter(p => p[2] === 1 && Math.max(p[11] || 0, p[12] || 0) >= 0.5);
          const bb = B.bbox, edge = p => p[4] - bb[0] < 0.9 || bb[2] - p[4] < 0.9 || p[5] - bb[1] < 0.9 || bb[3] - p[5] < 0.9;
          if (tht.length < pads.length * 0.6 || tht.filter(edge).length > tht.length * 0.4) return;
          push(boxes, this.partIndex, fi, X, Y, Z, sx, sgn * 2.5, sz, rotRad, color, mat);
          for (const pi of f.pads) {
            const p = B.pads[pi];
            if (p[2] !== 1) continue;
            push(boxes, this.partIndex, fi, p[4] - cx, top ? -t / 2 - 3 : t / 2 + 3, p[5] - cy, 0.64, sgn * (11.5 + t), 0.64, rotRad, '#d9b25c', [1, 0.3]);
          }
          return;
        }
        push(boxes, this.partIndex, fi, X, Y, Z, sx, sgn * h, sz, rotRad, color, mat);
        if (cls === 'ic' && Math.min(sx, sz) > 1.6 && h < 2.5) {
          // pin-1 dimple
          const d = Math.min(sx, sz) * 0.12;
          const off = N.rot(b[0] + d * 1.6 - bx, b[1] + d * 1.6 - by, f.a);
          push(boxes, this.partIndex, fi, X + off[0], Y + sgn * h, Z + off[1], d, sgn * 0.01, d, rotRad, '#55585e', [0, 0.9]);
        }
      });
      this.boxData = new Float32Array(boxes);
      this.cylData = new Float32Array(cyls);
      this.setInstances(this.box, this.boxData);
      this.setInstances(this.cyl, this.cylData);
      // bounding info
      let maxH = 0, minH = 0;
      for (let i = 0; i < boxes.length; i += 14) { const top = boxes[i + 1] + boxes[i + 4]; maxH = Math.max(maxH, top, boxes[i + 1]); minH = Math.min(minH, top, boxes[i + 1]); }
      this.zRange = [minH, maxH];
    }

    buildRuler() {
      const B = this.B;
      const bb = B.bbox;
      const w = bb[2] - bb[0];
      const span = Math.ceil(w / 10) * 10;
      const padL = 6, padR = 12;
      const len = span + padL + padR;
      const H = 16; // mm tall
      const cv = document.createElement('canvas');
      cv.width = Math.min(4096, Math.round(len * 14)); cv.height = Math.round(H * (cv.width / len));
      const ctx = cv.getContext('2d');
      ctx.scale(cv.width / len, cv.height / H);
      ctx.translate(padL, 0);
      ctx.strokeStyle = 'rgba(28,32,38,0.85)';
      ctx.fillStyle = 'rgba(28,32,38,0.9)';
      ctx.lineWidth = 0.16;
      ctx.beginPath(); ctx.moveTo(0, 1.5); ctx.lineTo(span, 1.5); ctx.stroke();
      ctx.font = '3.1px ui-monospace, Menlo, monospace';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'top';
      for (let mm = 0; mm <= span; mm++) {
        const tall = mm % 10 === 0 ? 3.6 : mm % 5 === 0 ? 2.6 : 1.6;
        ctx.beginPath(); ctx.moveTo(mm, 1.5); ctx.lineTo(mm, 1.5 + tall); ctx.stroke();
        if (mm % 10 === 0) ctx.fillText(String(mm), mm, 6.2);
      }
      ctx.textAlign = 'left';
      ctx.fillText('mm', span + 2.5, 6.2);
      this.rulerTex = this.texFrom(cv, this.rulerTex);
      const [cx, cy] = this.center;
      const x0 = bb[0] - cx - padL, z0 = bb[3] - cy + 5;
      const y = -this.t / 2 + Math.min(0, this.zRange[0]) - 0.2;
      this.rulerQuad = this.faceQuad(x0, z0, x0 + len, z0 + H, y, false);
      if (!this.whiteTex) {
        const c = document.createElement('canvas'); c.width = c.height = 4;
        const g = c.getContext('2d'); g.fillStyle = 'rgb(0,230,0)'; g.fillRect(0, 0, 4, 4);
        this.whiteTex = this.texFrom(c);
      }
    }

    clearScene() {
      const gl = this.gl;
      for (const k of ['edges', 'plated', 'npthWalls']) {
        const g = this[k];
        if (g) { gl.deleteVertexArray(g.vao); gl.deleteBuffer(g.inst); gl.deleteBuffer(g.b0); gl.deleteBuffer(g.b1); this[k] = null; }
      }
      for (const k of ['topQuad', 'botQuad', 'rulerQuad']) {
        const q = this[k];
        if (q) { gl.deleteVertexArray(q.vao); gl.deleteBuffer(q.buf); this[k] = null; }
      }
    }

    setHighlight(refs, nets) {
      this.hl = { refs: new Set(refs || []), nets: new Set(nets || []) };
      if (!this.B) return;
      // instance flags
      for (const [geo, idx] of [[this.box, this.partIndex], [this.cyl, this.cylIndex]]) {
        if (!geo.data) continue;
        for (let i = 0; i < idx.length; i++) geo.data[i * 14 + 12] = this.hl.refs.has(this.B.fps[idx[i]].r) ? 1 : 0;
        this.setInstances(geo, geo.data);
      }
      const R = this.real;
      if (R && R.state) { this.B.fps.forEach((f, fi) => { const o = fi * 4 + 3; if (o < R.state.length) R.state[o] = (R.state[o] & 2) | (this.hl.refs.has(f.r) ? 1 : 0); }); R.stateDirty = true; }
      if (this.live) for (const d of this.live.leds || []) d._q3 = undefined;
      this._pixQ = null;
      this.bakeFaces();
      this.dirty = true;
    }
    setAssembled(v) { this.assembled = v; this.dirty = true; }
    setLight(mode) { this.light = mode; this.dirty = true; }
    setRuler(v) { this.showRuler = v; this.dirty = true; }

    // ---------------------------------------------------------- camera
    fit(resetAngles) {
      if (!this.B) return;
      const bb = this.B.bbox;
      const w = bb[2] - bb[0], h = bb[3] - bb[1];
      const r = 0.5 * Math.hypot(w, h, 6);
      const aspect = this.canvas.clientWidth / Math.max(1, this.canvas.clientHeight);
      const fovH = 2 * Math.atan(Math.tan(this.cam.fov / 2) * aspect);
      const d = r / Math.sin(Math.min(this.cam.fov, fovH) / 2) * 0.92;
      const st = this.B.stats || {};
      const under = (st.bottom || 0) > (st.top || 0) * 1.5;
      this.animateTo({ dist: d, target: [0, 0, this.showRuler ? 6 : 0], yaw: resetAngles ? (under ? Math.PI : 0) : this.cam.yaw, pitch: resetAngles ? (under ? -42 : 42) * Math.PI / 180 : this.cam.pitch }, resetAngles ? 0 : 280);
    }
    view(name) {
      const P = Math.PI;
      const v = { top: [0, P / 2 - 0.0015], bottom: [P, -P / 2 + 0.0015], front: [0, 0.12], back: [P, 0.12], left: [-P / 2, 0.12], right: [P / 2, 0.12], iso: [-P / 5, 0.62] }[name];
      if (!v) return;
      let yaw = v[0];
      // shortest turn
      while (yaw - this.cam.yaw > P) yaw -= 2 * P;
      while (yaw - this.cam.yaw < -P) yaw += 2 * P;
      this.animateTo({ yaw, pitch: v[1] }, 320);
    }
    animateTo(to, ms) {
      const from = { yaw: this.cam.yaw, pitch: this.cam.pitch, dist: this.cam.dist, target: this.cam.target.slice() };
      const t0 = performance.now();
      const ease = x => 1 - Math.pow(1 - x, 3);
      const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
      this.anim = now => {
        const k = ms && !reduce ? Math.min(1, (now - t0) / ms) : 1;
        const e = ease(k);
        if (to.yaw != null) this.cam.yaw = from.yaw + (to.yaw - from.yaw) * e;
        if (to.pitch != null) this.cam.pitch = from.pitch + (to.pitch - from.pitch) * e;
        if (to.dist != null) this.cam.dist = from.dist + (to.dist - from.dist) * e;
        if (to.target) this.cam.target = from.target.map((v, i) => v + (to.target[i] - v) * e);
        this.dirty = true;
        if (k >= 1) this.anim = null;
      };
      this.dirty = true;
    }
    eye() {
      const c = this.cam;
      return [c.target[0] + c.dist * Math.cos(c.pitch) * Math.sin(c.yaw), c.target[1] + c.dist * Math.sin(c.pitch), c.target[2] + c.dist * Math.cos(c.pitch) * Math.cos(c.yaw)];
    }
    matrices() {
      const W = this.canvas.clientWidth, H = this.canvas.clientHeight;
      const e = this.eye();
      const near = Math.max(0.5, this.cam.dist * 0.02), far = this.cam.dist * 6 + 500;
      const proj = M.persp(this.cam.fov, W / Math.max(1, H), near, far);
      const view = M.lookAt(e, this.cam.target, [0, 1, 0]);
      return { proj, view, vp: M.mul(proj, view), eye: e };
    }

    // ---------------------------------------------------------- input
    bindInput() {
      const cv = this.canvas;
      const ptrs = new Map();
      let mode = null, last = null, downAt = null, moved = 0, pinch0 = 0;
      cv.addEventListener('contextmenu', e => e.preventDefault());
      cv.addEventListener('pointerdown', e => {
        cv.setPointerCapture(e.pointerId);
        ptrs.set(e.pointerId, { x: e.clientX, y: e.clientY });
        moved = 0;
        downAt = { x: e.clientX, y: e.clientY };
        if (ptrs.size === 2) {
          const [a, b] = [...ptrs.values()];
          pinch0 = Math.hypot(a.x - b.x, a.y - b.y);
          mode = 'pinch';
        } else {
          mode = e.button === 2 || e.button === 1 || e.shiftKey || e.ctrlKey || e.metaKey ? 'pan' : 'orbit';
        }
        last = { x: e.clientX, y: e.clientY };
        this.anim = null;
      });
      cv.addEventListener('pointermove', e => {
        if (!ptrs.has(e.pointerId)) { this.hover(e); return; }
        const prev = ptrs.get(e.pointerId);
        ptrs.set(e.pointerId, { x: e.clientX, y: e.clientY });
        this._moveAt = performance.now();
        if (mode === 'pinch' && ptrs.size === 2) {
          const [a, b] = [...ptrs.values()];
          const d = Math.hypot(a.x - b.x, a.y - b.y);
          if (pinch0) this.cam.dist *= pinch0 / d;
          pinch0 = d;
          const mx = (e.clientX - prev.x) / 2, my = (e.clientY - prev.y) / 2;
          this.pan(mx, my);
          this.clampDist();
          this.dirty = true;
          return;
        }
        const dx = e.clientX - last.x, dy = e.clientY - last.y;
        moved += Math.abs(dx) + Math.abs(dy);
        last = { x: e.clientX, y: e.clientY };
        if (mode === 'orbit') {
          this.cam.yaw -= dx * 0.008;
          this.cam.pitch = Math.max(-Math.PI / 2 + 0.0015, Math.min(Math.PI / 2 - 0.0015, this.cam.pitch + dy * 0.008));
        } else if (mode === 'pan') this.pan(dx, dy);
        this.dirty = true;
        this.emit('camera');
      });
      const end = e => {
        if (ptrs.has(e.pointerId)) ptrs.delete(e.pointerId);
        if (ptrs.size === 0) {
          if (moved < 5 && downAt && e.type === 'pointerup') this.click(e);
          mode = null;
        } else mode = 'orbit';
      };
      cv.addEventListener('pointerup', end);
      cv.addEventListener('pointercancel', end);
      cv.addEventListener('pointerleave', () => this.emit('hover', null));
      cv.addEventListener('wheel', e => {
        e.preventDefault();
        this._moveAt = performance.now();
        const k = Math.exp((e.deltaMode === 1 ? e.deltaY * 16 : e.deltaY) * 0.0012);
        // zoom toward the cursor on the board plane
        const hit = this.rayBoard(e);
        const old = this.cam.dist;
        this.cam.dist *= k;
        this.clampDist();
        if (hit && k < 1) {
          const f = 1 - this.cam.dist / old;
          this.cam.target = this.cam.target.map((v, i) => v + (hit.p[i] - v) * f * 0.9);
        }
        this.dirty = true;
        this.emit('camera');
      }, { passive: false });
      cv.addEventListener('dblclick', e => {
        const hit = this.rayBoard(e);
        if (hit) this.animateTo({ target: hit.p, dist: this.cam.dist * 0.55 }, 300);
      });
    }
    clampDist() {
      const bb = this.B ? this.B.bbox : [0, 0, 100, 100];
      const size = Math.hypot(bb[2] - bb[0], bb[3] - bb[1]);
      this.cam.dist = Math.max(size * 0.04, Math.min(size * 6, this.cam.dist));
    }
    pan(dx, dy) {
      const c = this.cam;
      const H = this.canvas.clientHeight || 1;
      const worldPerPx = 2 * c.dist * Math.tan(c.fov / 2) / H;
      const right = [Math.cos(c.yaw), 0, -Math.sin(c.yaw)];
      const up = [-Math.sin(c.pitch) * Math.sin(c.yaw), Math.cos(c.pitch), -Math.sin(c.pitch) * Math.cos(c.yaw)];
      for (let i = 0; i < 3; i++) c.target[i] += (-dx * right[i] + dy * up[i]) * worldPerPx;
    }
    ray(e) {
      const r = this.canvas.getBoundingClientRect();
      const x = ((e.clientX - r.left) / r.width) * 2 - 1;
      const y = -(((e.clientY - r.top) / r.height) * 2 - 1);
      const { vp, eye } = this.matrices();
      const inv = M.inv(vp);
      const p = M.xform(inv, [x, y, 1, 1]);
      const far = [p[0] / p[3], p[1] / p[3], p[2] / p[3]];
      const d = [far[0] - eye[0], far[1] - eye[1], far[2] - eye[2]];
      const L = Math.hypot(...d);
      return { o: eye, d: d.map(v => v / L) };
    }
    rayBoard(e) {
      if (!this.B) return null;
      const { o, d } = this.ray(e);
      const top = o[1] > 0;
      const y = top ? this.t / 2 : -this.t / 2;
      if (Math.abs(d[1]) < 1e-6) return null;
      const s = (y - o[1]) / d[1];
      if (s < 0) return null;
      const p = [o[0] + d[0] * s, y, o[2] + d[2] * s];
      const bx = p[0] + this.center[0], by = p[2] + this.center[1];
      const bb = this.B.bbox;
      if (bx < bb[0] - 2 || bx > bb[2] + 2 || by < bb[1] - 2 || by > bb[3] + 2) return { p, inside: false, s };
      return { p, bx, by, side: top ? 0 : 1, inside: true, s };
    }
    pickPart(e) {
      if (!this.B || !this.assembled) return null;
      const { o, d } = this.ray(e);
      let best = null;
      const test = (geo, idx) => {
        const a = geo.data;
        if (!a) return;
        for (let i = 0; i < geo.n; i++) {
          const k = i * 14;
          const c = Math.cos(-a[k + 6]), s = Math.sin(-a[k + 6]);
          const ox = o[0] - a[k], oy = o[1] - a[k + 1], oz = o[2] - a[k + 2];
          const lo = [(ox * c + oz * s) / a[k + 3], oy / a[k + 4], (-ox * s + oz * c) / a[k + 5]];
          const ld = [(d[0] * c + d[2] * s) / a[k + 3], d[1] / a[k + 4], (-d[0] * s + d[2] * c) / a[k + 5]];
          let tmin = -1e9, tmax = 1e9;
          const lo3 = [-0.5, 0, -0.5], hi3 = [0.5, 1, 0.5];
          let ok = true;
          for (let j = 0; j < 3; j++) {
            if (Math.abs(ld[j]) < 1e-12) { if (lo[j] < lo3[j] || lo[j] > hi3[j]) { ok = false; break; } continue; }
            let t1 = (lo3[j] - lo[j]) / ld[j], t2 = (hi3[j] - lo[j]) / ld[j];
            if (t1 > t2) [t1, t2] = [t2, t1];
            tmin = Math.max(tmin, t1); tmax = Math.min(tmax, t2);
            if (tmin > tmax) { ok = false; break; }
          }
          if (ok && tmax > 0 && (!best || tmin < best.t)) best = { t: tmin, fi: idx[i] };
        }
      };
      test(this.box, this.partIndex);
      test(this.cyl, this.cylIndex);
      return best;
    }
    hover(e) {
      if (this._hoverPending) return;
      this._hoverPending = true;
      requestAnimationFrame(() => {
        this._hoverPending = false;
        const part = this.pickPart(e);
        const r = this.canvas.getBoundingClientRect();
        if (part) { this.emit('hover', { fi: part.fi, x: e.clientX - r.left, y: e.clientY - r.top }); return; }
        const hb = this.rayBoard(e);
        this.emit('hover', hb && hb.inside ? { board: hb, x: e.clientX - r.left, y: e.clientY - r.top } : null);
      });
    }
    click(e) {
      const part = this.pickPart(e);
      if (part) { this.emit('pick', { fi: part.fi }); return; }
      const hb = this.rayBoard(e);
      this.emit('pick', hb && hb.inside ? { board: hb } : null);
    }

    // ---------------------------------------------------------- render
    resize() {
      const r = this.host.getBoundingClientRect();
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      this.fullW = Math.max(1, Math.round(r.width * dpr));
      this.fullH = Math.max(1, Math.round(r.height * dpr));
      this.canvas.style.width = r.width + 'px';
      this.canvas.style.height = r.height + 'px';
      // while the camera moves, the realistic view draws fewer pixels (about 1.4 MP to start, then whatever keeps it smooth)
      this.moveScale = Math.min(this.moveScale || 1, 1, Math.sqrt(1.4e6 / (this.fullW * this.fullH)));
      this.moveCap = this.moveScale;
      this.applyScale(this.curScale || 1);
      this.dirty = true;
    }
    applyScale(k) {
      const w = Math.max(1, Math.round((this.fullW || 1) * k)), h = Math.max(1, Math.round((this.fullH || 1) * k));
      if (this.canvas.width !== w || this.canvas.height !== h) { this.canvas.width = w; this.canvas.height = h; }
      this.curScale = k;
    }
    loop(now) {
      this.raf = requestAnimationFrame(this.loop);
      const prev = this._rafPrev, drew = this._drewPrev;
      this._rafPrev = now; this._drewPrev = false;
      if (this.anim) this.anim(now);
      // fewer pixels while orbiting, panning or zooming; the full picture again once the camera rests
      const moving = !!this.anim || now - (this._moveAt || -1e9) < 150;
      const want = moving && this.realOn ? this.moveScale || 1 : 1;
      if (want !== this.curScale && this.fullW) { this.applyScale(want); this.dirty = true; }
      if (!this.dirty || !this.B) return;
      this.dirty = false;
      this.render();
      this.emit('camera');
      this._drewPrev = true;
      if (drew && prev && moving) this.pace(now - prev);
    }
    // frames drawn back to back (orbiting, zooming) that keep taking long: drop the shadows, then the realistic parts
    pace(dt) {
      if (!this.realOn || document.visibilityState !== 'visible') return;
      const s = this._spd || (this._spd = []);
      s.push(dt);
      if (s.length > 8) s.shift();
      if (s.length < 8) return;
      const med = s.slice().sort((a, b) => a - b)[4];
      // first the resolution while moving: down when frames take longer than ~30 fps, back up when there is room
      if (med > 34 && this.moveScale > 0.36) { this.moveScale = Math.max(0.35, this.moveScale * 0.8); this._spd = []; return; }
      if (med < 18 && this.moveScale < this.moveCap) { this.moveScale = Math.min(this.moveCap, this.moveScale * 1.12); this._spd = []; return; }
      if (!this.realAuto || med < 60) return;
      this._spd = [];
      const R = this.real;
      if (R.shadows && !R.shadowOff && (REAL[this.light] || REAL.studio).shadow !== false) { R.shadowOff = true; this.emit('quality', { shadows: false, real: true, ms: Math.round(med) }); }
      else { this.realOn = false; this.emit('quality', { shadows: false, real: false, ms: Math.round(med) }); }
      this.dirty = true;
    }
    uniforms(prog, eye, vp) {
      const gl = this.gl, u = prog.u;
      const L = LIGHTS[this.light] || LIGHTS.studio;
      gl.uniformMatrix4fv(u.uVP, false, vp);
      gl.uniform3fv(u.uEye, eye);
      // lights ride with the camera so every side of the board is readable
      const c = this.cam;
      const back = [Math.cos(c.pitch) * Math.sin(c.yaw), Math.sin(c.pitch), Math.cos(c.pitch) * Math.cos(c.yaw)];
      const right = [Math.cos(c.yaw), 0, -Math.sin(c.yaw)];
      const up = [-Math.sin(c.pitch) * Math.sin(c.yaw), Math.cos(c.pitch), -Math.sin(c.pitch) * Math.cos(c.yaw)];
      const rel = d => [0, 1, 2].map(i => right[i] * d[0] + up[i] * d[1] + back[i] * d[2]);
      gl.uniform3fv(u.uKeyDir, rel(L.keyDir));
      gl.uniform3fv(u.uUp, up.map((v, i) => v * 0.6 + [0, 1, 0][i] * 0.4 * Math.sign(Math.sin(c.pitch) || 1)));
      gl.uniform3fv(u.uKeyCol, hex(L.key).map(v => v * L.keyI));
      gl.uniform3fv(u.uFillDir, rel(L.fillDir));
      gl.uniform3fv(u.uFillCol, hex(L.fill).map(v => v * L.fillI));
      gl.uniform3fv(u.uSky, hex(L.sky).map(v => v * 0.62));
      gl.uniform3fv(u.uGround, hex(L.ground).map(v => v * 0.5));
      gl.uniform1f(u.uSpec, L.spec);
    }
    render() {
      const gl = this.gl;
      const { vp, eye } = this.matrices();
      const ck = this.cam.yaw + ',' + this.cam.pitch + ',' + this.cam.dist + ',' + this.cam.target.join(',') + ',' + this.canvas.width + ',' + this.canvas.height;
      if (ck !== this._camKey) { this._camKey = ck; this._camMoved = performance.now(); }
      const drawFace = (q, tex, mat, n) => {
        gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, tex);
        gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, mat);
        gl.uniform3fv(this.face.u.uNormal, n);
        gl.bindVertexArray(q.vao);
        gl.drawArrays(gl.TRIANGLES, 0, 6);
      };
      if (this.real && this.real.vao && this.realOn) this.renderReal(vp, eye);
      else {
        gl.viewport(0, 0, this.canvas.width, this.canvas.height);
        gl.clearColor(0, 0, 0, 0);
        gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
        gl.enable(gl.DEPTH_TEST);
        gl.disable(gl.CULL_FACE);
        // faces
        gl.useProgram(this.face.p);
        this.uniforms(this.face, eye, vp);
        gl.uniform1i(this.face.u.uTex, 0);
        gl.uniform1i(this.face.u.uMatTex, 1);
        gl.uniform1f(this.face.u.uBlend, 0);
        drawFace(this.topQuad, this.gTop, this.gTopMat, [0, 1, 0]);
        drawFace(this.botQuad, this.gBot, this.gBotMat, [0, -1, 0]);
        // meshes
        gl.useProgram(this.mesh.p);
        this.uniforms(this.mesh, eye, vp);
        for (const g of [this.edges, this.plated, this.npthWalls]) {
          if (!g) continue;
          gl.bindVertexArray(g.vao);
          gl.drawArraysInstanced(gl.TRIANGLES, 0, g.count, 1);
        }
        if (this.assembled) {
          for (const g of [this.box, this.cyl]) {
            if (!g.n) continue;
            gl.bindVertexArray(g.vao);
            gl.drawArraysInstanced(gl.TRIANGLES, 0, g.count, g.n);
          }
        }
      }
      if (this.live && this.liveTop && this.ovl) {
        gl.useProgram(this.ovl.p);
        gl.uniformMatrix4fv(this.ovl.u.uVP, false, vp);
        gl.uniform1i(this.ovl.u.uTex, 0);
        gl.enable(gl.BLEND);
        gl.blendFuncSeparate(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA, gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
        gl.depthMask(false);
        const [cx, cy] = this.center;
        for (const S of [this.liveTop, this.liveBot]) {
          if (!S.R) continue;
          gl.uniform4f(this.ovl.u.uRect, S.R.x0 - cx, S.R.y0 - cy, 1 / S.R.w, 1 / S.R.h);
          gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, S.tex);
          gl.bindVertexArray(S.quad.vao);
          gl.drawArrays(gl.TRIANGLES, 0, 6);
        }
        gl.depthMask(true);
        gl.disable(gl.BLEND);
      }
      if (this.showRuler && this.rulerQuad && this.cam.pitch > 0.03) {
        gl.useProgram(this.face.p);
        this.uniforms(this.face, eye, vp);
        gl.uniform1i(this.face.u.uTex, 0);
        gl.uniform1i(this.face.u.uMatTex, 1);
        gl.enable(gl.BLEND);
        gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
        gl.uniform1f(this.face.u.uBlend, 1);
        drawFace(this.rulerQuad, this.rulerTex, this.whiteTex, [0, 1, 0]);
        gl.disable(gl.BLEND);
      }
      gl.bindVertexArray(null);
    }
    // ---------------------------------------------------------- live simulation overlay
    liveTick(L, wall) {
      if (!this.B || L.B !== this.B || !this.texTop) return;
      this.live = L;
      if (!this.liveTop || this.liveTop.B !== this.B) { this.initLive(); for (const d of L.leds || []) d._q3 = undefined; }
      this.liveAcc = (this.liveAcc || 0) + 1;
      if (this.liveAcc < (this.liveEvery || 2)) return;
      this.liveAcc = 0;
      const t0 = performance.now();
      // the overlay follows the view: the part of the board on screen, at about screen resolution (sharp when zoomed in);
      // it is re-cut only once the camera rests, the old one stays in place (in board coordinates) meanwhile
      const want = this.liveRegionWanted();
      const R = this.liveR;
      const moving = t0 - (this._camMoved || 0) < 160;
      if (!R || (!moving && (want.k > R.k * 1.3 || want.k < R.k / 2.2 || want.x0 < R.x0 - 0.02 * R.w || want.y0 < R.y0 - 0.02 * R.h || want.x0 + want.w > R.x0 + R.w * 1.02 || want.y0 + want.h > R.y0 + R.h * 1.02))) this.setLiveRegion(want);
      const topFirst = this.cam.pitch >= 0;
      this.liveN = (this.liveN || 0) + 1;
      const sides = (this.liveN & 7) === 1 ? [0, 1] : [topFirst ? 0 : 1];
      for (const sd of sides) this.paintLiveSide(sd ? this.liveBot : this.liveTop, sd, L);
      this.liveLeds(L);
      this.liveMarkers(L);
      this.dirty = true;
      const ms = performance.now() - t0;
      this.liveEvery = ms > 14 ? 4 : ms > 7 ? 3 : 2;
      void wall;
    }
    // the board area under the camera (board mm) and the texture pixels per mm that match the screen there
    liveRegionWanted() {
      const B = this.B, bb = B.bbox, [cx, cy] = this.center;
      const side = this.cam.pitch >= 0 ? 0 : 1, yb = side ? -this.t / 2 : this.t / 2;
      const { vp, eye } = this.matrices();
      const inv = M.inv(vp);
      const Wd = this.fullW || this.canvas.width, Hd = this.fullH || this.canvas.height;
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity, k = 0, hits = 0;
      for (let i = 0; i <= 6; i++) for (let j = 0; j <= 6; j++) {
        const nx = i / 3 - 1, ny = j / 3 - 1;
        const p = M.xform(inv, [nx, ny, 1, 1]);
        const d = [p[0] / p[3] - eye[0], p[1] / p[3] - eye[1], p[2] / p[3] - eye[2]];
        if (Math.abs(d[1]) < 1e-9) continue;
        const s = (yb - eye[1]) / d[1];
        if (s <= 0) continue;
        const wx = eye[0] + d[0] * s + cx, wy = eye[2] + d[2] * s + cy;
        const qx = Math.max(bb[0], Math.min(bb[2], wx)), qy = Math.max(bb[1], Math.min(bb[3], wy));
        x0 = Math.min(x0, qx); y0 = Math.min(y0, qy); x1 = Math.max(x1, qx); y1 = Math.max(y1, qy);
        if (wx >= bb[0] && wx <= bb[2] && wy >= bb[1] && wy <= bb[3]) {
          hits++;
          // device pixels per mm at this point
          const a = M.xform(vp, [wx - cx, yb, wy - cy, 1]), c = M.xform(vp, [wx - cx + 1, yb, wy - cy, 1]), e = M.xform(vp, [wx - cx, yb, wy - cy + 1, 1]);
          if (a[3] > 0 && c[3] > 0 && e[3] > 0) {
            const ax = a[0] / a[3] * Wd / 2, ay = a[1] / a[3] * Hd / 2;
            k = Math.max(k, Math.hypot(c[0] / c[3] * Wd / 2 - ax, c[1] / c[3] * Hd / 2 - ay), Math.hypot(e[0] / e[3] * Wd / 2 - ax, e[1] / e[3] * Hd / 2 - ay));
          }
        }
      }
      if (!hits || !(x1 > x0) || !(y1 > y0)) { x0 = bb[0]; y0 = bb[1]; x1 = bb[2]; y1 = bb[3]; }
      // a margin around what is on screen, so small moves need no new cut
      const mw = (x1 - x0) * 0.15 + 1, mh = (y1 - y0) * 0.15 + 1;
      x0 = Math.max(bb[0] - 0.5, x0 - mw); y0 = Math.max(bb[1] - 0.5, y0 - mh); x1 = Math.min(bb[2] + 0.5, x1 + mw); y1 = Math.min(bb[3] + 0.5, y1 + mh);
      const w = x1 - x0, h = y1 - y0;
      const maxDim = Math.min(2048, this.gl.getParameter(this.gl.MAX_TEXTURE_SIZE)), maxPix = 3.2e6;
      let kk = Math.max(3, Math.min(56, k || 8));
      kk = Math.min(kk, maxDim / w, maxDim / h, Math.sqrt(maxPix / (w * h)));
      return { x0, y0, w, h, k: kk };
    }
    setLiveRegion(R) {
      this.liveR = R;
      const W = Math.max(16, Math.round(R.w * R.k)), H = Math.max(16, Math.round(R.h * R.k));
      for (const S of [this.liveTop, this.liveBot]) {
        if (!S) continue;
        if (S.cv.width !== W || S.cv.height !== H) { S.cv.width = W; S.cv.height = H; S.size = null; if (S.cu) { S.cu.width = W; S.cu.height = H; } }
        S.cuKey = null;
      }
    }
    initLive() {
      const gl = this.gl, T = this.texTop, [cx, cy] = this.center, t = this.t;
      for (const k of ['liveTop', 'liveBot']) if (this[k]) { gl.deleteVertexArray(this[k].quad.vao); gl.deleteBuffer(this[k].quad.buf); gl.deleteTexture(this[k].tex); }
      if (!this.ovl) this.ovl = compile(gl, VS_OVL, FS_OVL);
      const mk = (y, down) => {
        const cv = document.createElement('canvas');
        cv.width = cv.height = 16;
        const tex = gl.createTexture();
        gl.bindTexture(gl.TEXTURE_2D, tex);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        // a quad a little larger than the board; the shader maps board millimetres into the current cut
        return { B: this.B, cv, ctx: cv.getContext('2d'), tex, quad: this.faceQuad(T.x0 - cx - 1, T.y0 - cy - 1, T.x0 + T.wmm - cx + 1, T.y0 + T.hmm - cy + 1, y, down) };
      };
      this.liveTop = mk(t / 2 + 0.02, false);
      this.liveBot = mk(-t / 2 - 0.02, true);
      this.liveR = null;
      if (!this.whiteTex) this.buildRuler();
    }
    paintLiveSide(S, side, L) {
      const B = this.B, ctx = S.ctx, P = N.buildPaths(B), R = this.liveR;
      if (!R) return;
      const W = S.cv.width, H = S.cv.height;
      const k = W / R.w;
      const world = g => g.setTransform(k, 0, 0, H / R.h, -R.x0 * k, -R.y0 * H / R.h);
      const cu = side ? B.cu[B.cu.length - 1] : B.cu[0];
      // voltage-coloured copper, redrawn only when a net changes colour or the cut changes
      const key = L.gen + ':' + L.colGen;
      if (!S.cu || S.cuKey !== key) {
        if (!S.cu) { S.cu = document.createElement('canvas'); S.cu.width = W; S.cu.height = H; }
        const g = S.cu.getContext('2d');
        g.setTransform(1, 0, 0, 1, 0, 0);
        g.clearRect(0, 0, W, H);
        world(g);
        g.save();
        g.clip(P.outline, 'evenodd');
        g.fillStyle = 'rgba(0,0,0,0.42)';
        g.fill(P.outline, 'evenodd');
        N.paintLiveCopper(g, B, L, [{ name: cu, alpha: 0.95 }], { scheme: 'dark', minW: 1.2 / k, zoneAlpha: 0.4, air: true, airW: Math.max(0.12, 1.6 / k) });
        g.fillStyle = '#0b0e10';
        g.fill(P.viaHoles);
        g.restore();
        S.cuKey = key;
      }
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, W, H);
      ctx.drawImage(S.cu, 0, 0);
      world(ctx);
      ctx.save();
      ctx.clip(P.outline, 'evenodd');
      N.paintLiveLeds(ctx, B, L, { side });
      // dots of a fixed size on screen (the cut is at about screen resolution)
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      N.paintLiveDots(ctx, B, L, { layers: new Set([B.cu.indexOf(cu), -1]), side, spacing: 17 * dpr / k, r: 2.1 * dpr / k, dot: '#ffd21f', edge: 'rgba(0,0,0,0.5)', rect: [R.x0, R.y0, R.x0 + R.w, R.y0 + R.h], legs: k / dpr >= 6 });
      ctx.restore();
      const gl = this.gl;
      gl.bindTexture(gl.TEXTURE_2D, S.tex);
      gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
      if (S.size !== W + 'x' + H) { gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, S.cv); S.size = W + 'x' + H; }
      else gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, gl.RGBA, gl.UNSIGNED_BYTE, S.cv);
      S.R = R;
    }
    // probe markers over the 3D view (a 2D canvas on top of the GL one)
    liveMarkers(L) {
      const list = (L.probes || []).filter(p => p.at && (p.at.view === 'pcb' || p.at.view === '3d'));
      if (!this.markCv) {
        if (!list.length) return;
        this.markCv = document.createElement('canvas');
        this.markCv.className = 'gl-marks';
        Object.assign(this.markCv.style, { position: 'absolute', inset: '0', pointerEvents: 'none', width: '100%', height: '100%' });
        this.canvas.parentElement.append(this.markCv);
      }
      const cv = this.markCv, dpr = Math.min(2, window.devicePixelRatio || 1);
      const w = this.canvas.clientWidth, h = this.canvas.clientHeight;
      if (cv.width !== Math.round(w * dpr) || cv.height !== Math.round(h * dpr)) { cv.width = Math.round(w * dpr); cv.height = Math.round(h * dpr); }
      const g = cv.getContext('2d');
      g.setTransform(1, 0, 0, 1, 0, 0);
      g.clearRect(0, 0, cv.width, cv.height);
      if (!list.length || !N.paintProbeMarkers) return;
      g.setTransform(dpr, 0, 0, dpr, 0, 0);
      const pts = [];
      for (const p of list) { const q = this.project(p.at.x, p.at.y, p.at.side || 0); if (q) pts.push([p, q]); }
      N.paintProbeMarkers(g, pts);
    }
    // LED bodies glow with their current; addressable LEDs with the colour a program sends them
    liveLeds(L) {
      const B = this.B, geo = this.box;
      if (!geo.data) return;
      if (!this.liveOrig) this.liveOrig = new Map();
      let changed = false;
      const pix = L.pix && L.pix.size ? [...L.pix].map(([ref, c]) => { const m = Math.max(c[0], c[1], c[2]); return { ref, col: m > 0 ? [c[0] / m * 255, c[1] / m * 255, c[2] / m * 255] : [0, 0, 0], lvl: m / 255, pix: true }; }) : [];
      if (!(L.leds || []).length && !pix.length && !this._pixShown) return;
      this._pixShown = pix.length > 0;
      for (const d of (L.leds || []).concat(pix)) {
        const fi = B.fpIndex(d.ref);
        if (fi < 0) continue;
        const q = d.lvl > 0.05 ? Math.round(d.lvl * 10) / 10 : 0;
        if (d.pix) { const key = q + ':' + d.col.map(Math.round).join(','); if ((this._pixQ || (this._pixQ = new Map())).get(d.ref) === key) continue; this._pixQ.set(d.ref, key); }
        else { if (d._q3 === q) continue; d._q3 = q; }
        if (this.real && this.real.state) {
          const k = 0.3 + 0.7 * q;
          this.partState(fi, this.hl.refs.has(d.ref), q > 0 ? [d.col[0] / 255 * k, d.col[1] / 255 * k, d.col[2] / 255 * k] : null);
          changed = true;
        }
        const i = this.partIndex.indexOf(fi);
        if (i < 0) continue;
        const o = i * 14;
        if (!this.liveOrig.has(i)) this.liveOrig.set(i, [geo.data[o + 7], geo.data[o + 8], geo.data[o + 9], geo.data[o + 12]]);
        const orig = this.liveOrig.get(i);
        if (q > 0) { const k = 0.35 + 0.65 * q; geo.data[o + 7] = d.col[0] / 255 * k; geo.data[o + 8] = d.col[1] / 255 * k; geo.data[o + 9] = d.col[2] / 255 * k; geo.data[o + 12] = 2; }
        else { geo.data[o + 7] = orig[0]; geo.data[o + 8] = orig[1]; geo.data[o + 9] = orig[2]; geo.data[o + 12] = this.hl.refs.has(d.ref) ? 1 : 0; }
        changed = true;
      }
      if (changed) this.setInstances(geo, geo.data);
    }
    setLive(L) {
      if (L) { this.live = L; return; }
      this.live = null;
      this._pixQ = null;
      const R = this.real;
      if (R && R.state) { for (let o = 3; o < R.state.length; o += 4) R.state[o] &= 1; R.stateDirty = true; }
      if (this.markCv) { this.markCv.remove(); this.markCv = null; }
      const geo = this.box;
      if (this.liveOrig && geo.data) {
        for (const [i, o] of this.liveOrig) { geo.data[i * 14 + 7] = o[0]; geo.data[i * 14 + 8] = o[1]; geo.data[i * 14 + 9] = o[2]; geo.data[i * 14 + 12] = this.B && this.hl.refs.has(this.B.fps[this.partIndex[i]].r) ? 1 : 0; }
        this.setInstances(geo, geo.data);
      }
      this.liveOrig = null;
      this.dirty = true;
    }

    // project a board point (mm) to screen px within the canvas
    project(bx, by, side) {
      const { vp } = this.matrices();
      const y = side ? -this.t / 2 : this.t / 2;
      const p = M.xform(vp, [bx - this.center[0], y, by - this.center[1], 1]);
      if (p[3] <= 0) return null;
      return [(p[0] / p[3] * 0.5 + 0.5) * this.canvas.clientWidth, (1 - (p[1] / p[3] * 0.5 + 0.5)) * this.canvas.clientHeight];
    }
    snapshot(type, q) { this.render(); return this.canvas.toDataURL(type || 'image/png', q); }
    destroy() {
      cancelAnimationFrame(this.raf);
      if (this._photo) for (const k of ['top', 'bottom']) if (this._photo[k]) { try { this._photo[k].dispose(); } catch (e) { /* gone */ } }
      this.ro.disconnect();
      const ext = this.gl.getExtension('WEBGL_lose_context');
      if (ext) ext.loseContext();
      this.canvas.remove();
    }
  }
  N.Viewer3D = Viewer3D;
  N.M = M;
})();
