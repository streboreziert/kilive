/* KiLive — photo renderer: physically based stills of a board (2K and up).
   Glossy solder mask over copper, ENIG and soldered pads, silkscreen relief, rounded part bodies with solder fillets,
   gull-wing leads and laser-marked ICs, soft shadows (PCSS) from a studio key light, softbox reflections, ACES tone mapping.
   N.renderPhoto(B, opts) -> Promise<HTMLCanvasElement> (premultiplied RGBA, floor shadow in alpha). */
(function () {
  'use strict';
  const N = window.Noeti;

  // ---------------------------------------------------------------- small math
  const V3 = {
    sub: (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]], add: (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]],
    mul: (a, k) => [a[0] * k, a[1] * k, a[2] * k], dot: (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2],
    cross: (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]],
    norm: a => { const l = Math.hypot(a[0], a[1], a[2]) || 1; return [a[0] / l, a[1] / l, a[2] / l]; },
  };
  function ortho(l, r, b, t, n, f) { return new Float32Array([2 / (r - l), 0, 0, 0, 0, 2 / (t - b), 0, 0, 0, 0, -2 / (f - n), 0, -(r + l) / (r - l), -(t + b) / (t - b), -(f + n) / (f - n), 1]); }
  const hexRGB = h => { const n = parseInt(String(h || '#808080').slice(1), 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255]; };
  const mixRGB = (a, b, t) => [0, 1, 2].map(i => Math.round(a[i] * (1 - t) + b[i] * t));
  const hash = s => { let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return h >>> 0; };

  // ---------------------------------------------------------------- shaders
  const LIGHTING = `
  const float PI = 3.14159265;
  uniform vec3 uEye, uCamF, uCamR, uKeyDir, uKeyCol;
  uniform float uKeyAng, uSbEl, uExposure, uCoatRough;
  uniform sampler2D uShadow; uniform mat4 uLVP; uniform float uShTexel, uPenK, uBias, uNormOff, uSearch;
  const vec2 PD[16] = vec2[16](vec2(-0.94201624,-0.39906216), vec2(0.94558609,-0.76890725), vec2(-0.09418410,-0.92938870), vec2(0.34495938,0.29387760),
    vec2(-0.91588581,0.45771432), vec2(-0.81544232,-0.87912464), vec2(-0.38277543,0.27676845), vec2(0.97484398,0.75648379), vec2(0.44323325,-0.97511554),
    vec2(0.53742981,-0.47373420), vec2(-0.26496911,-0.41893023), vec2(0.79197514,0.19090188), vec2(-0.24188840,0.99706507), vec2(-0.81409955,0.91437590),
    vec2(0.19984126,0.78641367), vec2(0.14383161,-0.14100790));
  float h12(vec2 p) { return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }
  float shadowVis(vec3 P, vec3 Nn) {
    vec4 lp = uLVP * vec4(P + Nn * uNormOff, 1.0);
    vec3 sc = lp.xyz / lp.w * 0.5 + 0.5;
    if (sc.x <= 0.0 || sc.x >= 1.0 || sc.y <= 0.0 || sc.y >= 1.0 || sc.z >= 1.0) return 1.0;
    float z = sc.z - uBias;
    float a = h12(gl_FragCoord.xy) * 6.2831853; mat2 R = mat2(cos(a), sin(a), -sin(a), cos(a));
    float sum = 0.0, cnt = 0.0;
    for (int i = 0; i < 16; i++) { float d = texture(uShadow, sc.xy + R * PD[i] * uSearch).r; if (d < z) { sum += d; cnt += 1.0; } }
    if (cnt < 0.5) return 1.0;
    float pen = clamp((z - sum / cnt) * uPenK, uShTexel * 1.5, uSearch);
    float vis = 0.0;
    for (int i = 0; i < 16; i++) { vec2 o = R * PD[i] * pen; vis += texture(uShadow, sc.xy + o).r < z ? 0.0 : 1.0; vis += texture(uShadow, sc.xy - o * 0.5).r < z ? 0.0 : 1.0; }
    return vis / 32.0;
  }
  float rectL(vec3 d, vec3 c, vec3 u, vec3 v, float hu, float hv, float s) {
    float z = dot(d, c); if (z <= 0.02) return 0.0;
    float a = atan(dot(d, u), z), b = atan(dot(d, v), z);
    return smoothstep(hu + s, hu - s, abs(a)) * smoothstep(hv + s, hv - s, abs(b)) * (hu * hv) / ((hu + s * 0.5) * (hv + s * 0.5));
  }
  // the studio around the board, camera-relative: grey walls, a big softbox where the board mirrors the camera, a rim strip
  vec3 studio(vec3 d, float blur) {
    vec3 up = vec3(0.0, 1.0, 0.0);
    float e = d.y;
    vec3 c = mix(vec3(0.36, 0.355, 0.35), vec3(0.42, 0.42, 0.415), smoothstep(-0.6, 0.02, e));
    c = mix(c, vec3(0.2, 0.205, 0.21), smoothstep(0.05, 0.9, e));
    float s = mix(0.035, 0.75, blur * blur + 0.15 * blur);
    vec3 sb = normalize(uCamF * cos(uSbEl) + up * sin(uSbEl)); vec3 su = normalize(cross(up, sb)); vec3 sv = cross(sb, su);
    c += vec3(1.0, 0.985, 0.96) * 3.4 * rectL(d, sb, su, sv, 0.5, 0.2, s + 0.06);
    vec3 rc = normalize(uCamR * 0.9 + uCamF * 0.35 + up * 0.3); vec3 ru = normalize(cross(up, rc)); vec3 rv = cross(rc, ru);
    c += vec3(0.92, 0.96, 1.0) * 1.7 * rectL(d, rc, ru, rv, 0.07, 0.55, s);
    vec3 fc = normalize(-uCamR * 0.8 - uCamF * 0.2 + up * 0.25); vec3 fu = normalize(cross(up, fc)); vec3 fv = cross(fc, fu);
    c += vec3(1.0, 0.97, 0.93) * 0.6 * rectL(d, fc, fu, fv, 0.4, 0.3, s);
    return c;
  }
  // cosine-weighted average radiance around n (lights as small area sources)
  vec3 studioDiffuse(vec3 n) {
    vec3 up = vec3(0.0, 1.0, 0.0);
    float e = n.y;
    vec3 c = mix(vec3(0.36, 0.355, 0.35), vec3(0.24, 0.245, 0.25), smoothstep(-1.0, 1.0, e));
    vec3 sb = normalize(uCamF * cos(uSbEl) + up * sin(uSbEl));
    c += vec3(1.0, 0.985, 0.96) * 3.4 * (4.0 * 0.5 * 0.2) / PI * max(dot(n, sb) * 0.85 + 0.15, 0.0);
    vec3 rc = normalize(uCamR * 0.9 + uCamF * 0.35 + up * 0.3);
    c += vec3(0.92, 0.96, 1.0) * 1.7 * (4.0 * 0.07 * 0.55) / PI * max(dot(n, rc), 0.0);
    vec3 fc = normalize(-uCamR * 0.8 - uCamF * 0.2 + up * 0.25);
    c += vec3(1.0, 0.97, 0.93) * 0.6 * (4.0 * 0.4 * 0.3) / PI * max(dot(n, fc), 0.0);
    return c;
  }
  vec2 envBRDF(float NoV, float r) {
    const vec4 c0 = vec4(-1.0, -0.0275, -0.572, 0.022); const vec4 c1 = vec4(1.0, 0.0425, 1.04, -0.04);
    vec4 r4 = r * c0 + c1; float a004 = min(r4.x * r4.x, exp2(-9.28 * NoV)) * r4.x + r4.y;
    return vec2(-1.04, 1.04) * a004 + r4.zw;
  }
  float D_GGX(float NoH, float a) { float a2 = a * a; float d = (NoH * a2 - NoH) * NoH + 1.0; return a2 / (PI * d * d); }
  float V_Smith(float NoV, float NoL, float a) { float a2 = a * a; float gv = NoL * sqrt(NoV * NoV * (1.0 - a2) + a2); float gl = NoV * sqrt(NoL * NoL * (1.0 - a2) + a2); return 0.5 / max(gv + gl, 1e-5); }
  vec3 shade(vec3 base, vec3 Nn, vec3 P, float metal, float rough, float coat, float ao) {
    vec3 V = normalize(uEye - P);
    float ndv = dot(Nn, V); if (ndv < 0.0) { Nn = normalize(Nn - V * ndv * 1.02); }
    float NoV = max(dot(Nn, V), 1e-3);
    vec3 L = uKeyDir; float NoL = max(dot(Nn, L), 0.0);
    float vis = NoL > 0.0 ? shadowVis(P, Nn) : 0.0;
    vec3 F0 = mix(vec3(0.04), base, metal); vec3 dc = base * (1.0 - metal);
    vec3 R = reflect(-V, Nn);
    vec2 ab = envBRDF(NoV, rough);
    vec3 col = (dc * studioDiffuse(Nn) + studio(R, rough) * (F0 * ab.x + ab.y)) * ao;
    vec3 H = normalize(L + V); float NoH = max(dot(Nn, H), 0.0), VoH = max(dot(V, H), 0.0);
    float a = max(rough * rough, 0.002), a2 = min(1.0, a + uKeyAng * 0.5);
    vec3 F = F0 + (1.0 - F0) * pow(1.0 - VoH, 5.0);
    col += (dc / PI + D_GGX(NoH, a2) * (a / a2) * (a / a2) * V_Smith(NoV, NoL, a2) * F) * NoL * uKeyCol * vis;
    if (coat > 0.0) {
      float Fc = 0.04 + 0.96 * pow(1.0 - NoV, 5.0);
      vec2 abc = envBRDF(NoV, uCoatRough);
      float ac = uCoatRough * uCoatRough, ac2 = min(1.0, ac + uKeyAng * 0.5);
      float Fk = 0.04 + 0.96 * pow(1.0 - VoH, 5.0);
      vec3 cl = studio(R, uCoatRough) * (0.04 * abc.x + abc.y) * mix(1.0, ao, 0.6) + vec3(D_GGX(NoH, ac2) * (ac / ac2) * (ac / ac2) * V_Smith(NoV, NoL, ac2) * Fk * NoL) * uKeyCol * vis;
      col = col * (1.0 - Fc * coat) + cl * coat;
    }
    return col;
  }
  vec3 tonemap(vec3 x) { x *= uExposure; x = clamp((x * (2.51 * x + 0.03)) / (x * (2.43 * x + 0.59) + 0.14), 0.0, 1.0); return pow(x, vec3(1.0 / 2.2)); }
  float vnoise(vec3 p) { vec3 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
    float n = dot(i, vec3(1.0, 57.0, 113.0));
    vec4 a = fract(sin(vec4(n, n + 1.0, n + 57.0, n + 58.0)) * 43758.5453), b = fract(sin(vec4(n + 113.0, n + 114.0, n + 170.0, n + 171.0)) * 43758.5453);
    vec4 m = mix(a, b, f.z); vec2 m2 = mix(m.xy, m.zw, f.y); return mix(m2.x, m2.y, f.x); }`;

  const VS_MESH = `#version 300 es
  precision highp float;
  layout(location=0) in vec3 aPos; layout(location=1) in vec3 aNrm; layout(location=2) in vec3 aCol; layout(location=3) in vec3 aMat; layout(location=4) in vec3 aExt; layout(location=5) in vec2 aUV;
  uniform mat4 uVP, uModel;
  out vec3 vP, vN, vCol, vMat, vExt, vL; out vec2 vUV;
  void main() { vec4 w = uModel * vec4(aPos, 1.0); vP = w.xyz; vN = mat3(uModel) * aNrm; vCol = aCol; vMat = aMat; vExt = aExt; vUV = aUV; vL = aPos; gl_Position = uVP * w; }`;
  const FS_MESH = `#version 300 es
  precision highp float;
  in vec3 vP, vN, vCol, vMat, vExt, vL; in vec2 vUV;
  uniform sampler2D uAtlas;
  out vec4 o;
  ${LIGHTING}
  void main() {
    vec3 base = pow(vCol, vec3(2.2));
    float metal = vMat.x, rough = max(0.03, vMat.y), coat = vMat.z, ao = vExt.x, grain = vExt.y;
    vec3 Nn = normalize(vN);
    if (grain > 0.0) {
      float g = vnoise(vL * 42.0) * 0.6 + vnoise(vL * 140.0) * 0.4;
      base *= 1.0 + (g - 0.5) * 0.16 * grain; rough = clamp(rough + (g - 0.5) * 0.18 * grain, 0.03, 1.0);
      Nn = normalize(Nn + (vec3(vnoise(vL * 90.0 + 3.1), vnoise(vL * 90.0 + 7.7), vnoise(vL * 90.0 + 1.3)) - 0.5) * 0.05 * grain);
    }
    if (vExt.z > 0.0) {   // brushed metal: fine streaks along x
      float g = vnoise(vec3(vL.x * 6.0, vL.y * 300.0, vL.z * 300.0));
      base *= 0.94 + g * 0.1; rough = clamp(rough + (g - 0.5) * 0.12, 0.05, 1.0);
    }
    if (vUV.x >= 0.0) { vec4 t = texture(uAtlas, vUV); base = mix(base, pow(t.rgb, vec3(2.2)), t.a); rough = mix(rough, 0.8, t.a * 0.85); metal = mix(metal, 0.0, t.a * 0.5); }
    o = vec4(tonemap(shade(base, Nn, vP, metal, rough, coat, ao)), 1.0);
  }`;
  const VS_FACE = `#version 300 es
  precision highp float;
  layout(location=0) in vec3 aPos; layout(location=1) in vec2 aUV;
  uniform mat4 uVP, uModel;
  out vec2 vUV; out vec3 vP;
  void main() { vec4 w = uModel * vec4(aPos, 1.0); vUV = aUV; vP = w.xyz; gl_Position = uVP * w; }`;
  const FS_FACE = `#version 300 es
  precision highp float;
  in vec2 vUV; in vec3 vP;
  uniform sampler2D uAlb, uMat, uHgt, uAO; uniform vec2 uTexel; uniform float uBump, uSide; uniform mat4 uModel;
  out vec4 o;
  ${LIGHTING}
  void main() {
    vec4 a = texture(uAlb, vUV); if (a.a < 0.5) discard;
    vec4 m = texture(uMat, vUV);
    vec2 e = uTexel;
    float t00 = texture(uHgt, vUV + vec2(-e.x, -e.y)).r, t10 = texture(uHgt, vUV + vec2(0.0, -e.y)).r, t20 = texture(uHgt, vUV + vec2(e.x, -e.y)).r;
    float t01 = texture(uHgt, vUV + vec2(-e.x, 0.0)).r, t21 = texture(uHgt, vUV + vec2(e.x, 0.0)).r;
    float t02 = texture(uHgt, vUV + vec2(-e.x, e.y)).r, t12 = texture(uHgt, vUV + vec2(0.0, e.y)).r, t22 = texture(uHgt, vUV + vec2(e.x, e.y)).r;
    float dx = ((t20 + 2.0 * t21 + t22) - (t00 + 2.0 * t01 + t02)) * 0.25, dz = ((t02 + 2.0 * t12 + t22) - (t00 + 2.0 * t10 + t20)) * 0.25;
    vec3 n = vec3(-dx * uBump, uSide, -dz * uBump);
    // orange-peel of the mask and the tooth of the silk
    vec3 q = vec3(vUV * 900.0, uSide);
    n.xz += (vec2(vnoise(q), vnoise(q + 17.0)) - 0.5) * 0.035 * (0.3 + m.b);
    vec3 Nn = normalize(mat3(uModel) * normalize(n));
    float ao = texture(uAO, vUV).r;
    vec3 base = pow(a.rgb, vec3(2.2));
    o = vec4(tonemap(shade(base, Nn, vP, m.r, mix(0.04, 1.0, m.g), m.b, ao)), 1.0);
  }`;
  const VS_DEPTH = `#version 300 es
  precision highp float;
  layout(location=0) in vec3 aPos;
  uniform mat4 uLVP, uModel;
  void main() { gl_Position = uLVP * uModel * vec4(aPos, 1.0); }`;
  const FS_DEPTH = `#version 300 es
  precision highp float;
  void main() {}`;
  const VS_DEPTHF = `#version 300 es
  precision highp float;
  layout(location=0) in vec3 aPos; layout(location=1) in vec2 aUV;
  uniform mat4 uLVP, uModel; out vec2 vUV;
  void main() { vUV = aUV; gl_Position = uLVP * uModel * vec4(aPos, 1.0); }`;
  const FS_DEPTHF = `#version 300 es
  precision highp float;
  in vec2 vUV; uniform sampler2D uAlb;
  void main() { if (texture(uAlb, vUV).a < 0.5) discard; }`;
  const VS_FLOOR = `#version 300 es
  precision highp float;
  layout(location=0) in vec3 aPos; layout(location=1) in vec2 aUV;
  uniform mat4 uVP; out vec3 vP; out vec2 vUV;
  void main() { vP = aPos; vUV = aUV; gl_Position = uVP * vec4(aPos, 1.0); }`;
  const FS_FLOOR = `#version 300 es
  precision highp float;
  in vec3 vP; in vec2 vUV; uniform sampler2D uFloorAO; uniform float uShadowK, uContactK;
  out vec4 o;
  ${LIGHTING}
  void main() {
    float vis = shadowVis(vP, vec3(0.0, 1.0, 0.0));
    float c = 1.0 - texture(uFloorAO, vUV).r;
    float a = clamp((1.0 - vis) * uShadowK + c * uContactK, 0.0, 0.92);
    o = vec4(0.0, 0.0, 0.0, a);
  }`;

  const VS_POST = `#version 300 es
  precision highp float;
  void main() { vec2 p = vec2(gl_VertexID == 1 ? 3.0 : -1.0, gl_VertexID == 2 ? 3.0 : -1.0); gl_Position = vec4(p, 0.0, 1.0); }`;
  // depth of field: each sample counts when its own blur circle reaches this pixel; sharp background never bleeds onto a blurred foreground
  const FS_POST = `#version 300 es
  precision highp float;
  uniform sampler2D uCol, uDep; uniform vec2 uPx; uniform float uNear, uFar, uFocus, uAper, uMaxC;
  out vec4 o;
  float coc(float d) { if (d >= 0.99999) return uMaxC; float z = d * 2.0 - 1.0; z = 2.0 * uNear * uFar / (uFar + uNear - z * (uFar - uNear)); return min(uMaxC, uAper * abs(z - uFocus) / z); }
  void main() {
    vec2 uv = gl_FragCoord.xy * uPx;
    vec4 c0 = texture(uCol, uv); float d0 = texture(uDep, uv).r; float k0 = coc(d0);
    if (uMaxC < 0.5) { o = c0; return; }
    vec4 acc = c0; float ws = 1.0;
    for (int i = 0; i < 40; i++) {
      float r = sqrt((float(i) + 0.5) / 40.0), a = float(i) * 2.39996323, dist = r * uMaxC;
      vec2 su = uv + vec2(cos(a), sin(a)) * dist * uPx;
      float ds = texture(uDep, su).r, ks = coc(ds);
      float w = clamp(ks - dist + 1.0, 0.0, 1.0);
      if (ds > d0) w *= clamp(k0 - dist + 1.0, 0.0, 1.0);
      acc += texture(uCol, su) * w; ws += w;
    }
    o = acc / ws;
  }`;

  function compile(gl, vs, fs) {
    const p = gl.createProgram();
    for (const [type, src] of [[gl.VERTEX_SHADER, vs], [gl.FRAGMENT_SHADER, fs]]) {
      const s = gl.createShader(type);
      gl.shaderSource(s, src); gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error('photo shader: ' + gl.getShaderInfoLog(s));
      gl.attachShader(p, s);
    }
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error('photo link: ' + gl.getProgramInfoLog(p));
    const u = {};
    const n = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS);
    for (let i = 0; i < n; i++) { const info = gl.getActiveUniform(p, i); u[info.name.replace(/\[0\]$/, '')] = gl.getUniformLocation(p, info.name); }
    return { p, u };
  }

  // ---------------------------------------------------------------- materials (sRGB colour, metal, rough, coat; ao, grain, brushed)
  const MAT = {
    epoxy: { col: '#1d1d20', m: [0, 0.52, 0], grain: 1 },
    epoxyGloss: { col: '#18181b', m: [0, 0.3, 0], grain: 0.6 },
    tin: { col: '#c9ccd0', m: [1, 0.3, 0] },
    solder: { col: '#bfc2c6', m: [1, 0.2, 0] },
    gold: { col: '#e0b95e', m: [1, 0.26, 0] },
    alu: { col: '#c8ccd2', m: [1, 0.34, 0], brushed: 1 },
    steel: { col: '#c3c7cc', m: [1, 0.4, 0], brushed: 1 },
    ceramicTan: { col: '#b89568', m: [0, 0.62, 0], grain: 0.5 },
    ceramicWhite: { col: '#e6e3da', m: [0, 0.55, 0], grain: 0.4 },
    resTop: { col: '#141416', m: [0, 0.38, 0], grain: 0.5 },
    ferrite: { col: '#3b3b3e', m: [0, 0.7, 0], grain: 1 },
    plasticBlack: { col: '#1c1c1f', m: [0, 0.45, 0], grain: 0.7 },
    fr4: { col: '#b3a47a', m: [0, 0.7, 0], grain: 0.8 },
    substrate: { col: '#2c3a2c', m: [0, 0.4, 0.6] },
    lens: { col: '#f3f0e6', m: [0, 0.08, 1] },
  };
  const styleOf = (name, over) => {
    const b = MAT[name] || MAT.epoxy;
    const s = { col: hexRGB(over && over.col || b.col), m: (over && over.m) || b.m, grain: over && over.grain != null ? over.grain : b.grain || 0, brushed: b.brushed || 0, uv: null };
    return s;
  };

  // ---------------------------------------------------------------- mesh builder (indexed; colour / material as bytes)
  class Mesh {
    constructor() { this.P = []; this.Nn = []; this.C = []; this.Mt = []; this.E = []; this.U = []; this.I = []; this.n = 0; this.minY = Infinity; this.maxY = -Infinity; }
    v(p, n, st, ao, uv) {
      this.P.push(p[0], p[1], p[2]); this.Nn.push(n[0], n[1], n[2]);
      this.C.push(st.col[0], st.col[1], st.col[2]);
      this.Mt.push(Math.round(st.m[0] * 255), Math.round(st.m[1] * 255), Math.round(st.m[2] * 255));
      this.E.push(Math.round(Math.max(0, Math.min(1, ao)) * 255), Math.round((st.grain || 0) * 255), st.brushed ? 255 : 0);
      this.U.push(uv ? uv[0] : -1, uv ? uv[1] : -1);
      if (p[1] < this.minY) this.minY = p[1]; if (p[1] > this.maxY) this.maxY = p[1];
      return this.n++;
    }
    t(a, b, c) { this.I.push(a, b, c); }
    q(a, b, c, d) { this.I.push(a, b, c, a, c, d); }
  }
  // local footprint frame -> world (x along footprint x, z along footprint y, y up from the board surface)
  function frame(f, cx, cy, t) {
    const a = f.a * Math.PI / 180, c = Math.cos(a), s = Math.sin(a), sg = f.s === 0 ? 1 : -1;
    return { ox: f.x - cx, oz: f.y - cy, c, s, sg, y0: sg * t / 2,
      p(x, y, z) { return [this.ox + x * c + z * s, this.y0 + sg * y, this.oz - x * s + z * c]; },
      n(x, y, z) { return [x * c + z * s, sg * y, -x * s + z * c]; } };
  }
  const aoAt = y => 0.5 + 0.5 * Math.min(1, Math.max(0, y / 0.7));
  function axis(h, r, m) {
    const a = [];
    for (let k = 0; k <= m; k++) a.push(-(h - r) - r * Math.cos(Math.PI / 2 * k / m));
    for (let k = m; k >= 0; k--) a.push((h - r) + r * Math.cos(Math.PI / 2 * k / m));
    return a;
  }
  // rounded box: centre (cx, cz) in the footprint frame, from y0 up by h; r = edge radius; no bottom face
  function rbox(M, F, cx, cz, y0, sx, h, sz, r, st, opt) {
    const hx = sx / 2, hy = h / 2, hz = sz / 2;
    r = Math.max(0.001, Math.min(r, hx * 0.999, hy * 0.999, hz * 0.999));
    const m = Math.max(sx, sz) < 1.4 ? 1 : 2;
    const ax = axis(hx, r, m), ay = axis(hy, r, m), az = axis(hz, r, m);
    const uvr = opt && opt.uv, flipU = opt && opt.flipU;
    const put = (x, y, z, top) => {
      const qx = Math.max(-(hx - r), Math.min(hx - r, x)), qy = Math.max(-(hy - r), Math.min(hy - r, y)), qz = Math.max(-(hz - r), Math.min(hz - r, z));
      let dx = x - qx, dy = y - qy, dz = z - qz; const L = Math.hypot(dx, dy, dz) || 1; dx /= L; dy /= L; dz /= L;
      const lx = cx + qx + dx * r, ly = y0 + hy + qy + dy * r, lz = cz + qz + dz * r;
      let uv = null;
      if (top && uvr) { let u = (x + hx) / sx; if (flipU) u = 1 - u; uv = [uvr[0] + u * (uvr[2] - uvr[0]), uvr[1] + (z + hz) / sz * (uvr[3] - uvr[1])]; }
      return M.v(F.p(lx, ly, lz), F.n(dx, dy, dz), st, top ? 1 : aoAt(ly), uv);
    };
    const grid = (A, Bv, fn) => {
      const id = [];
      for (let j = 0; j < Bv.length; j++) for (let i = 0; i < A.length; i++) id.push(fn(A[i], Bv[j]));
      for (let j = 0; j < Bv.length - 1; j++) for (let i = 0; i < A.length - 1; i++) { const k = j * A.length + i; M.q(id[k], id[k + 1], id[k + A.length + 1], id[k + A.length]); }
    };
    grid(ax, az, (x, z) => put(x, hy, z, true));
    grid(az, ay, (z, y) => put(hx, y, z));
    grid(az, ay, (z, y) => put(-hx, y, z));
    grid(ax, ay, (x, y) => put(x, y, hz));
    grid(ax, ay, (x, y) => put(x, y, -hz));
  }
  // straight bar between two points of the footprint frame (leads), w wide (horizontal), th thick
  function bar(M, F, A, B, w, th, st) {
    const d = V3.norm(V3.sub(B, A));
    let lat = V3.cross(d, [0, 1, 0]); if (Math.hypot(...lat) < 1e-6) lat = [1, 0, 0]; lat = V3.norm(lat);
    const up = V3.norm(V3.cross(lat, d));
    const c = (P, sl, su) => V3.add(P, V3.add(V3.mul(lat, sl * w / 2), V3.mul(up, su * th / 2)));
    const pts = [c(A, -1, -1), c(A, 1, -1), c(A, 1, 1), c(A, -1, 1), c(B, -1, -1), c(B, 1, -1), c(B, 1, 1), c(B, -1, 1)];
    const face = (ids, n) => { const v = ids.map(i => M.v(F.p(...pts[i]), F.n(...n), st, aoAt(pts[i][1]))); M.q(v[0], v[1], v[2], v[3]); };
    face([3, 2, 6, 7], up); face([0, 4, 5, 1], V3.mul(up, -1)); face([1, 5, 6, 2], lat); face([0, 3, 7, 4], V3.mul(lat, -1));
    face([4, 7, 6, 5], d); face([0, 1, 2, 3], V3.mul(d, -1));
  }
  // concave solder meniscus along x: from (x0, h) at the part down to (x1, 0) on the pad, width w around z = cz
  function fillet(M, F, x0, x1, cz, w, h, st) {
    const seg = 5, rows = [];
    for (let i = 0; i <= seg; i++) {
      const s = i / seg, x = x0 + (x1 - x0) * s, y = h * (1 - s) * (1 - s) + 0.012;
      const dyds = -2 * h * (1 - s), dx = x1 - x0;
      let n = V3.norm([-dyds * Math.sign(dx || 1), Math.abs(dx), 0]);
      const bulge = 0.5 + 0.5 * Math.sin(Math.PI * Math.min(1, s * 1.2));
      const ww = w * (0.92 + 0.08 * bulge);
      rows.push([M.v(F.p(x, y, cz - ww / 2), F.n(n[0], n[1], -0.25), st, 1), M.v(F.p(x, y, cz), F.n(...n), st, 1), M.v(F.p(x, y, cz + ww / 2), F.n(n[0], n[1], 0.25), st, 1)]);
    }
    for (let i = 0; i < seg; i++) for (let j = 0; j < 2; j++) M.q(rows[i][j], rows[i + 1][j], rows[i + 1][j + 1], rows[i][j + 1]);
  }
  // cylinder standing on y0: radius R, height h, rounded top edge rr; top disc split by an optional marking half-plane
  function cyl(M, F, cx, cz, y0, R, h, rr, sideSt, topSt, mark) {
    const seg = R > 2 ? 48 : 28;
    rr = Math.min(rr, R * 0.5, h * 0.5);
    const prof = [];
    prof.push([R, 0, 1, 0]); prof.push([R, h - rr, 1, 0]);
    for (let k = 1; k <= 4; k++) { const a = Math.PI / 2 * k / 4; prof.push([R - rr + rr * Math.cos(a), h - rr + rr * Math.sin(a), Math.cos(a), Math.sin(a)]); }
    const rings = [];
    for (let i = 0; i <= seg; i++) {
      const a = i / seg * Math.PI * 2, ca = Math.cos(a), sa = Math.sin(a);
      const ring = [];
      for (let k = 0; k < prof.length; k++) {
        const [r, y, nr, ny] = prof[k];
        const st = mark && mark.stripe != null && Math.cos(a - mark.stripe) > 0.8 && k < 2 ? mark.stripeSt : sideSt;
        ring.push(M.v(F.p(cx + ca * r, y0 + y, cz + sa * r), F.n(ca * nr, ny, sa * nr), k < 2 ? st : sideSt, k < 2 ? aoAt(y0 + y) : 1));
      }
      rings.push(ring);
    }
    for (let i = 0; i < seg; i++) for (let k = 0; k < prof.length - 1; k++) M.q(rings[i][k], rings[i + 1][k], rings[i + 1][k + 1], rings[i][k + 1]);
    // top disc
    const rt = R - rr;
    const c0 = M.v(F.p(cx, y0 + h, cz), F.n(0, 1, 0), topSt, 1);
    for (let i = 0; i < seg; i++) {
      const a0 = i / seg * Math.PI * 2, a1 = (i + 1) / seg * Math.PI * 2, am = (a0 + a1) / 2;
      const st = mark && mark.half != null && Math.cos(am - mark.half) > 0.25 ? mark.halfSt : topSt;
      const v0 = M.v(F.p(cx + Math.cos(a0) * rt, y0 + h, cz + Math.sin(a0) * rt), F.n(0, 1, 0), st, 1);
      const v1 = M.v(F.p(cx + Math.cos(a1) * rt, y0 + h, cz + Math.sin(a1) * rt), F.n(0, 1, 0), st, 1);
      const cc = st === topSt ? c0 : M.v(F.p(cx, y0 + h, cz), F.n(0, 1, 0), st, 1);
      M.t(cc, v0, v1);
    }
  }

  // ---------------------------------------------------------------- IC marking atlas
  function markText(f) {
    let v = String(f.v || '').replace(/[_]/g, '-').replace(/\s+/g, ' ').trim();
    if (!v || /^[~?]$/.test(v) || v.length > 22) v = v.slice(0, 22);
    return v.toUpperCase();
  }
  class Atlas {
    constructor(size) { this.cv = document.createElement('canvas'); this.cv.width = this.cv.height = size; this.g = this.cv.getContext('2d'); this.size = size; this.x = 2; this.y = 2; this.rowH = 0; }
    alloc(w, h) {
      w = Math.min(this.size - 4, Math.ceil(w)); h = Math.min(this.size - 4, Math.ceil(h));
      if (this.x + w + 2 > this.size) { this.x = 2; this.y += this.rowH + 2; this.rowH = 0; }
      if (this.y + h + 2 > this.size) return null;
      const r = [this.x, this.y, w, h]; this.x += w + 2; this.rowH = Math.max(this.rowH, h); return r;
    }
    uv(r) { return [r[0] / this.size, r[1] / this.size, (r[0] + r[2]) / this.size, (r[1] + r[3]) / this.size]; }
  }
  // text for the top of a part: the value, a date / lot code and the pin-1 dimple
  function paintMark(A, f, sx, sz, kind, pin1) {
    const ppm = Math.max(10, Math.min(48, 420 / Math.max(sx, sz)));
    const r = A.alloc(sx * ppm, sz * ppm);
    if (!r) return null;
    const g = A.g;
    g.save(); g.translate(r[0], r[1]); g.scale(r[2] / sx, r[3] / sz);
    const vertical = sz > sx * 1.25;
    const W = vertical ? sz : sx, H = vertical ? sx : sz;
    g.translate(sx / 2, sz / 2); if (vertical) g.rotate(-Math.PI / 2);
    const txt = markText(f);
    const h = hash(f.r + txt);
    const code = String.fromCharCode(65 + (h % 26)) + String(10 + ((h >>> 5) % 90)) + String.fromCharCode(65 + ((h >>> 11) % 26)) + String(100 + ((h >>> 17) % 900));
    const col = kind === 'can' ? 'rgba(52,54,58,0.82)' : 'rgba(196,198,200,0.9)';
    g.fillStyle = col; g.textAlign = 'center'; g.textBaseline = 'middle';
    const lines = kind === 'can' ? [txt] : W > 2.2 && H > 1.6 ? [txt, code] : [txt];
    let fs = Math.min(H * (lines.length > 1 ? 0.24 : 0.36), 2.2);
    g.font = `600 ${fs}px "IBM Plex Sans Condensed", "Arial Narrow", sans-serif`;
    const maxW = W * 0.84;
    const tw = Math.max(...lines.map(l => g.measureText(l).width));
    if (tw > maxW) { fs *= maxW / tw; g.font = `600 ${fs}px "IBM Plex Sans Condensed", "Arial Narrow", sans-serif`; }
    if (fs * Math.min(r[2] / sx, r[3] / sz) >= 3.5) lines.forEach((l, i) => g.fillText(l, 0, (i - (lines.length - 1) / 2) * fs * 1.25));
    g.restore();
    if (pin1 && kind !== 'can') {
      g.save(); g.translate(r[0], r[1]); g.scale(r[2] / sx, r[3] / sz);
      const d = Math.max(0.18, Math.min(0.55, Math.min(sx, sz) * 0.09));
      const px = pin1[0] < 0 ? d * 1.7 : sx - d * 1.7, pz = pin1[1] < 0 ? d * 1.7 : sz - d * 1.7;
      g.fillStyle = 'rgba(6,6,7,0.85)'; g.beginPath(); g.arc(px, pz, d, 0, Math.PI * 2); g.fill();
      g.strokeStyle = 'rgba(120,120,124,0.35)'; g.lineWidth = d * 0.25; g.stroke();
      g.restore();
    }
    return A.uv(r);
  }

  // ---------------------------------------------------------------- the parts
  // the moulded body of an IC: inside the pad rows for gull-wing packages (the stored box can be the courtyard), as stored for QFN / BGA
  const FLUSH = /qfn|dfn|\bson|[-_]son|wson|uson|vson|xson|lga|bga|csp|lfcsp|pdfn|powerpak|dpak|to-?252|to-?263|sot-?89|d2pak|hsop|so-?8ep|smd-?8|mlf|mlp/;
  const GULL = /qfp|soic|\bsop|[-_]sop|ssop|tssop|msop|vssop|tsop|sot-?23|sot-?323|sot-?363|sot-?353|sot-?143|sot-?223|sot-?25|sot-?26|sc-?70|sc-?74|sc-?88|so-?\d|\bso\d/;
  function icBody(b, smd, name) {
    let x0 = b[0], x1 = b[2], z0 = b[1], z1 = b[3], gull = false;
    if (FLUSH.test(name) || smd.length < 3) return { x0, x1, z0, z1, gull };
    const rows = { px: [], nx: [], pz: [], nz: [] };
    for (const q of smd) { const ax = Math.abs(q.x) - q.w / 2, az = Math.abs(q.z) - q.d / 2; if (ax >= az) (q.x > 0 ? rows.px : rows.nx).push(q); else (q.z > 0 ? rows.pz : rows.nz).push(q); }
    const inP = (l, k, n) => Math.min(...l.map(q => q[k] - q[n] / 2)), inN = (l, k, n) => Math.max(...l.map(q => q[k] + q[n] / 2));
    const named = GULL.test(name);
    let gx = false, gz = false;
    if (rows.px.length && rows.nx.length) {
      const ep = inP(rows.px, 'x', 'w'), en = inN(rows.nx, 'x', 'w'), d = Math.min(0.25, (ep - en) * 0.05);
      if (ep > en + 0.4 && (named || (ep - en) / 2 > 0.62 * (b[2] - b[0]) / 2)) { x1 = ep - d; x0 = en + d; gx = true; }
    }
    if (rows.pz.length && rows.nz.length) {
      const ep = inP(rows.pz, 'z', 'd'), en = inN(rows.nz, 'z', 'd'), d = Math.min(0.25, (ep - en) * 0.05);
      if (ep > en + 0.4 && (named || (ep - en) / 2 > 0.62 * (b[3] - b[1]) / 2)) { z1 = ep - d; z0 = en + d; gz = true; }
    }
    const pitch = v => { const s2 = [...new Set(v.map(x => x.toFixed(2)))].map(Number).sort((a, c) => a - c); let p = 1e9; for (let i = 1; i < s2.length; i++) p = Math.min(p, s2[i] - s2[i - 1]); return p > 1e8 ? 0.6 : p; };
    if (gx && !gz) { const zs = rows.px.concat(rows.nx).map(q => q.z); const lo = Math.min(...zs), hi = Math.max(...zs), m = Math.max(0.3, pitch(zs) * 0.6); z0 = Math.min(lo - m, (b[1] + b[3]) / 2 - (b[3] - b[1]) * 0.45); z1 = Math.max(hi + m, (b[1] + b[3]) / 2 + (b[3] - b[1]) * 0.45); }
    if (gz && !gx) { const xs = rows.pz.concat(rows.nz).map(q => q.x); const lo = Math.min(...xs), hi = Math.max(...xs), m = Math.max(0.3, pitch(xs) * 0.6); x0 = Math.min(lo - m, (b[0] + b[2]) / 2 - (b[2] - b[0]) * 0.45); x1 = Math.max(hi + m, (b[0] + b[2]) / 2 + (b[2] - b[0]) * 0.45); }
    return { x0, x1, z0, z1, gull: gx || gz };
  }
  // the importer's body class from designator prefixes, refined from the value and footprint for the photo (descriptive
  // designators like DVI1, MICRO_SD1 or LED_HOST1 otherwise come out as chips)
  function refine(f) {
    let [cls, h, color] = f.z;
    const ref = String(f.r || '').toUpperCase(), t = (String(f.v || '') + ' ' + String(f.fp || '')).toLowerCase();
    if (/testpad|test_pad|test-pad|solder.?jumper|jumper_sm|\bsj\b|^sj$|nettie|net_tie|fiducial/.test(t) || /^(SJ|TP|FID|GND\d|JP)\d/.test(ref) && cls === 'ic') return ['none', 0, null];
    const chipSize = /0201|0402|0603|0805|1206/.exec(t);
    if (/^led|led[\/_ ]|_led\b|\bled\b/.test(t) && cls !== 'module' && Math.max(f.b[2] - f.b[0], f.b[3] - f.b[1]) < 6.5) return ['led', chipSize ? 0.55 : Math.max(0.8, Math.min(h, 1.6)), '#f2efe4'];
    if (/yts-|\bts-?\d|tact|button|\bsw\b|switch|\bss-\d|slide|b3[fus]|evq|kmr|pts\d|skrp|tl3/.test(t) && cls !== 'module') return ['switch', Math.max(1.2, h), cls === 'switch' ? color : '#2a2a2c'];
    if (/hdmi|\bdvi|displayport/.test(t)) return ['metal', Math.max(h, 3.4), '#c3c7cc'];
    if (/tf.?card|tfc-|micro.?sd|\busd\b|usd\(|sd.?card|sdcard|\bsim\b|nano.?sim/.test(t)) return ['metal', Math.max(Math.min(h, 2.2), 1.6), '#c3c7cc'];
    if (/rj-?45|rjp-|ethernet|magjack/.test(t)) return ['metal', Math.max(h, 11), '#c3c7cc'];
    if (/ph2\.0|\bph-|jst|pwb|xh-?\d|zh-?\d|sh1\.0|picoblade|bm\d+b|srss|ghr|\bgh-/.test(t)) return ['plastic', /sh1\.0|srss|bm\d+b/.test(t) ? 2.9 : Math.max(h, 4.2), '#efe7d4'];
    if (/\bpj-|jack|audio|\btrs\b|3\.5mm|phone/.test(t)) return ['plastic', Math.max(h, 4.5), '#1d1d20'];
    if (/gbh-|box.?header|\bidc\b|p-b-v|uext|shrouded/.test(t)) return ['plastic', Math.max(h, 6), '#1d1d20'];
    if (/fpc|ffc|fpa-|fh12|fh19|1734248|zif/.test(t)) return ['plastic', Math.max(1.2, Math.min(h, 2.6)), '#2a2a2c'];
    if (cls === 'ic' && /^(J|P|CN|CON|X|USB|HDMI|DVI|UEXT|EXT|SWD|JTAG|PWR|BAT|LAN|SD|MICRO|POE|MIPI|LINE|HEADSET|SPK|LSPK|RSPK)/.test(ref)) return ['plastic', Math.max(h, 2), '#1d1d20'];
    return [cls, h, color];
  }
  // far = the side whose parts face the floor (0 top, 1 bottom): its tall bodies are left out so the board lies flat
  function buildParts(B, M, A, t, cx, cy, far) {
    const bbA = Math.max(1, (B.bbox[2] - B.bbox[0]) * (B.bbox[3] - B.bbox[1]));
    const pop = new Set();
    B.fps.forEach((f, fi) => {
      if (!f.z || f.z[0] === 'none' || !f.b || f.dnp) return;
      const z = refine(f);
      if (z[0] === 'none') return;
      if ((f.b[2] - f.b[0]) * (f.b[3] - f.b[1]) > 0.8 * bbA) return;
      const [cls, h0, color] = z;
      if (!h0) return;
      const b = f.b;
      const sx = b[2] - b[0], sz = b[3] - b[1];
      if (sx < 0.05 || sz < 0.05) return;
      pop.add(fi);
      const F = frame(f, cx, cy, t);
      const bx = (b[0] + b[2]) / 2, bz = (b[1] + b[3]) / 2;
      const name = String(f.fp || '').toLowerCase();
      const h = h0;
      // pads in the footprint frame
      const a = f.a * Math.PI / 180, ca = Math.cos(a), sa = Math.sin(a);
      const pads = (f.pads || []).map(pi => {
        const p = B.pads[pi]; const dx = p[4] - f.x, dy = p[5] - f.y;
        // inverse of N.rot: local = R^-1 * d
        const lx = dx * ca - dy * sa, lz = dx * sa + dy * ca;
        const rel = (((p[8] || 0) - f.a) % 180 + 180) % 180;
        const swap = rel > 45 && rel < 135;
        return { p, x: lx, z: lz, w: swap ? p[7] : p[6], d: swap ? p[6] : p[7], tht: p[2] === 1, name: String(p[1]) };
      });
      const smd = pads.filter(q => !q.tht && q.p[2] !== 2);
      const colS = { col: color || undefined };
      const tht = pads.filter(q => q.tht);
      const hidden = far != null && f.s === far && h > 2.4;
      // solder joints of through-hole parts on the far side
      if (cls !== 'header' && tht.length) {
        const Fo = Object.assign({}, F, { sg: -F.sg, y0: -F.y0 });
        Fo.p = function (x, y, zz) { return [this.ox + x * this.c + zz * this.s, this.y0 + this.sg * y, this.oz - x * this.s + zz * this.c]; };
        Fo.n = function (x, y, zz) { return [x * this.c + zz * this.s, this.sg * y, -x * this.s + zz * this.c]; };
        for (const q of tht.slice(0, 80)) {
          const dm = Math.max(0.6, Math.min(q.w, q.d) * 0.85);
          rbox(M, Fo, q.x, q.z, 0, dm, Math.min(0.75, dm * 0.45), dm, dm * 0.42, styleOf('solder'));
          rbox(M, Fo, q.x, q.z, 0.3, 0.5, 1.1, 0.5, 0.12, styleOf('tin'));
        }
      }
      if (hidden && cls !== 'header') return;
      // two-terminal chip parts
      const chip = (cls === 'res' || cls === 'cap' || cls === 'ind' || cls === 'led' || cls === 'diode' || cls === 'tant') && Math.max(sx, sz) < 8 && smd.length === 2;
      if (chip) {
        const alongX = sx >= sz, L = alongX ? sx : sz, Wd = alongX ? sz : sx;
        // work in a frame where the part runs along x
        const G = alongX ? F : { p: (x, y, zz) => F.p(zz, y, x), n: (x, y, zz) => F.n(zz, y, x) };
        const ox = alongX ? bx : bz, oz = alongX ? bz : bx;
        const capL = Math.max(0.08, L * (cls === 'res' ? 0.14 : 0.18));
        const bodyL = L * 0.98;
        const rr = Math.min(Wd, h) * 0.12;
        if (cls === 'res') {
          rbox(M, G, ox, oz, 0, bodyL - capL * 0.4, h * 0.93, Wd * 0.97, rr, styleOf('ceramicWhite'));
          rbox(M, G, ox, oz, h * 0.72, bodyL - capL * 2.1, h * 0.26, Wd * 0.9, rr * 0.6, styleOf('resTop'));
        } else if (cls === 'cap') rbox(M, G, ox, oz, 0, bodyL - capL * 0.4, h * 0.98, Wd * 0.97, rr * 1.3, styleOf('ceramicTan', colS.col && colS.col !== '#b88a5a' ? colS : null));
        else if (cls === 'ind') rbox(M, G, ox, oz, 0, bodyL - capL * 0.4, h * 0.98, Wd * 0.97, rr, styleOf('ferrite'));
        else if (cls === 'tant') {
          rbox(M, G, ox, oz, 0, bodyL - capL * 1.2, h, Wd * 0.95, rr * 1.5, styleOf('epoxy', { col: '#c8952c', m: [0, 0.45, 0], grain: 0.5 }));
          const p1 = smd.find(q => q.name === '1') || smd[0]; const s1 = Math.sign((alongX ? p1.x : p1.z) - ox) || 1;
          rbox(M, G, ox + s1 * (bodyL / 2 - capL * 1.2), oz, h * 0.99, bodyL * 0.12, 0.02, Wd * 0.9, 0.005, styleOf('epoxy', { col: '#7a5518', m: [0, 0.5, 0] }));
        } else if (cls === 'diode') {
          rbox(M, G, ox, oz, 0, bodyL - capL * 0.8, h, Wd * 0.95, rr * 1.2, styleOf('epoxy'));
          const p1 = smd.find(q => q.name === '1' || /^k$/i.test(q.name)) || smd[0]; const s1 = Math.sign((alongX ? p1.x : p1.z) - ox) || 1;
          rbox(M, G, ox + s1 * (bodyL / 2 - capL * 1.6), oz, h * 0.995, bodyL * 0.1, 0.015, Wd * 0.88, 0.005, styleOf('epoxy', { col: '#a7a9ad', m: [0, 0.6, 0] }));
        } else {   // LED: white housing, glossy tinted lens
          rbox(M, G, ox, oz, 0, bodyL - capL * 0.6, h * 0.8, Wd * 0.97, rr, styleOf('ceramicWhite', { col: '#ece9e1' }));
          const lc = N.ledColor ? N.ledColor([f.v, f.d].join(' ')) : [255, 80, 60];
          const tint = mixRGB([248, 246, 240], lc, 0.45);
          rbox(M, G, ox, oz, h * 0.78, (bodyL - capL * 1.6) * 0.9, h * 0.22, Wd * 0.8, Math.min(Wd, h) * 0.1, { col: tint, m: [0, 0.06, 1], grain: 0, brushed: 0 });
        }
        // terminations and fillets
        for (const s of [-1, 1]) {
          const ex = ox + s * (L / 2 - capL / 2);
          rbox(M, G, ex, oz, 0, capL, h * (cls === 'res' ? 0.96 : 1.0), Wd * 0.99, Math.min(capL, h) * 0.2, styleOf('tin'));
          const pad = smd.reduce((best, q) => { const px = alongX ? q.x : q.z; return Math.sign(px - ox) === s ? q : best; }, null);
          if (pad) {
            const pc = alongX ? pad.x : pad.z, plen = alongX ? pad.w : pad.d, pw = alongX ? pad.d : pad.w;
            const outer = pc + s * plen / 2, end = ox + s * L / 2;
            if ((outer - end) * s > 0.03) fillet(M, G, end, outer - s * 0.03, alongX ? pad.z : pad.x, Math.min(pw, Wd) * 0.95, Math.min(h * 0.55, 0.45), styleOf('solder'));
          }
        }
        return;
      }
      if (cls === 'led') {
        rbox(M, F, bx, bz, 0, sx * 0.97, h * 0.78, sz * 0.97, Math.min(sx, sz) * 0.06, styleOf('ceramicWhite', { col: '#eeebe3' }));
        const lc = N.ledColor ? N.ledColor([f.v, f.d].join(' ')) : [255, 250, 235];
        rbox(M, F, bx, bz, h * 0.76, sx * 0.8, h * 0.24, sz * 0.8, Math.min(sx, sz) * 0.2, { col: mixRGB([246, 243, 232], lc, 0.2), m: [0, 0.05, 1], grain: 0, brushed: 0 });
        for (const q of smd) rbox(M, F, q.x, q.z, 0, Math.min(q.w, 0.9), 0.12, Math.min(q.d, 0.9), 0.04, styleOf('solder'));
        return;
      }
      if (cls === 'frame') {
        const wt = 0.25;
        for (const [ox, oz, wx, wz] of [[bx, b[1] + wt / 2, sx, wt], [bx, b[3] - wt / 2, sx, wt], [b[0] + wt / 2, bz, wt, sz], [b[2] - wt / 2, bz, wt, sz]]) rbox(M, F, ox, oz, 0, wx, h, wz, 0.05, styleOf('steel'));
        return;
      }
      if (cls === 'elco') {
        const d = Math.min(sx, sz) * 0.94;
        const p2 = pads.find(q => q.name === '2');
        const negA = p2 ? Math.atan2(p2.z - bz, p2.x - bx) : 0;
        if (h > 6 || tht.length) {   // radial through-hole can: sleeve with the minus stripe, aluminium top
          cyl(M, F, bx, bz, 0.4, d / 2, h - 0.4, 0.5, styleOf('epoxy', { col: color || '#1d2a4a', m: [0, 0.32, 0.4], grain: 0 }), styleOf('alu'), { stripe: negA, stripeSt: styleOf('epoxy', { col: '#9aa3b5', m: [0, 0.4, 0.3], grain: 0 }) });
        } else {   // SMD can on a plastic seat, black half-moon on the minus side
          rbox(M, F, bx, bz, 0, sx * 0.98, Math.min(0.5, h * 0.12), sz * 0.98, 0.1, styleOf('plasticBlack'));
          cyl(M, F, bx, bz, Math.min(0.5, h * 0.12), d / 2, h - Math.min(0.5, h * 0.12), 0.35, styleOf('alu'), styleOf('alu'), { half: negA, halfSt: styleOf('epoxy', { col: '#15171c', m: [0, 0.4, 0], grain: 0 }) });
        }
        return;
      }
      if (cls === 'header') {
        const tp = pads.filter(q => q.tht);
        const edge = q => { const bb = B.bbox, wx = q.p[4], wy = q.p[5]; return wx - bb[0] < 0.9 || bb[2] - wx < 0.9 || wy - bb[1] < 0.9 || bb[3] - wy < 0.9; };
        if (tp.length < pads.length * 0.6 || tp.filter(edge).length > tp.length * 0.4) return;
        if (!hidden) rbox(M, F, bx, bz, 0, sx * 0.99, 2.5, sz * 0.99, 0.18, styleOf('plasticBlack'));
        for (const q of tp) {
          rbox(M, F, q.x, q.z, -t - 3.0, 0.64, hidden ? 3.0 + t : 11.5 + t, 0.64, 0.14, styleOf('gold'));
          const Fo = { p: (x, y, zz) => F.p(x, -t - y, zz), n: (x, y, zz) => F.n(x, -y, zz) };
          rbox(M, Fo, q.x, q.z, 0, Math.min(1.7, q.w * 0.95), 0.7, Math.min(1.7, q.d * 0.95), 0.6, styleOf('solder'));
        }
        return;
      }
      if (cls === 'switch') {
        const kb = /kailh|mx|choc|hotswap/.test(name);
        const slide = /slide|\bss-\d|spdt|dpdt|\bss\d/.test((String(f.v || '') + ' ' + name).toLowerCase());
        if (slide) {
          const along = sx >= sz, L = along ? sx : sz, Wd = along ? sz : sx;
          rbox(M, F, bx, bz, 0, sx * 0.96, h * 0.7, sz * 0.96, 0.12, styleOf('steel'));
          const kx = along ? bx - L * 0.12 : bx, kz = along ? bz : bz - L * 0.12;
          rbox(M, F, kx, kz, h * 0.7, along ? L * 0.22 : Wd * 0.38, h * 0.55, along ? Wd * 0.38 : L * 0.22, 0.1, styleOf('plasticBlack'));
          return;
        }
        rbox(M, F, bx, bz, 0, sx * 0.98, kb ? h : h * 0.62, sz * 0.98, kb ? 0.4 : 0.15, kb ? styleOf('plasticBlack', { col: color || '#e8e3d6' }) : styleOf('plasticBlack'));
        if (!kb) {
          if (Math.abs(sx - sz) < Math.max(sx, sz) * 0.35) {
            rbox(M, F, bx, bz, h * 0.62, sx * 0.9, 0.12, sz * 0.9, 0.05, styleOf('steel'));
            const bd = Math.min(sx, sz) * 0.5;
            cyl(M, F, bx, bz, h * 0.62, bd / 2, h * 0.38, bd * 0.12, styleOf('plasticBlack', { col: '#2a2b2e' }), styleOf('plasticBlack', { col: '#2a2b2e' }));
          } else rbox(M, F, bx, bz, h * 0.62, Math.min(sx, sz) * 0.4, h * 0.38, Math.min(sx, sz) * 0.4, 0.08, styleOf('plasticBlack', { col: '#d9dadc' }));
        }
        return;
      }
      if (cls === 'xtal') {
        if (h > 2) { rbox(M, F, bx, bz, 0, sx * 0.97, h, sz * 0.97, Math.min(sx, sz) * 0.35, styleOf('steel')); return; }
        rbox(M, F, bx, bz, 0, sx * 0.98, h * 0.35, sz * 0.98, 0.08, styleOf('ceramicTan', { col: '#d6c7a6' }));
        const can = color && hexRGB(color)[0] < 80;
        const uv = can ? null : paintMark(A, f, sx * 0.86, sz * 0.86, 'can');
        rbox(M, F, bx, bz, h * 0.3, sx * 0.86, h * 0.7, sz * 0.86, 0.12, can ? styleOf('plasticBlack') : styleOf('steel'), { uv, flipU: f.s === 1 });
        return;
      }
      if (cls === 'module') {
        const metalCan = /esp|wroom|wrover|rak|nrf|bmd|module|wifi|ble|lora|rp2040|pico/.test(name + ' ' + String(f.v || '').toLowerCase()) && Math.max(sx, sz) < 45;
        if (metalCan) {
          // the antenna end is the side of the body without pads
          const side = [[1, 0], [-1, 0], [0, 1], [0, -1]].map(([ux, uz]) => {
            const edge = ux ? (ux > 0 ? b[2] : b[0]) : (uz > 0 ? b[3] : b[1]);
            const near = pads.filter(q => Math.abs((ux ? q.x : q.z) - edge) < 2.2).length;
            return { ux, uz, near };
          }).sort((p, q) => p.near - q.near)[0];
          const Lx = side.ux ? sx : sz, ant = Math.min(Lx * 0.3, 7);
          rbox(M, F, bx, bz, 0, sx * 0.99, 0.8, sz * 0.99, 0.1, styleOf('substrate', { col: color && color !== '#23272e' ? color : '#1f2a37', m: [0, 0.35, 0.8] }));
          const cxn = bx - side.ux * ant / 2, czn = bz - side.uz * ant / 2, csx = sx - (side.ux ? ant : 0) - 0.8, csz = sz - (side.uz ? ant : 0) - 0.8;
          const uv = paintMark(A, f, csx, csz, 'can');
          rbox(M, F, cxn, czn, 0.8, csx, Math.max(0.8, h - 0.8), csz, 0.25, styleOf('steel'), { uv, flipU: f.s === 1 });
          return;
        }
        rbox(M, F, bx, bz, 0, sx * 0.99, h, sz * 0.99, 0.3, styleOf('epoxyGloss', { col: color || '#23272e' }));
        return;
      }
      if (cls === 'gold' && /sma|rp-?sma|sma-?\d/.test(name) && !/u\.?fl|ipex|mhf/.test(name)) {
        // edge-launch SMA: the side of the footprint at the board edge gets the flange, the barrel points out of the board
        const bbB = B.bbox;
        const sides = [[1, 0, b[2]], [-1, 0, b[0]], [0, 1, b[3]], [0, -1, b[1]]].map(([ux, uz, e]) => {
          const lx = ux ? e : bx, lz = uz ? e : bz, r = N.rot(lx, lz, f.a), wx = f.x + r[0], wy = f.y + r[1];
          return { ux, uz, e, d: Math.min(wx - bbB[0], bbB[2] - wx, wy - bbB[1], bbB[3] - wy) };
        }).sort((p2, q2) => p2.d - q2.d);
        const S = sides[0], sg2 = S.ux || S.uz, lc = S.ux ? bz : bx, yc = -t / 2;
        const ax = (X, Y, Z) => S.ux ? [S.e + sg2 * Y, yc + Z, lc + X] : [lc + X, yc + Z, S.e + sg2 * Y];
        const Fh = { p: (X, Y, Z) => F.p(...ax(X, Y, Z)), n: (X, Y, Z) => S.ux ? F.n(sg2 * Y, Z, X) : F.n(X, Z, sg2 * Y) };
        const fl = 1.6, gold = styleOf('gold');
        rbox(M, F, S.ux ? S.e + sg2 * fl / 2 : lc, S.ux ? lc : S.e + sg2 * fl / 2, yc - 3.175, S.ux ? fl : 6.35, 6.35, S.ux ? 6.35 : fl, 0.25, gold);
        const H = { p: (X, Y, Z) => Fh.p(X, Y + fl, Z), n: Fh.n };
        cyl(M, H, 0, 0, 0, 3.15, 7.6, 0.25, gold, gold);
        cyl(M, H, 0, 0, 7.0, 2.05, 0.68, 0.05, styleOf('ceramicWhite', { col: '#f1eee6', m: [0, 0.6, 0] }), styleOf('ceramicWhite', { col: '#f1eee6', m: [0, 0.6, 0] }));
        cyl(M, H, 0, 0, 7.0, 0.45, 0.9, 0.08, gold, gold);
        for (const q of smd) rbox(M, F, q.x, q.z, 0, q.w * 0.92, 0.35, q.d * 0.92, Math.min(q.w, q.d) * 0.2, gold);
        return;
      }
      if (cls === 'metal' || cls === 'gold') {
        const small = Math.max(sx, sz) < 16;
        rbox(M, F, bx, bz, 0, sx * 0.98, h, sz * 0.98, small ? Math.min(h * 0.45, 1.3) : 0.3, styleOf(cls === 'gold' ? 'gold' : 'steel'));
        return;
      }
      if (cls === 'plastic') {
        rbox(M, F, bx, bz, 0, sx * 0.98, h, sz * 0.98, Math.min(0.3, h * 0.12), styleOf('plasticBlack', { col: color || '#2a2a2c' }));
        const holes = tht.length && tht.length < 120 && h > 3 && /socket|header|pin/.test(name);
        if (holes) for (const q of tht) rbox(M, F, q.x, q.z, h - 0.02, 0.9, 0.03, 0.9, 0.05, styleOf('epoxy', { col: '#050506', m: [0, 0.9, 0] }));
        return;
      }
      // integrated circuits and everything else: epoxy body, leads, marking, pin-1 dimple
      const isIC = cls === 'ic' || cls === 'diode';
      const bga = /bga/.test(name) && Math.min(sx, sz) > 4;
      const body = isIC && !bga ? icBody(b, smd, name) : { x0: b[0], x1: b[2], z0: b[1], z1: b[3], gull: false };
      const ibx = (body.x0 + body.x1) / 2, ibz = (body.z0 + body.z1) / 2;
      let bodyH = h, y0 = body.gull ? 0.08 : 0;
      if (bga) { rbox(M, F, bx, bz, 0.25, sx, 0.4, sz, 0.05, styleOf('substrate')); y0 = 0.65; bodyH = Math.max(0.3, h - 0.4); }
      if (body.gull) bodyH = Math.max(0.4, h - 0.08);
      const inset = bga ? Math.min(1.2, Math.min(sx, sz) * 0.08) : 0;
      const bsx = body.x1 - body.x0 - inset * 2, bsz = body.z1 - body.z0 - inset * 2;
      // the body is the part of the outline inside the pad ring for gull-wing packages
      let pin1 = null;
      const p1 = pads.find(q => q.name === '1' || q.name === 'A1');
      if (p1) pin1 = [p1.x - ibx, p1.z - ibz];
      const uv = cls === 'ic' && Math.min(bsx, bsz) >= 1.3 ? paintMark(A, f, bsx, bsz, 'ic', pin1) : null;
      rbox(M, F, bga ? bx : ibx, bga ? bz : ibz, y0, bsx, bodyH, bsz, Math.min(0.14, bodyH * 0.14, Math.min(bsx, bsz) * 0.1), styleOf('epoxy', color && color !== '#1b1b1d' && color !== '#232326' ? { col: color } : null), { uv, flipU: f.s === 1 });
      if (!isIC || bga) return;
      // leads for pads outside the body (gull wing), tabs for large ones, menisci for pads that peek out (QFN)
      const hx = bsx / 2, hz = bsz / 2;
      let nl = 0;
      for (const q of smd) {
        if (nl > 260) break;
        const dxp = q.x - ibx, dzp = q.z - ibz;
        const ox = Math.abs(dxp) - hx, oz = Math.abs(dzp) - hz;
        const alongX = ox > oz;
        const dist = alongX ? ox : oz;           // pad centre beyond the body edge
        const sgn = Math.sign(alongX ? dxp : dzp) || 1;
        const plen = alongX ? q.w : q.d, pw = alongX ? q.d : q.w;
        const outer = dist + plen / 2;
        const G = alongX ? { p: (x, y, zz) => F.p(ibx + sgn * x, y, zz), n: (x, y, zz) => F.n(sgn * x, y, zz) } : { p: (x, y, zz) => F.p(zz, y, ibz + sgn * x), n: (x, y, zz) => F.n(zz, y, sgn * x) };
        const lat = alongX ? q.z : q.x;
        const edge = alongX ? hx : hz;
        if (dist > 0.12) {
          nl++;
          if (pw * plen > 4 && pw > 1.2) {   // power tab
            const tw = pw * 0.85;
            bar(M, G, [edge - 0.3, 0.3, lat], [edge + dist + plen * 0.3, 0.3, lat], tw, 0.5, styleOf('tin'));
            fillet(M, G, edge + dist + plen * 0.3, edge + outer - 0.05, lat, tw, 0.3, styleOf('solder'));
            continue;
          }
          const lw = Math.max(0.12, Math.min(pw * 0.72, 0.62)), th = Math.max(0.08, Math.min(0.15, lw * 0.45));
          const yl = y0 + Math.min(bodyH * 0.42, 0.6), footY = th / 2 + 0.02;
          const xa = edge - 0.05, xb = edge + Math.max(0.1, dist * 0.28), xc = edge + Math.max(0.22, dist * 0.62), xd = edge + Math.min(outer - 0.05, dist + plen * 0.32);
          bar(M, G, [xa, yl, lat], [xb, yl, lat], lw, th, styleOf('tin'));
          bar(M, G, [xb - th * 0.3, yl, lat], [xc, footY, lat], lw, th, styleOf('tin'));
          bar(M, G, [xc - th * 0.3, footY, lat], [xd, footY, lat], lw, th, styleOf('tin'));
          fillet(M, G, xd - 0.02, Math.min(edge + outer - 0.03, xd + Math.max(0.12, plen * 0.25)), lat, lw * 1.08, th * 1.3, styleOf('solder'));
          fillet(M, G, xc, Math.max(edge + dist - plen / 2 + 0.02, xc - 0.25), lat, lw * 1.05, th * 1.6, styleOf('solder'));
        } else if (outer > 0.04 && dist > -plen) {
          nl++;
          fillet(M, G, edge, edge + outer - 0.02, lat, Math.min(pw * 0.9, 0.5), Math.min(0.22, bodyH * 0.3), styleOf('solder'));
        }
      }
    });
    return pop;
  }

  // ---------------------------------------------------------------- board side textures: colour, material, relief, occlusion
  function bakeSide(B, side, ppm, pop, t) {
    const P = N.buildPaths(B), bb = B.bbox, pad = 1;
    const wmm = bb[2] - bb[0] + pad * 2, hmm = bb[3] - bb[1] + pad * 2;
    const W = Math.max(64, Math.round(wmm * ppm)), H = Math.max(64, Math.round(hmm * ppm));
    const kx = W / wmm, ky = H / hmm;
    const mk = (sc = 1) => { const c = document.createElement('canvas'); c.width = Math.max(16, Math.round(W * sc)); c.height = Math.max(16, Math.round(H * sc)); const g = c.getContext('2d'); const ax = c.width / wmm, ay = c.height / hmm; g.setTransform(ax, 0, 0, ay, (pad - bb[0]) * ax, (pad - bb[1]) * ay); return [c, g]; };
    const li = side === 'F' ? 0 : B.cu.length - 1;
    const cu = B.cu[li], silkL = side === 'F' ? 'F.SilkS' : 'B.SilkS', mo = P.maskOpen[side];
    const mask = B.meta.mask || '#1f6b3a', silk = B.meta.silk || '#f4f4f0', fin = N.finishColor(B.meta.finish);
    const mr = hexRGB(mask), light = mr[0] + mr[1] + mr[2] > 560;
    const toHex = c => '#' + c.map(v => v.toString(16).padStart(2, '0')).join('');
    const overCu = toHex(light ? mixRGB(mr, [184, 162, 122], 0.3) : mixRGB(mr, [226, 236, 190], 0.2));
    const plane = toHex(light ? mixRGB(mr, [184, 162, 122], 0.16) : mixRGB(mr, [226, 236, 190], 0.11));
    const bare = mixRGB(mr, [0, 0, 0], 0.18);
    const SOLDER = '#b7babe';
    const popPads = new Path2D(), barePads = new Path2D();
    B.pads.forEach(p => {
      if (!B.padOnLayer(p, li)) return;
      const soldered = pop.has(p[0]) && (p[2] === 1 || B.fps[p[0]].s === (side === 'F' ? 0 : 1));
      for (const poly of B.padPoly(p)) N.polyPath(soldered ? popPads : barePads, poly);
    });
    const sideIdx = side === 'F' ? 0 : 1;
    // colour
    const [ac, a] = mk();
    a.save(); a.clip(P.outline, 'evenodd');
    a.fillStyle = toHex(bare); a.fillRect(bb[0] - 5, bb[1] - 5, wmm + 10, hmm + 10);
    a.fillStyle = mask; a.fillRect(bb[0] - 5, bb[1] - 5, wmm + 10, hmm + 10);
    a.fillStyle = plane; a.fill(P.zones[cu]);
    a.strokeStyle = overCu; N.strokeTracks(a, P.tracks[cu]);
    a.fillStyle = overCu; a.fill(P.pads[cu]); a.fill(P.cuGfx[cu]); a.fill(P.vias);
    const metals = g => { g.save(); g.clip(mo); g.fillStyle = fin; g.fill(barePads); g.fillStyle = SOLDER; g.fill(popPads); g.restore(); };
    metals(a);
    a.fillStyle = silk; a.strokeStyle = silk;
    N.strokeGfx(a, P.gfx[silkL], 0.1); N.drawTexts(a, P.texts[silkL], { scale: kx, minPx: 2, mirror: false });
    metals(a);
    a.fillStyle = toHex(mixRGB(mr, [0, 0, 0], 0.55)); a.fill(P.viaHoles);
    a.restore();
    a.globalCompositeOperation = 'destination-out'; a.fillStyle = '#000'; a.fill(P.holes); a.fill(P.npth); a.globalCompositeOperation = 'source-over';
    // material: R metal, G roughness, B clear coat
    const [mc, m] = mk(0.5);
    m.save(); m.clip(P.outline, 'evenodd');
    m.fillStyle = 'rgb(0,150,255)'; m.fillRect(bb[0] - 5, bb[1] - 5, wmm + 10, hmm + 10);
    m.fillStyle = 'rgb(0,215,40)'; m.strokeStyle = 'rgb(0,215,40)';
    N.strokeGfx(m, P.gfx[silkL], 0.1); N.drawTexts(m, P.texts[silkL], { scale: kx / 2, minPx: 2, mirror: false });
    m.save(); m.clip(mo); m.fillStyle = /hasl|tin|silver/i.test(B.meta.finish || '') ? 'rgb(255,70,0)' : 'rgb(255,62,0)'; m.fill(barePads); m.fillStyle = 'rgb(255,45,0)'; m.fill(popPads); m.restore();
    m.fillStyle = 'rgb(0,200,80)'; m.fill(P.viaHoles);
    m.restore();
    // relief: laminate < copper under mask < silk; pads sit in the mask openings
    const [hc, hg] = mk();
    hg.save(); hg.clip(P.outline, 'evenodd');
    hg.fillStyle = 'rgb(77,77,77)'; hg.fillRect(bb[0] - 5, bb[1] - 5, wmm + 10, hmm + 10);
    hg.fillStyle = 'rgb(140,140,140)'; hg.strokeStyle = 'rgb(140,140,140)';
    hg.fill(P.zones[cu]); N.strokeTracks(hg, P.tracks[cu]); hg.fill(P.pads[cu]); hg.fill(P.cuGfx[cu]); hg.fill(P.vias);
    hg.fillStyle = 'rgb(200,200,200)'; hg.strokeStyle = 'rgb(200,200,200)';
    N.strokeGfx(hg, P.gfx[silkL], 0.1); N.drawTexts(hg, P.texts[silkL], { scale: kx, minPx: 2, mirror: false });
    hg.save(); hg.clip(mo); hg.fillStyle = 'rgb(112,112,112)'; hg.fill(barePads); hg.fillStyle = 'rgb(150,150,150)'; hg.fill(popPads); hg.restore();
    hg.fillStyle = 'rgb(30,30,30)'; hg.fill(P.viaHoles);
    hg.restore();
    // occlusion under and around the parts on this side (smooth: a quarter of the resolution is plenty)
    const aoS = Math.min(1, Math.max(4 / kx, 0.25));
    const [oc, og] = mk(aoS); og.setTransform(1, 0, 0, 1, 0, 0); og.fillStyle = '#fff'; og.fillRect(0, 0, oc.width, oc.height);
    const ka = kx * aoS;
    const buckets = [[0.9, 0.3, 0.5], [1.8, 0.55, 0.55], [4, 1.0, 0.6], [99, 1.8, 0.62]];
    buckets.forEach(([hmax, blurMm, alpha], bi) => {
      const hmin = bi ? buckets[bi - 1][0] : -1;
      const [bc, bg] = mk(aoS); let any = false;
      bg.fillStyle = '#000';
      for (const fi of pop) {
        const f = B.fps[fi]; if (f.s !== sideIdx) continue;
        const hh = f.z[1]; if (hh > hmax || hh <= hmin) continue;
        const poly = B.bodyPoly(f); if (!poly) continue;
        const pth = new Path2D(); N.polyPath(pth, poly); bg.fill(pth); any = true;
      }
      if (!any) return;
      og.save(); og.globalAlpha = alpha; og.filter = `blur(${(blurMm * ka).toFixed(1)}px)`; og.drawImage(bc, 0, 0); og.restore();
    });
    return { alb: ac, mat: mc, hgt: hc, ao: oc, W, H, wmm, hmm, x0: bb[0] - pad, y0: bb[1] - pad, texelMm: 1 / kx };
  }

  // ---------------------------------------------------------------- GL helpers
  function tex(gl, src, opt) {
    const t = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, src);
    const mip = !opt || opt.mip !== false;
    if (mip) gl.generateMipmap(gl.TEXTURE_2D);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, mip ? gl.LINEAR_MIPMAP_LINEAR : gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    const ext = gl.getExtension('EXT_texture_filter_anisotropic');
    if (ext && mip) gl.texParameterf(gl.TEXTURE_2D, ext.TEXTURE_MAX_ANISOTROPY_EXT, Math.min(8, gl.getParameter(ext.MAX_TEXTURE_MAX_ANISOTROPY_EXT)));
    return t;
  }
  function meshVAO(gl, M) {
    const vao = gl.createVertexArray(); gl.bindVertexArray(vao);
    const buf = (data, loc, size, type, normd) => { const b = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, b); gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW); gl.enableVertexAttribArray(loc); gl.vertexAttribPointer(loc, size, type, normd, 0, 0); return b; };
    const bufs = [buf(new Float32Array(M.P), 0, 3, gl.FLOAT, false), buf(new Float32Array(M.Nn), 1, 3, gl.FLOAT, false), buf(new Uint8Array(M.C), 2, 3, gl.UNSIGNED_BYTE, true),
      buf(new Uint8Array(M.Mt), 3, 3, gl.UNSIGNED_BYTE, true), buf(new Uint8Array(M.E), 4, 3, gl.UNSIGNED_BYTE, true), buf(new Float32Array(M.U), 5, 2, gl.FLOAT, false)];
    const ib = gl.createBuffer(); gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ib); gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, new Uint32Array(M.I), gl.STATIC_DRAW);
    gl.bindVertexArray(null);
    return { vao, count: M.I.length, bufs: bufs.concat([ib]) };
  }
  function quadVAO(gl, x0, z0, x1, z1, y, u0 = 0, v0 = 0, u1 = 1, v1 = 1) {
    const vao = gl.createVertexArray(); gl.bindVertexArray(vao);
    const d = new Float32Array([x0, y, z0, u0, v0, x1, y, z0, u1, v0, x1, y, z1, u1, v1, x0, y, z0, u0, v0, x1, y, z1, u1, v1, x0, y, z1, u0, v1]);
    const b = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, b); gl.bufferData(gl.ARRAY_BUFFER, d, gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 20, 0);
    gl.enableVertexAttribArray(1); gl.vertexAttribPointer(1, 2, gl.FLOAT, false, 20, 12);
    gl.bindVertexArray(null);
    return { vao, bufs: [b] };
  }

  // ---------------------------------------------------------------- render
  /**
   * opts: { width = 2048, height = 1280, ss = 1.5 (supersampling), yaw, pitch (radians; the viewer's camera), fov (radians),
   *         camera: { yaw, pitch, dist, target, fov } (exact viewer camera; otherwise the board is framed), margin = 0.06,
   *         background: null (transparent, shadow in alpha) | 'studio', side: 'auto' | 'top' | 'bottom' }
   */
  N.renderPhoto = async function (B, opts) {
    opts = Object.assign({ width: 2048, height: 1280, ss: 1.5, margin: 0.06, side: 'auto', background: null }, opts || {});
    const T0 = performance.now();
    if (document.fonts && document.fonts.ready) { try { await document.fonts.ready; } catch (e) { /* fonts optional */ } }
    const T1 = performance.now();
    const st = B.stats || {};
    const t = B.meta.thickness || 1.6;
    const bb = B.bbox, cx = (bb[0] + bb[2]) / 2, cy = (bb[1] + bb[3]) / 2;
    let yaw = opts.yaw != null ? opts.yaw : (opts.camera ? opts.camera.yaw : -0.5), pitch = opts.pitch != null ? opts.pitch : (opts.camera ? opts.camera.pitch : 0.72);
    let under = opts.side === 'bottom' || (opts.side === 'auto' && opts.yaw == null && !opts.camera && (st.bottom || 0) > (st.top || 0) * 1.5);
    if (opts.side === 'auto' && (opts.camera || opts.yaw != null)) under = pitch < 0;
    // a board seen from below is turned over (rotated about x) so it lies on the floor
    if (under && pitch < 0) { yaw = Math.PI - yaw; pitch = -pitch; }
    else if (under && pitch >= 0) { /* bottom by request: keep the angles, the model is flipped */ }
    pitch = Math.max(0.12, Math.min(Math.PI / 2 - 0.02, pitch));
    const model = under ? new Float32Array([1, 0, 0, 0, 0, -1, 0, 0, 0, 0, -1, 0, 0, 0, 0, 1]) : new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
    const W = Math.round(opts.width * opts.ss), H = Math.round(opts.height * opts.ss);
    const cv = document.createElement('canvas'); cv.width = W; cv.height = H;
    const gl = cv.getContext('webgl2', { antialias: false, alpha: true, premultipliedAlpha: true, preserveDrawingBuffer: true });
    if (!gl) throw new Error('WebGL2 is not available for the photo renderer.');
    const maxTex = Math.min(gl.getParameter(gl.MAX_TEXTURE_SIZE), 8192);
    const res = [];
    const tm = { fonts: Math.round(T1 - T0), ctx: Math.round(performance.now() - T1) }; let tl = performance.now();
    const px1 = new Uint8Array(4);
    const mark = k => { if (opts.timing) { const fb = gl.getParameter(gl.FRAMEBUFFER_BINDING); gl.bindFramebuffer(gl.FRAMEBUFFER, null); gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px1); gl.bindFramebuffer(gl.FRAMEBUFFER, fb); } const n = performance.now(); tm[k] = Math.round(n - tl); tl = n; };
    try {
      // ---- scene
      const M = new Mesh();
      const A = new Atlas(2048);
      const pop = buildParts(B, M, A, t, cx, cy, opts.allParts ? null : (under ? 0 : 1));
      // board edge and hole walls
      const fr4 = styleOf('fr4', { col: toFR4(B.meta.mask) });
      const loops = B.pcb.outline.outer.map(l => ({ l, hole: false })).concat(B.pcb.outline.holes.map(l => ({ l, hole: true })));
      const pip = (x, y, flat) => { let ins = false; for (let i = 0, j = flat.length - 2; i < flat.length; j = i, i += 2) { const xi = flat[i], yi = flat[i + 1], xj = flat[j], yj = flat[j + 1]; if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) ins = !ins; } return ins; };
      for (const { l, hole } of loops) {
        const n = l.length / 2;
        for (let i = 0; i < n; i++) {
          const x0 = l[i * 2], y0 = l[i * 2 + 1], x1 = l[((i + 1) % n) * 2], y1 = l[((i + 1) % n) * 2 + 1];
          const dx = x1 - x0, dy = y1 - y0, L = Math.hypot(dx, dy); if (L < 1e-6) continue;
          let nx = dy / L, ny = -dx / L;
          const inside = pip((x0 + x1) / 2 + nx * 0.05, (y0 + y1) / 2 + ny * 0.05, l);
          if (hole ? !inside : inside) { nx = -nx; ny = -ny; }
          const a0 = M.v([x0 - cx, -t / 2, y0 - cy], [nx, 0, ny], fr4, 0.9), a1 = M.v([x1 - cx, -t / 2, y1 - cy], [nx, 0, ny], fr4, 0.9);
          const b1 = M.v([x1 - cx, t / 2, y1 - cy], [nx, 0, ny], fr4, 1), b0 = M.v([x0 - cx, t / 2, y0 - cy], [nx, 0, ny], fr4, 1);
          M.q(a0, a1, b1, b0);
        }
      }
      const finSt = styleOf('gold', { col: N.finishColor(B.meta.finish) });
      for (const p of B.pads) {
        const d = Math.max(p[11] || 0, p[12] || 0); if (d < 0.3) continue;
        const r = d / 2, seg = d > 2 ? 24 : 14, stw = p[2] === 2 ? fr4 : finSt;
        let prev = null, first = null;
        for (let i = 0; i <= seg; i++) {
          const an = i / seg * Math.PI * 2, x = p[4] - cx + r * Math.cos(an), z = p[5] - cy + r * Math.sin(an);
          const lo = M.v([x, -t / 2, z], [-Math.cos(an), 0, -Math.sin(an)], stw, 0.6), hi = M.v([x, t / 2, z], [-Math.cos(an), 0, -Math.sin(an)], stw, 0.6);
          if (prev) M.q(prev[0], lo, hi, prev[1]); else first = [lo, hi];
          prev = [lo, hi];
        }
        void first;
      }
      // textures of both faces
      const span = Math.max(bb[2] - bb[0], bb[3] - bb[1]) + 2;
      const ppm = Math.max(8, Math.min(44, (maxTex - 16) / span, 1.9 * Math.max(opts.width, opts.height) * 0.9 / span));
      mark('parts');
      const TS = bakeSide(B, under ? 'B' : 'F', ppm, pop, t), TF = TS;
      mark('bake');
      const faceTex = T => ({ alb: tex(gl, T.alb), mat: tex(gl, T.mat), hgt: tex(gl, T.hgt, { mip: false }), ao: tex(gl, T.ao, { mip: false }), T });
      const FS = faceTex(TS);
      mark('faceTex');
      const qx0 = TF.x0 - cx, qz0 = TF.y0 - cy, qx1 = TF.x0 + TF.wmm - cx, qz1 = TF.y0 + TF.hmm - cy;
      const topQ = quadVAO(gl, qx0, qz0, qx1, qz1, t / 2), botQ = quadVAO(gl, qx0, qz0, qx1, qz1, -t / 2);
      const atlasTex = tex(gl, A.cv);
      mark('atlas');
      const mesh = meshVAO(gl, M);
      res.push(topQ, botQ, mesh);
      mark('upload');
      // scene bounds (after the flip)
      const yLo = Math.min(-t / 2, M.minY), yHi = Math.max(t / 2, M.maxY);
      const wy = under ? [-yHi, -yLo] : [yLo, yHi];
      const bxs = [bb[0] - cx, bb[2] - cx], bzs = under ? [-(bb[3] - cy), -(bb[1] - cy)] : [bb[1] - cy, bb[3] - cy];
      const corners = [];
      for (const x of bxs) for (const y of wy) for (const z of bzs) corners.push([x, y, z]);
      const floorY = wy[0] - 0.03;
      // ---- camera
      const fov = opts.fov || (opts.camera && opts.camera.fov) || 22 * Math.PI / 180;
      const aspect = W / H;
      const dirOf = (yw, pt) => [Math.cos(pt) * Math.sin(yw), Math.sin(pt), Math.cos(pt) * Math.cos(yw)];
      let eye, target, dist;
      const proj = (e, tg) => { const view = N.M.lookAt(e, tg, [0, 1, 0]); const pr = N.M.persp(fov, aspect, 0.5, 5000); return N.M.mul(pr, view); };
      if (opts.camera && opts.exact) {
        target = opts.camera.target.slice(); if (under) target = [target[0], -target[1], -target[2]];
        dist = opts.camera.dist; eye = V3.add(target, V3.mul(dirOf(yaw, pitch), dist));
      } else {
        target = [(bxs[0] + bxs[1]) / 2, (wy[0] + wy[1]) / 2, (bzs[0] + bzs[1]) / 2];
        dist = Math.hypot(bxs[1] - bxs[0], wy[1] - wy[0], bzs[1] - bzs[0]) / (2 * Math.tan(fov / 2));
        for (let it = 0; it < 6; it++) {
          eye = V3.add(target, V3.mul(dirOf(yaw, pitch), dist));
          const vp = proj(eye, target);
          let x0 = 1e9, x1 = -1e9, y0 = 1e9, y1 = -1e9;
          for (const c of corners) { const p = N.M.xform(vp, [c[0], c[1], c[2], 1]); const X = p[0] / p[3], Y = p[1] / p[3]; x0 = Math.min(x0, X); x1 = Math.max(x1, X); y0 = Math.min(y0, Y); y1 = Math.max(y1, Y); }
          const fill = Math.max((x1 - x0) / 2, (y1 - y0) / 2) / (1 - opts.margin * 2);
          // re-centre: move the target along the camera's right/up by the projected offset
          const right = V3.norm(V3.cross(V3.sub(target, eye), [0, 1, 0])), upv = V3.norm(V3.cross(right, V3.sub(target, eye)));
          const hx = dist * Math.tan(fov / 2) * aspect, hy = dist * Math.tan(fov / 2);
          target = V3.add(target, V3.add(V3.mul(right, (x0 + x1) / 2 * hx), V3.mul(upv, (y0 + y1) / 2 * hy)));
          dist *= fill;
        }
        eye = V3.add(target, V3.mul(dirOf(yaw, pitch), dist));
      }
      const view = N.M.lookAt(eye, target, [0, 1, 0]);
      const near = Math.max(0.5, dist * 0.2), far = dist * 3 + 200;
      const VP = N.M.mul(N.M.persp(fov, aspect, near, far), view);
      const camF = V3.norm([target[0] - eye[0], 0, target[2] - eye[2]]), camR = V3.norm(V3.cross(camF, [0, 1, 0]));
      // key light: high, from the left of the camera and a little in front
      const keyDir = V3.norm(V3.add(V3.add(V3.mul(camR, -0.62), V3.mul(camF, -0.32)), [0, 1.05, 0]));
      // ---- shadow map (orthographic along the key light)
      const SM = Math.min(4096, gl.getParameter(gl.MAX_TEXTURE_SIZE));
      const ldist = 1000;
      const lc = [(bxs[0] + bxs[1]) / 2, (wy[0] + wy[1]) / 2, (bzs[0] + bzs[1]) / 2];
      const lview = N.M.lookAt(V3.add(lc, V3.mul(keyDir, ldist)), lc, Math.abs(keyDir[1]) > 0.99 ? [0, 0, 1] : [0, 1, 0]);
      let lx0 = 1e9, lx1 = -1e9, ly0 = 1e9, ly1 = -1e9, lz0 = 1e9, lz1 = -1e9;
      for (const c of corners.concat(corners.map(c => [c[0], floorY, c[2]]))) { const p = N.M.xform(lview, [c[0], c[1], c[2], 1]); lx0 = Math.min(lx0, p[0]); lx1 = Math.max(lx1, p[0]); ly0 = Math.min(ly0, p[1]); ly1 = Math.max(ly1, p[1]); lz0 = Math.min(lz0, -p[2]); lz1 = Math.max(lz1, -p[2]); }
      const mx = (lx1 - lx0) * 0.06 + 2, my = (ly1 - ly0) * 0.06 + 2;
      const LVP = N.M.mul(ortho(lx0 - mx, lx1 + mx, ly0 - my, ly1 + my, lz0 - 5, lz1 + 5), lview);
      const lw = (lx1 - lx0 + 2 * mx), depthRange = (lz1 - lz0 + 10);
      const keyAng = 0.11;   // angular radius of the key softbox (penumbra)
      const shTex = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, shTex);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.DEPTH_COMPONENT24, SM, SM, 0, gl.DEPTH_COMPONENT, gl.UNSIGNED_INT, null);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      const fbo = gl.createFramebuffer();
      gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.TEXTURE_2D, shTex, 0);
      gl.drawBuffers([gl.NONE]); gl.readBuffer(gl.NONE);
      gl.viewport(0, 0, SM, SM);
      gl.clearDepth(1); gl.clear(gl.DEPTH_BUFFER_BIT);
      gl.enable(gl.DEPTH_TEST); gl.disable(gl.CULL_FACE);
      gl.enable(gl.POLYGON_OFFSET_FILL); gl.polygonOffset(1.5, 3.0);
      const pDepth = compile(gl, VS_DEPTH, FS_DEPTH), pDepthF = compile(gl, VS_DEPTHF, FS_DEPTHF);
      gl.useProgram(pDepth.p); gl.uniformMatrix4fv(pDepth.u.uLVP, false, LVP); gl.uniformMatrix4fv(pDepth.u.uModel, false, model);
      gl.bindVertexArray(mesh.vao); gl.drawElements(gl.TRIANGLES, mesh.count, gl.UNSIGNED_INT, 0);
      gl.useProgram(pDepthF.p); gl.uniformMatrix4fv(pDepthF.u.uLVP, false, LVP); gl.uniformMatrix4fv(pDepthF.u.uModel, false, model); gl.uniform1i(pDepthF.u.uAlb, 0);
      for (const q of [topQ, botQ]) { gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, FS.alb); gl.bindVertexArray(q.vao); gl.drawArrays(gl.TRIANGLES, 0, 6); }
      gl.disable(gl.POLYGON_OFFSET_FILL);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      mark('shadow');
      // ---- floor contact occlusion (the board silhouette, blurred)
      const fx0 = bxs[0] - (bxs[1] - bxs[0]) * 0.6, fx1 = bxs[1] + (bxs[1] - bxs[0]) * 0.6, fz0 = bzs[0] - (bzs[1] - bzs[0]) * 0.6, fz1 = bzs[1] + (bzs[1] - bzs[0]) * 0.6;
      const fppm = Math.min(12, 2048 / Math.max(fx1 - fx0, fz1 - fz0));
      const fc = document.createElement('canvas'); fc.width = Math.round((fx1 - fx0) * fppm); fc.height = Math.round((fz1 - fz0) * fppm);
      const fg = fc.getContext('2d'); fg.fillStyle = '#fff'; fg.fillRect(0, 0, fc.width, fc.height);
      const gap = Math.max(0, -t / 2 - floorY);
      const sil = document.createElement('canvas'); sil.width = fc.width; sil.height = fc.height;
      const sg = sil.getContext('2d');
      sg.setTransform(fppm, 0, 0, under ? -fppm : fppm, (-fx0 - cx) * fppm, under ? (cy - fz0) * fppm : (-fz0 - cy) * fppm);
      sg.fillStyle = '#000'; sg.fill(N.buildPaths(B).outline, 'evenodd');
      fg.save(); fg.globalAlpha = 0.85; fg.filter = `blur(${(Math.max(1.2, gap * 1.6 + 1.0) * fppm).toFixed(1)}px)`; fg.drawImage(sil, 0, 0); fg.restore();
      fg.save(); fg.globalAlpha = 0.35; fg.filter = `blur(${(Math.max(4, gap * 3 + 6) * fppm).toFixed(1)}px)`; fg.drawImage(sil, 0, 0); fg.restore();
      const floorTex = tex(gl, fc);
      mark('floor');
      const floorQ = quadVAO(gl, fx0, fz0, fx1, fz1, floorY, 0, 0, 1, 1);
      res.push(floorQ);
      // ---- main pass, multisampled, resolved into colour + depth textures for the lens
      const samples = opts.msaa === false ? 0 : Math.min(4, gl.getParameter(gl.MAX_SAMPLES) || 0);
      const mkT = (ifmt, fmt, type) => { const tx = gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D, tx); gl.texImage2D(gl.TEXTURE_2D, 0, ifmt, W, H, 0, fmt, type, null);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE); return tx; };
      const colTex = mkT(gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE), depTex = mkT(gl.DEPTH_COMPONENT24, gl.DEPTH_COMPONENT, gl.UNSIGNED_INT);
      const rFbo = gl.createFramebuffer();
      gl.bindFramebuffer(gl.FRAMEBUFFER, rFbo);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, colTex, 0);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.TEXTURE_2D, depTex, 0);
      let msFbo = null;
      if (samples > 1) {
        msFbo = gl.createFramebuffer();
        const rbC = gl.createRenderbuffer(), rbD = gl.createRenderbuffer();
        gl.bindRenderbuffer(gl.RENDERBUFFER, rbC); gl.renderbufferStorageMultisample(gl.RENDERBUFFER, samples, gl.RGBA8, W, H);
        gl.bindRenderbuffer(gl.RENDERBUFFER, rbD); gl.renderbufferStorageMultisample(gl.RENDERBUFFER, samples, gl.DEPTH_COMPONENT24, W, H);
        gl.bindFramebuffer(gl.FRAMEBUFFER, msFbo);
        gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.RENDERBUFFER, rbC);
        gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.RENDERBUFFER, rbD);
        if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) { gl.bindFramebuffer(gl.FRAMEBUFFER, rFbo); msFbo = null; }
      }
      gl.viewport(0, 0, W, H);
      gl.clearColor(0, 0, 0, 0); gl.clearDepth(1); gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
      const pMesh = compile(gl, VS_MESH, FS_MESH), pFace = compile(gl, VS_FACE, FS_FACE), pFloor = compile(gl, VS_FLOOR, FS_FLOOR);
      mark('compile');
      const common = pr => {
        const u = pr.u;
        gl.uniformMatrix4fv(u.uVP, false, VP);
        if (u.uModel) gl.uniformMatrix4fv(u.uModel, false, model);
        gl.uniform3fv(u.uEye, eye); gl.uniform3fv(u.uCamF, camF); gl.uniform3fv(u.uCamR, camR);
        gl.uniform3fv(u.uKeyDir, keyDir); gl.uniform3fv(u.uKeyCol, [2.55, 2.47, 2.36]);
        gl.uniform1f(u.uKeyAng, keyAng); gl.uniform1f(u.uSbEl, Math.min(1.35, Math.max(0.3, pitch + 0.16))); gl.uniform1f(u.uExposure, opts.exposure || 1.0); gl.uniform1f(u.uCoatRough, 0.16);
        gl.uniformMatrix4fv(u.uLVP, false, LVP);
        gl.uniform1f(u.uShTexel, 1 / SM); gl.uniform1f(u.uPenK, depthRange * Math.tan(keyAng) * 2 / lw); gl.uniform1f(u.uBias, 0.03 / depthRange);
        gl.uniform1f(u.uNormOff, lw / SM * 1.2); gl.uniform1f(u.uSearch, Math.min(0.02, 6 * Math.tan(keyAng) * 2 / lw));
        gl.activeTexture(gl.TEXTURE7); gl.bindTexture(gl.TEXTURE_2D, shTex); gl.uniform1i(u.uShadow, 7);
      };
      // floor shadow (alpha only)
      if (opts.floor !== false) {
        gl.useProgram(pFloor.p); common(pFloor);
        gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, floorTex); gl.uniform1i(pFloor.u.uFloorAO, 0);
        gl.uniform1f(pFloor.u.uShadowK, 0.5); gl.uniform1f(pFloor.u.uContactK, 0.6);
        gl.enable(gl.BLEND); gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA); gl.depthMask(false);
        gl.bindVertexArray(floorQ.vao); gl.drawArrays(gl.TRIANGLES, 0, 6);
        gl.depthMask(true); gl.disable(gl.BLEND);
      }
      // board faces
      gl.useProgram(pFace.p); common(pFace);
      for (const [q, T, sgn] of [under ? [botQ, FS, -1] : [topQ, FS, 1]]) {
        const u = pFace.u;
        [[T.alb, 'uAlb'], [T.mat, 'uMat'], [T.hgt, 'uHgt'], [T.ao, 'uAO']].forEach(([tx, nm], i) => { gl.activeTexture(gl.TEXTURE0 + i); gl.bindTexture(gl.TEXTURE_2D, tx); gl.uniform1i(u[nm], i); });
        gl.uniform2f(u.uTexel, 1 / T.T.W, 1 / T.T.H);
        gl.uniform1f(u.uBump, 0.11 / (2 * T.T.texelMm));
        gl.uniform1f(u.uSide, sgn);
        gl.bindVertexArray(q.vao); gl.drawArrays(gl.TRIANGLES, 0, 6);
      }
      mark('faces');
      // parts, edges, hole walls
      gl.useProgram(pMesh.p); common(pMesh);
      gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, atlasTex); gl.uniform1i(pMesh.u.uAtlas, 0);
      gl.bindVertexArray(mesh.vao); gl.drawElements(gl.TRIANGLES, mesh.count, gl.UNSIGNED_INT, 0);
      gl.bindVertexArray(null);
      if (msFbo) {
        gl.bindFramebuffer(gl.READ_FRAMEBUFFER, msFbo); gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, rFbo);
        gl.blitFramebuffer(0, 0, W, H, 0, 0, W, H, gl.COLOR_BUFFER_BIT, gl.NEAREST);
        gl.blitFramebuffer(0, 0, W, H, 0, 0, W, H, gl.DEPTH_BUFFER_BIT, gl.NEAREST);
      }
      mark('main');
      // ---- lens: depth of field focused on the middle of the board
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.viewport(0, 0, W, H); gl.disable(gl.DEPTH_TEST); gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT);
      const pPost = compile(gl, VS_POST, FS_POST);
      gl.useProgram(pPost.p);
      gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, colTex); gl.uniform1i(pPost.u.uCol, 0);
      gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, depTex); gl.uniform1i(pPost.u.uDep, 1);
      gl.uniform2f(pPost.u.uPx, 1 / W, 1 / H);
      gl.uniform1f(pPost.u.uNear, near); gl.uniform1f(pPost.u.uFar, far);
      const focus = Math.hypot(eye[0] - target[0], eye[1] - target[1], eye[2] - target[2]);
      const dof = opts.dof == null ? 1 : +opts.dof, kpx = W / 2048;
      gl.uniform1f(pPost.u.uFocus, focus); gl.uniform1f(pPost.u.uAper, 17 * kpx * dof); gl.uniform1f(pPost.u.uMaxC, Math.min(9, 5 * kpx * dof));
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      gl.finish();
      mark('lens');
      // ---- down-sample into the output
      const out = document.createElement('canvas'); out.width = opts.width; out.height = opts.height;
      const og = out.getContext('2d');
      if (opts.background === 'studio') {
        const gr = og.createRadialGradient(opts.width * 0.5, opts.height * 0.38, opts.width * 0.05, opts.width * 0.5, opts.height * 0.5, opts.width * 0.75);
        gr.addColorStop(0, '#f4f4f1'); gr.addColorStop(0.6, '#e4e4df'); gr.addColorStop(1, '#c9c9c3');
        og.fillStyle = gr; og.fillRect(0, 0, opts.width, opts.height);
      }
      og.imageSmoothingEnabled = true; og.imageSmoothingQuality = 'high';
      let src = cv;
      if (opts.ss > 1.7) { const mid = document.createElement('canvas'); mid.width = Math.round(W / 1.5); mid.height = Math.round(H / 1.5); const mg = mid.getContext('2d'); mg.imageSmoothingQuality = 'high'; mg.drawImage(cv, 0, 0, mid.width, mid.height); src = mid; }
      og.drawImage(src, 0, 0, opts.width, opts.height);
      mark('out');
      out.meta = { yaw, pitch, under, parts: pop.size, triangles: mesh.count / 3, ppm: +ppm.toFixed(1), timing: tm };
      return out;
    } finally {
      const T2 = performance.now();
      const ext = gl.getExtension('WEBGL_lose_context');
      if (ext && !opts.keepContext) ext.loseContext();
      if (opts.timing) console.log('photo: lose context ' + Math.round(performance.now() - T2) + ' ms');
    }
  };
  function toFR4(mask) {
    const m = hexRGB(mask || '#1f6b3a');
    return '#' + mixRGB([192, 176, 128], m, 0.28).map(v => v.toString(16).padStart(2, '0')).join('');
  }
  // photo of a board as a Blob (PNG), for downloads
  N.photoBlob = async function (B, opts) {
    const cv = await N.renderPhoto(B, opts);
    return new Promise(res => cv.toBlob(b => res(b), opts && opts.type || 'image/png', opts && opts.quality));
  };

  // ---------------------------------------------------------------- the photo dialog: this view or the whole board, 2K / 4K, studio or transparent
  if (N.icons && !N.icons.camera) N.icons.camera = '<svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2 5h2.6l1.2-1.8h4.4L11.4 5H14v8H2z"/><circle cx="8" cy="9" r="2.4"/></svg>';
  /** opts: { viewer (N.Viewer3D, optional), name, prerendered (url of a ready photo, optional) } */
  N.photoDialog = function (B, opts) {
    opts = opts || {};
    const el = N.el, I = N.icons;
    const st = { frame: opts.viewer ? 'view' : 'board', bg: 'studio', size: 2048, url: null, blob: null, busy: false, pre: opts.prerendered || null };
    const fig = el('div', { class: 'ph-fig' });
    const note = el('p', { class: 'ph-note muted small' });
    const seg = (label, key, items) => el('div', { class: 'ph-ctl' }, el('span', { class: 'ph-k' }, label),
      el('div', { class: 'seg', role: 'group', 'aria-label': label }, items.map(([v, t]) => el('button', { class: st[key] === v ? 'active' : '', type: 'button', onclick: e => { st[key] = v; e.currentTarget.parentElement.querySelectorAll('button').forEach(b => b.classList.toggle('active', b === e.currentTarget)); st.pre = null; go(); } }, t))));
    const ctls = el('div', { class: 'ph-ctls' },
      opts.viewer ? seg('Framing', 'frame', [['view', 'This view'], ['board', 'Whole board']]) : null,
      seg('Background', 'bg', [['studio', 'Studio'], ['none', 'Transparent']]),
      seg('Size', 'size', [[2048, '2K'], [3840, '4K']]));
    const dl = el('button', { class: 'btn primary', type: 'button', disabled: true, onclick: async () => {
      const base = (opts.name || 'board').replace(/[^\w.-]+/g, '-');
      if (st.pre && !st.blob) { try { const b = await (await fetch(st.pre)).blob(); await N.saveFile(base + '-photo.webp', b); } catch (e) { N.toast('Could not read the photo: ' + (e.message || e), 'warn'); } return; }
      if (st.blob) await N.saveFile(`${base}-${st.size === 2048 ? '2k' : '4k'}${st.bg === 'none' ? '-transparent' : ''}.png`, st.blob);
    } }, N.svg(I.download), 'Download');
    const again = st.pre ? el('button', { class: 'btn', type: 'button', onclick: () => { st.pre = null; go(); } }, N.svg(I.camera), 'Render it again here') : null;
    const m = N.modal('2K photo', el('div', { class: 'ph' }, fig, ctls, note), [again, dl].filter(Boolean), { wide: true, onClose: () => { if (st.url) URL.revokeObjectURL(st.url); } });
    m.el.classList.add('wide');
    const show = src => { fig.replaceChildren(el('img', { class: 'ph-img' + (st.bg === 'none' && !st.pre ? ' clear' : ''), src, alt: 'Rendered photo of ' + (opts.name || 'the board') })); };
    async function go() {
      if (st.pre) { show(st.pre); dl.disabled = false; note.textContent = 'Rendered from the KiCad files: soldered parts, studio light, a shallow depth of field. Change an option to render it again in this browser.'; return; }
      if (st.busy) { st.again = true; return; }
      st.busy = true; dl.disabled = true;
      fig.replaceChildren(el('div', { class: 'ph-wait' }, el('div', { class: 'spinner' }), el('span', null, `Rendering a ${st.size === 2048 ? '2K' : '4K'} photo…`)));
      await new Promise(r => setTimeout(r, 40));
      try {
        const v = opts.viewer;
        let w = st.size, h = Math.round(st.size * 0.625);
        const o = { width: w, height: h, ss: st.size > 2048 ? 1 : 1.25, background: st.bg === 'studio' ? 'studio' : null };
        if (v && st.frame === 'view') {
          const a = v.canvas.clientWidth / Math.max(1, v.canvas.clientHeight);
          if (a >= 1) { w = st.size; h = Math.round(st.size / Math.min(2.4, a)); } else { h = st.size; w = Math.round(st.size * Math.max(0.5, a)); }
          Object.assign(o, { width: w, height: h, camera: { yaw: v.cam.yaw, pitch: v.cam.pitch, dist: v.cam.dist, target: v.cam.target.slice(), fov: v.cam.fov }, exact: true });
        } else if (v) Object.assign(o, { yaw: v.cam.yaw, pitch: v.cam.pitch });
        const t0 = performance.now();
        const cv = await N.renderPhoto(B, o);
        const blob = await new Promise(r => cv.toBlob(r, 'image/png'));
        if (st.url) URL.revokeObjectURL(st.url);
        st.blob = blob; st.url = URL.createObjectURL(blob);
        show(st.url);
        note.textContent = `${cv.width} × ${cv.height} px · ${cv.meta.parts} parts · rendered in ${((performance.now() - t0) / 1000).toFixed(1)} s from the board files.`;
        dl.disabled = false;
      } catch (e) {
        fig.replaceChildren(el('p', { class: 'ph-err' }, 'The photo could not be rendered here: ' + (e.message || e)));
      }
      st.busy = false;
      if (st.again) { st.again = false; go(); }
    }
    go();
    return m;
  };
})();
