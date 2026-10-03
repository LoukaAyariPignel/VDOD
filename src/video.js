/* Image : calque WebGL posé sur la vidéo, qui débrouille chaque image en un seul passage.
 * Le shader est celui de SPEC.md §3 (le même que le lecteur de l'application). */
(function (root) {
  "use strict";
  const BRV = root.BRV;

  const VERTEX = `
attribute vec2 pos;
varying vec2 uv;
void main() {
  uv = vec2(pos.x * 0.5 + 0.5, 0.5 - pos.y * 0.5);
  gl_Position = vec4(pos, 0.0, 1.0);
}`;

  const FRAGMENT = `
precision highp float;
uniform sampler2D tvid;
uniform sampler2D ttab;
uniform int masked;
uniform vec2 size;
uniform float smoothing;
varying vec2 uv;
const vec2 GRID = vec2(32.0, 18.0);
const float M = 0.06;

vec3 decodeAt(vec2 X) {
  vec2 g = X * GRID;
  vec2 s = min(floor(g), GRID - 1.0);
  vec2 f = g - s;
  vec4 e = texture2D(ttab, (s + 0.5) / GRID);
  vec2 c = floor(e.rg * 255.0 + 0.5);
  float fl = floor(e.b * 255.0 + 0.5);
  if (mod(fl, 2.0) >= 1.0) f.x = 1.0 - f.x;
  if (mod(floor(fl / 2.0), 2.0) >= 1.0) f.y = 1.0 - f.y;
  f = M + f * (1.0 - 2.0 * M);
  vec3 rgb = texture2D(tvid, (c + f) / GRID).rgb;
  if (fl >= 4.0) rgb = 1.0 - rgb;
  return rgb;
}

void main() {
  if (masked == 1) { gl_FragColor = vec4(0.0, 0.0, 0.0, 1.0); return; }
  vec3 rgb = decodeAt(uv);
  if (smoothing > 0.0) {
    // adoucissement des jointures, selon la résolution reçue
    vec2 bp = size / GRID;
    vec2 f = fract(uv * GRID);
    vec2 dist = min(f, 1.0 - f) * bp;
    vec2 px = 1.0 / size;
    if (dist.x < 1.5) {
      vec3 n = 0.5 * (decodeAt(uv + vec2(px.x, 0.0)) + decodeAt(uv - vec2(px.x, 0.0)));
      rgb = mix(rgb, n, smoothing * (1.0 - dist.x / 1.5));
    }
    if (dist.y < 1.5) {
      vec3 n = 0.5 * (decodeAt(uv + vec2(0.0, px.y)) + decodeAt(uv - vec2(0.0, px.y)));
      rgb = mix(rgb, n, smoothing * (1.0 - dist.y / 1.5));
    }
  }
  gl_FragColor = vec4(rgb, 1.0);
}`;

  function Renderer(video) {
    this.video = video;
    this.canvas = root.document.createElement("canvas");
    this.canvas.className = "brv-overlay";
    Object.assign(this.canvas.style, { position: "absolute", pointerEvents: "none", display: "none",
                                       zIndex: "1", background: "black" });
    this.gl = null;
    this.visible = false;
    this.table = null;
    this.opening = 0.6;
  }

  Renderer.prototype.init = function () {
    if (this.gl) return true;
    const gl = this.canvas.getContext("webgl", { alpha: false, antialias: false, depth: false,
                                                 premultipliedAlpha: false, preserveDrawingBuffer: false });
    if (!gl) return false;
    const sh = (type, src) => {
      const s = gl.createShader(type);
      gl.shaderSource(s, src); gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s));
      return s;
    };
    const p = gl.createProgram();
    gl.attachShader(p, sh(gl.VERTEX_SHADER, VERTEX));
    gl.attachShader(p, sh(gl.FRAGMENT_SHADER, FRAGMENT));
    gl.bindAttribLocation(p, 0, "pos");
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p));
    gl.useProgram(p);
    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    const tex = () => {
      const t = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, t);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      return t;
    };
    this.tvid = tex();
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    this.ttab = tex();
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.uniform1i(gl.getUniformLocation(p, "tvid"), 0);
    gl.uniform1i(gl.getUniformLocation(p, "ttab"), 1);
    this.u = { masked: gl.getUniformLocation(p, "masked"), size: gl.getUniformLocation(p, "size"),
               smoothing: gl.getUniformLocation(p, "smoothing") };
    this.gl = gl;
    this.canvas.addEventListener("webglcontextlost", (e) => { e.preventDefault(); this.gl = null; });
    return true;
  };

  Renderer.prototype.setKey = function (key) {
    this.table = key ? BRV.decodeTable(key) : null;
    this.tableDirty = true;
  };

  Renderer.prototype.attach = function () {
    const parent = this.video.parentElement;
    if (parent && this.canvas.parentElement !== parent) {
      parent.insertBefore(this.canvas, this.video.nextSibling);
      if (root.getComputedStyle(parent).position === "static") parent.style.position = "relative";
    }
  };

  // place le calque exactement sur la zone où l'image est affichée (bandes noires comprises)
  Renderer.prototype.place = function () {
    const v = this.video, c = this.canvas;
    const w = v.offsetWidth, h = v.offsetHeight;
    if (!w || !h || !v.videoWidth) return;
    const ar = v.videoWidth / v.videoHeight;
    let cw = w, ch = h;
    const fit = root.getComputedStyle(v).objectFit;
    if (fit !== "fill") { if (w / h > ar) cw = h * ar; else ch = w / ar; }
    const left = v.offsetLeft + (w - cw) / 2, top = v.offsetTop + (h - ch) / 2;
    const s = c.style;
    const L = left + "px", T = top + "px", W = cw + "px", H = ch + "px";
    if (s.left !== L) s.left = L;
    if (s.top !== T) s.top = T;
    if (s.width !== W) s.width = W;
    if (s.height !== H) s.height = H;
  };

  Renderer.prototype.show = function (on) {
    if (on === this.visible) return;
    this.visible = on;
    this.canvas.style.display = on ? "block" : "none";
  };

  // dessine l'image courante ; mediaTime : horodatage de l'image dans la vidéo
  Renderer.prototype.draw = function (mediaTime, fps) {
    if (!this.visible || !this.table) return;
    if (!this.gl && !this.init()) return;
    this.attach();
    this.place();
    const gl = this.gl, v = this.video;
    const vw = v.videoWidth, vh = v.videoHeight;
    if (!vw) return;
    if (this.canvas.width !== vw || this.canvas.height !== vh) { this.canvas.width = vw; this.canvas.height = vh; }
    gl.viewport(0, 0, vw, vh);
    if (this.tableDirty) {
      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_2D, this.ttab);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 32, 18, 0, gl.RGBA, gl.UNSIGNED_BYTE, this.table);
      this.tableDirty = false;
    }
    const masked = mediaTime < BRV.openingSeconds(fps || 30) - 0.5 / (fps || 30);
    gl.uniform1i(this.u.masked, masked ? 1 : 0);
    if (!masked) {
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, this.tvid);
      try {
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGB, gl.RGB, gl.UNSIGNED_BYTE, v);
      } catch (e) {
        this.error = "image illisible (" + e.name + ")";
        this.show(false);
        return;
      }
      gl.uniform2f(this.u.size, vw, vh);
      gl.uniform1f(this.u.smoothing, vh >= 1440 ? 0 : vh <= 720 ? 0.35 : 0.2);
    }
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  };

  // test de lecture : l'image est-elle lisible par WebGL (pas de DRM ni d'origine étrangère) ?
  Renderer.prototype.readable = function () {
    try {
      if (!this.gl && !this.init()) return false;
      const gl = this.gl;
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, this.tvid);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGB, gl.RGB, gl.UNSIGNED_BYTE, this.video);
      return gl.getError() === gl.NO_ERROR;
    } catch (e) { return false; }
  };

  root.BRVVideo = { Renderer };
})(typeof globalThis !== "undefined" ? globalThis : this);
