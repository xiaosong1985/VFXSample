/**
 * VFX GPU Noise Library — GLSL code string
 *
 * Port of Unity VFXNoise.hlsl (Brian Sharpe's GPU Noise Lib).
 * Returns value + analytical derivatives for all noise types.
 * Performance: pure ALU, no texture lookups, C2 continuous interpolation.
 *
 * Exported functions:
 *   - GenerateValueNoise3D(coord)      → vec4(noise, dNdx, dNdy, dNdz)
 *   - GeneratePerlinNoise3D(coord)     → vec4(noise, dNdx, dNdy, dNdz)
 *   - GenerateCellularNoise3D(coord)   → vec4(noise, dNdx, dNdy, dNdz)
 *   - GenerateValueNoise2D(coord)      → vec3(noise, dNdx, dNdy)
 *   - GeneratePerlinNoise2D(coord)     → vec3(noise, dNdx, dNdy)
 *   - GenerateCellularNoise2D(coord)   → vec3(noise, dNdx, dNdy)
 *   - Generate{Type}Noise(coord, freq, octaves, roughness, lacunarity) — FBM wrapper
 *   - Generate{Type}CurlNoise(coord, freq, octaves, roughness, lacunarity) — Curl wrapper
 */

export const VFX_NOISE_GLSL = /* glsl */ `
// ═══════════════════════════════════════════════════════════════
// VFX Noise Library (GPU-optimized, analytical derivatives)
// ═══════════════════════════════════════════════════════════════

// ─── Interpolation (C2 quintic) ────────────────────────────

vec3 _noiseC2(vec3 x) { return x * x * x * (x * (x * 6.0 - 15.0) + 10.0); }
vec3 _noiseC2Deriv(vec3 x) { return x * x * (x * (x * 30.0 - 60.0) + 30.0); }
vec4 _noiseC2_2D(vec2 x) {
    return x.xyxy * x.xyxy * (x.xyxy * (x.xyxy * (x.xyxy * vec4(6.0,6.0,0.0,0.0) + vec4(-15.0,-15.0,30.0,30.0)) + vec4(10.0,10.0,-60.0,-60.0)) + vec4(0.0,0.0,30.0,30.0));
}

// ─── Hash functions (ALU-only, no texture) ─────────────────

void _noiseHash3D(vec3 gc, out vec4 lz, out vec4 hz) {
    vec2 kO = vec2(50.0, 161.0); float kD = 69.0; float kL = 635.298681; float kZ = 48.500388;
    gc = gc - floor(gc / kD) * kD;
    vec3 gc1 = step(gc, vec3(kD - 1.5)) * (gc + 1.0);
    vec4 P = vec4(gc.xy, gc1.xy) + kO.xyxy; P *= P; P = P.xzxz * P.yyww;
    hz.xy = 1.0 / (kL + vec2(gc.z, gc1.z) * kZ);
    lz = fract(P * hz.xxxx); hz = fract(P * hz.yyyy);
}

void _noiseHash3D_3(vec3 gc,
    out vec4 lx, out vec4 ly, out vec4 lz,
    out vec4 hx, out vec4 hy, out vec4 hz) {
    vec2 kO = vec2(50.0, 161.0); float kD = 69.0;
    vec3 kL = vec3(635.298681, 682.357502, 668.926525);
    vec3 kZ = vec3(48.500388, 65.294118, 63.934599);
    gc = gc - floor(gc / kD) * kD;
    vec3 gc1 = step(gc, vec3(kD - 1.5)) * (gc + 1.0);
    vec4 P = vec4(gc.xy, gc1.xy) + kO.xyxy; P *= P; P = P.xzxz * P.yyww;
    vec3 lm = 1.0 / (kL + gc.zzz * kZ);
    vec3 hm = 1.0 / (kL + gc1.zzz * kZ);
    lx = fract(P * lm.x); hx = fract(P * hm.x);
    ly = fract(P * lm.y); hy = fract(P * hm.y);
    lz = fract(P * lm.z); hz = fract(P * hm.z);
}

void _noiseHash2D_2(vec2 gc, out vec4 h0, out vec4 h1) {
    vec2 kO = vec2(26.0, 161.0); float kD = 71.0;
    vec2 kL = vec2(1.0 / 951.135664, 1.0 / 642.949883);
    vec4 P = vec4(gc.xy, gc.xy + 1.0);
    P = P - floor(P / kD) * kD; P += kO.xyxy; P *= P; P = P.xzxz * P.yyww;
    h0 = fract(P * kL.x); h1 = fract(P * kL.y);
}

vec4 _cellWeight(vec4 s) { s = s * 2.0 - 1.0; return s * s * s - sign(s); }

// ═══════════════════════════════════════════════════════════════
// Value Noise 3D — vec4(noise, derivatives)
// ═══════════════════════════════════════════════════════════════

vec4 GenerateValueNoise3D(vec3 coord) {
    vec3 i = floor(coord), f = coord - i;
    vec4 lz, hz; _noiseHash3D(i, lz, hz);
    vec3 blend = _noiseC2(f);
    vec4 r0 = mix(lz, hz, blend.z);
    vec4 r1 = mix(r0.xyxz, r0.zwyw, blend.yyxx);
    vec4 r3 = mix(vec4(lz.xy, hz.xy), vec4(lz.zw, hz.zw), blend.y);
    vec2 r4 = mix(r3.xz, r3.yw, blend.x);
    vec3 d = vec3(r1.yw, r4.y) - vec3(r1.xz, r4.x);
    return vec4(r1.x + d.x * blend.x, d * _noiseC2Deriv(f));
}

// ═══════════════════════════════════════════════════════════════
// Perlin Noise 3D — vec4(noise, derivatives)
// ═══════════════════════════════════════════════════════════════

vec4 GeneratePerlinNoise3D(vec3 coord) {
    vec3 i = floor(coord), f = coord - i, fm = f - 1.0;
    vec4 hx0,hy0,hz0,hx1,hy1,hz1;
    _noiseHash3D_3(i, hx0,hy0,hz0, hx1,hy1,hz1);
    // gradients
    vec4 gx0=hx0-0.49999, gy0=hy0-0.49999, gz0=hz0-0.49999;
    vec4 gx1=hx1-0.49999, gy1=hy1-0.49999, gz1=hz1-0.49999;
    vec4 n0=inversesqrt(gx0*gx0+gy0*gy0+gz0*gz0);
    vec4 n1=inversesqrt(gx1*gx1+gy1*gy1+gz1*gz1);
    gx0*=n0; gy0*=n0; gz0*=n0; gx1*=n1; gy1*=n1; gz1*=n1;
    // dot products
    vec2 fx=vec2(f.x,fm.x), fy=vec2(f.y,fm.y);
    vec4 d0 = fx.xyxy*gx0 + fy.xxyy*gy0 + f.z*gz0;
    vec4 d1 = fx.xyxy*gx1 + fy.xxyy*gy1 + fm.z*gz1;
    // pack: value + gradient
    vec4 v0g0=vec4(d0.x,gx0.x,gy0.x,gz0.x), v1g1=vec4(d0.y,gx0.y,gy0.y,gz0.y);
    vec4 v2g2=vec4(d0.z,gx0.z,gy0.z,gz0.z), v3g3=vec4(d0.w,gx0.w,gy0.w,gz0.w);
    vec4 v4g4=vec4(d1.x,gx1.x,gy1.x,gz1.x), v5g5=vec4(d1.y,gx1.y,gy1.y,gz1.y);
    vec4 v6g6=vec4(d1.z,gx1.z,gy1.z,gz1.z), v7g7=vec4(d1.w,gx1.w,gy1.w,gz1.w);
    // common terms
    vec4 k0=v1g1-v0g0, k1=v2g2-v0g0, k2=v4g4-v0g0;
    vec4 k3=v3g3-v2g2-k0, k4=v5g5-v4g4-k0, k5=v6g6-v4g4-k1;
    vec4 k6=(v7g7-v6g6)-(v5g5-v4g4)-k3;
    vec3 bl=_noiseC2(f), bld=_noiseC2Deriv(f);
    float u=bl.x, v=bl.y, w=bl.z;
    vec4 res = v0g0 + u*(k0+v*k3) + v*(k1+w*k5) + w*(k2+u*(k4+v*k6));
    res.y += dot(vec4(k0.x, k3.x*v, k4.x*w, k6.x*v*w), vec4(bld.x));
    res.z += dot(vec4(k1.x, k3.x*u, k5.x*w, k6.x*u*w), vec4(bld.y));
    res.w += dot(vec4(k2.x, k4.x*u, k5.x*v, k6.x*u*v), vec4(bld.z));
    return res * 1.1547005;
}

// ═══════════════════════════════════════════════════════════════
// Cellular Noise 3D — vec4(noise, derivatives)
// ═══════════════════════════════════════════════════════════════

vec4 GenerateCellularNoise3D(vec3 coord) {
    vec3 i = floor(coord), f = coord - i;
    vec4 hx0,hy0,hz0,hx1,hy1,hz1;
    _noiseHash3D_3(i, hx0,hy0,hz0, hx1,hy1,hz1);
    float kJ = 0.166666666;
    hx0 = _cellWeight(hx0)*kJ + vec4(0,1,0,1); hy0 = _cellWeight(hy0)*kJ + vec4(0,0,1,1);
    hx1 = _cellWeight(hx1)*kJ + vec4(0,1,0,1); hy1 = _cellWeight(hy1)*kJ + vec4(0,0,1,1);
    hz0 = _cellWeight(hz0)*kJ; hz1 = _cellWeight(hz1)*kJ + 1.0;
    vec4 dx1=f.xxxx-hx0, dy1=f.yyyy-hy0, dz1=f.zzzz-hz0;
    vec4 dx2=f.xxxx-hx1, dy2=f.yyyy-hy1, dz2=f.zzzz-hz1;
    vec4 d1 = dx1*dx1+dy1*dy1+dz1*dz1, d2 = dx2*dx2+dy2*dy2+dz2*dz2;
    vec4 r1 = d1.x<d1.y ? vec4(d1.x,dx1.x,dy1.x,dz1.x) : vec4(d1.y,dx1.y,dy1.y,dz1.y);
    vec4 r2 = d1.z<d1.w ? vec4(d1.z,dx1.z,dy1.z,dz1.z) : vec4(d1.w,dx1.w,dy1.w,dz1.w);
    vec4 r3 = d2.x<d2.y ? vec4(d2.x,dx2.x,dy2.x,dz2.x) : vec4(d2.y,dx2.y,dy2.y,dz2.y);
    vec4 r4 = d2.z<d2.w ? vec4(d2.z,dx2.z,dy2.z,dz2.z) : vec4(d2.w,dx2.w,dy2.w,dz2.w);
    vec4 t1 = r1.x<r2.x ? r1 : r2, t2 = r3.x<r4.x ? r3 : r4;
    return (t1.x<t2.x ? t1 : t2) * vec4(1.0,2.0,2.0,2.0) * 0.75;
}

// ═══════════════════════════════════════════════════════════════
// 2D variants (for Curl noise)
// ═══════════════════════════════════════════════════════════════

vec3 GenerateValueNoise2D(vec2 coord) {
    vec2 i = floor(coord), f = coord - i;
    vec4 h; { vec2 kO=vec2(26.0,161.0); float kD=71.0; float kL=1.0/951.135664;
        vec4 P=vec4(i,i+1.0); P=P-floor(P/kD)*kD; P+=kO.xyxy; P*=P; h=fract(P.xzxz*P.yyww*kL); }
    vec4 bl = _noiseC2_2D(f);
    vec4 r0 = mix(h.xyxz, h.zwyw, bl.yyxx);
    vec2 d = r0.yw - r0.xz;
    return vec3(r0.x + d.x*bl.x, d*bl.zw);
}

vec3 GeneratePerlinNoise2D(vec2 coord) {
    vec2 i = floor(coord); vec4 ff = coord.xyxy - vec4(i, i+1.0);
    vec4 hx, hy; _noiseHash2D_2(i, hx, hy);
    vec4 gx=hx-0.49999, gy=hy-0.49999;
    vec4 n=inversesqrt(gx*gx+gy*gy); gx*=n; gy*=n;
    vec4 dv = gx*ff.xzxz + gy*ff.yyww;
    vec3 v0g0=vec3(dv.x,gx.x,gy.x), v1g1=vec3(dv.y,gx.y,gy.y);
    vec3 v2g2=vec3(dv.z,gx.z,gy.z), v3g3=vec3(dv.w,gx.w,gy.w);
    vec3 k0=v1g1-v0g0, k1=v2g2-v0g0, k2=v3g3-v2g2-k0;
    vec4 bl = _noiseC2_2D(ff.xy);
    vec3 res = v0g0 + bl.x*k0 + bl.y*(k1+bl.x*k2);
    res.yz += bl.zw * (vec2(k0.x,k1.x) + bl.yx*k2.xx);
    return res * 1.4142135;
}

vec3 GenerateCellularNoise2D(vec2 coord) {
    vec2 i = floor(coord), f = coord - i;
    vec4 hx, hy; _noiseHash2D_2(i, hx, hy);
    float kJ = 0.25;
    hx = _cellWeight(hx)*kJ + vec4(0,1,0,1); hy = _cellWeight(hy)*kJ + vec4(0,0,1,1);
    vec4 dx=f.xxxx-hx, dy=f.yyyy-hy, d=dx*dx+dy*dy;
    vec3 t1 = d.x<d.y ? vec3(d.x,dx.x,dy.x) : vec3(d.y,dx.y,dy.y);
    vec3 t2 = d.z<d.w ? vec3(d.z,dx.z,dy.z) : vec3(d.w,dx.w,dy.w);
    return (t1.x<t2.x ? t1 : t2) * vec3(1.0,2.0,2.0) / 1.125;
}

// ═══════════════════════════════════════════════════════════════
// FBM wrappers (multi-octave)
// ═══════════════════════════════════════════════════════════════

vec4 GenerateValueNoise(vec3 coord, float freq, int oct, float rough, float lac) {
    vec4 total = vec4(0.0); float amp = 1.0, tAmp = 0.0;
    for (int i = 0; i < oct; i++) { total += GenerateValueNoise3D(coord*freq)*amp; tAmp+=amp; amp*=rough; freq*=lac; }
    return total / tAmp;
}
vec4 GeneratePerlinNoise(vec3 coord, float freq, int oct, float rough, float lac) {
    vec4 total = vec4(0.0); float amp = 1.0, tAmp = 0.0;
    for (int i = 0; i < oct; i++) { total += GeneratePerlinNoise3D(coord*freq)*amp; tAmp+=amp; amp*=rough; freq*=lac; }
    return total / tAmp;
}
vec4 GenerateCellularNoise(vec3 coord, float freq, int oct, float rough, float lac) {
    vec4 total = vec4(0.0); float amp = 1.0, tAmp = 0.0;
    for (int i = 0; i < oct; i++) { total += GenerateCellularNoise3D(coord*freq)*amp; tAmp+=amp; amp*=rough; freq*=lac; }
    return total / tAmp;
}

// 对齐 Unity Noise.cs：value = Fit(n.x, [rawMin,1], range)；derivatives = n.yzw * (range.y-range.x)
// (n = GenerateXNoise 原始输出 vec4(value, dNdx,dNdy,dNdz); rawMin: Perlin=-1, Value/Cellular=0)
// 之前转换器把 Unity noise 的 range 写进 _inputs.range，但编译器只读 amplitude(默认1) → range 被忽略
// → 噪声及其导数不缩放(放大~500倍) → trail 位移漂移过大把粒子甩飞(Gateway Bronze VFX10 乱线根因)。
vec4 _applyNoiseRange(vec4 n, vec2 range, float rawMin) {
    float v = mix(range.x, range.y, clamp((n.x - rawMin) / max(1.0 - rawMin, 1e-6), 0.0, 1.0));
    return vec4(v, n.yzw * (range.y - range.x));
}

// ═══════════════════════════════════════════════════════════════
// Curl Noise (divergence-free vector field from 2D derivatives)
// ═══════════════════════════════════════════════════════════════

vec3 GenerateValueCurlNoise(vec3 coord, float freq, int oct, float rough, float lac) {
    vec2 t0=vec2(0.0), t1=vec2(0.0), t2=vec2(0.0);
    float amp=1.0, tAmp=0.0;
    vec2 p0=coord.zy, p1=coord.xz+100.0, p2=coord.yx+200.0;
    for (int i=0;i<oct;i++) {
        t0 += GenerateValueNoise2D(p0*freq).yz*amp;
        t1 += GenerateValueNoise2D(p1*freq).yz*amp;
        t2 += GenerateValueNoise2D(p2*freq).yz*amp;
        tAmp+=amp; amp*=rough; freq*=lac;
    }
    return vec3(t2.x-t1.y, t0.x-t2.y, t1.x-t0.y) / tAmp;
}
vec3 GeneratePerlinCurlNoise(vec3 coord, float freq, int oct, float rough, float lac) {
    vec2 t0=vec2(0.0), t1=vec2(0.0), t2=vec2(0.0);
    float amp=1.0, tAmp=0.0;
    vec2 p0=coord.zy, p1=coord.xz+100.0, p2=coord.yx+200.0;
    for (int i=0;i<oct;i++) {
        t0 += GeneratePerlinNoise2D(p0*freq).yz*amp;
        t1 += GeneratePerlinNoise2D(p1*freq).yz*amp;
        t2 += GeneratePerlinNoise2D(p2*freq).yz*amp;
        tAmp+=amp; amp*=rough; freq*=lac;
    }
    return vec3(t2.x-t1.y, t0.x-t2.y, t1.x-t0.y) / tAmp;
}
vec3 GenerateCellularCurlNoise(vec3 coord, float freq, int oct, float rough, float lac) {
    vec2 t0=vec2(0.0), t1=vec2(0.0), t2=vec2(0.0);
    float amp=1.0, tAmp=0.0;
    vec2 p0=coord.zy, p1=coord.xz+100.0, p2=coord.yx+200.0;
    for (int i=0;i<oct;i++) {
        t0 += GenerateCellularNoise2D(p0*freq).yz*amp;
        t1 += GenerateCellularNoise2D(p1*freq).yz*amp;
        t2 += GenerateCellularNoise2D(p2*freq).yz*amp;
        tAmp+=amp; amp*=rough; freq*=lac;
    }
    return vec3(t2.x-t1.y, t0.x-t2.y, t1.x-t0.y) / tAmp;
}

// ═══════════════════════════════════════════════════════════════
// VoroNoise 2D (Inigo Quilez style smooth blended voronoi)
// https://iquilezles.org/articles/voronoise/
//   u = angle_offset: 0=regular grid / 1=full jitter
//   v = cell_density: 0=sharp cells / 1=smooth blend
// ═══════════════════════════════════════════════════════════════

vec3 VoroHash3(vec2 p) {
    vec3 q = vec3(
        dot(p, vec2(127.1, 311.7)),
        dot(p, vec2(269.5, 183.3)),
        dot(p, vec2(419.2, 371.9))
    );
    return fract(sin(q) * 43758.5453);
}

float GenerateVoroNoise2D(vec2 coord, float u, float v) {
    vec2 p = floor(coord);
    vec2 f = fract(coord);
    float k = 1.0 + 63.0 * pow(max(1.0 - v, 0.0), 4.0);
    float va = 0.0;
    float wt = 0.0;
    for (int j = -2; j <= 2; j++) {
        for (int i = -2; i <= 2; i++) {
            vec2 g = vec2(float(i), float(j));
            vec3 o = VoroHash3(p + g) * vec3(u, u, 1.0);
            vec2 r = g - f + o.xy;
            float d = dot(r, r);
            float ww = pow(max(1.0 - smoothstep(0.0, 1.414, sqrt(d)), 0.0), k);
            va += o.z * ww;
            wt += ww;
        }
    }
    return va / max(wt, 1e-6);
}

// ═══════════════════════════════════════════════════════════════
// Probability Sampling (加权离散采样，4 分量权重)
// ═══════════════════════════════════════════════════════════════

int ProbabilitySample4(vec4 weights, float r) {
    vec4 w = max(weights, vec4(0.0));
    float total = w.x + w.y + w.z + w.w;
    if (total <= 1e-6) return 0;
    float threshold = r * total;
    float cumulative = w.x;
    if (threshold < cumulative) return 0;
    cumulative += w.y;
    if (threshold < cumulative) return 1;
    cumulative += w.z;
    if (threshold < cumulative) return 2;
    return 3;
}
`;
