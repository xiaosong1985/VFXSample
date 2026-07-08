/**
 * VFX 属性 default 值 —— 运行时格式 ↔ IDE 编辑器格式 双向桥接
 *
 * 背景：
 *   转换器/运行时(.vfx, VFXAssetParser, 组件 Properties)用的存储格式跟 LayaIDE
 *   内置 Gradient / 资源(Asset)字段编辑器期望的格式不一致：
 *     - Gradient 运行时：{ stops:[{ t, color:{r,g,b,a} }] }
 *               IDE   ：{ _mode, _colorRGBKeysCount, _colorAlphaKeysCount,
 *                          _rgbElements:[pos,r,g,b,...], _alphaElements:[pos,alpha,...] }
 *                        （RGB 轨与 Alpha 轨分开，见 GradientValue.toData/fromData）
 *     - Texture2D/Mesh 运行时：["res://uuid"]（数组）或 "res://uuid"（字符串）
 *               IDE   ：{ _$uuid: uuid }（裸 uuid，AssetField 读写）
 *     - number/color/vec/bool：两端一致，原样透传。
 *
 * 策略：
 *   编辑器内存(graphData)统一用 IDE 格式 → 内置编辑器可直接显示/编辑；
 *   存盘时再转回运行时格式（深拷贝，不污染内存）。详见 VfxScenePanel.open/save。
 *
 * 健壮性：输入已是目标格式 / 为空 / 类型不符时安全返回，绝不抛错。
 */

interface IGradientStop { t: number; color: { r: number; g: number; b: number; a: number }; }

/** 在按 pos 升序的 key 数组上线性采样（端点 clamp） */
function _sampleTrack(keys: Array<{ pos: number }>, pos: number, lerp: (a: any, b: any, f: number) => any): any {
    if (keys.length === 0) return null;
    if (pos <= keys[0].pos) return keys[0];
    const last = keys[keys.length - 1];
    if (pos >= last.pos) return last;
    for (let i = 0; i < keys.length - 1; i++) {
        const a = keys[i], b = keys[i + 1];
        if (pos >= a.pos && pos <= b.pos) {
            const span = b.pos - a.pos;
            const f = span > 1e-8 ? (pos - a.pos) / span : 0;
            return lerp(a, b, f);
        }
    }
    return last;
}

// ─── Gradient ────────────────────────────────────────

/** 运行时 {stops} → IDE {_rgbElements/_alphaElements} */
function gradientToIDE(val: any): any {
    // 已是 IDE 格式（有 _rgbElements）直接返回
    if (val && Array.isArray(val._rgbElements)) return val;
    const stops: IGradientStop[] = (val && Array.isArray(val.stops)) ? val.stops : [];
    if (stops.length === 0) {
        // 空 → 默认白色不透明单关键帧
        return { _mode: 0, _colorRGBKeysCount: 1, _colorAlphaKeysCount: 1, _rgbElements: [0, 1, 1, 1], _alphaElements: [0, 1] };
    }
    const rgb: number[] = [];
    const alpha: number[] = [];
    for (const s of stops) {
        const c = s.color || { r: 1, g: 1, b: 1, a: 1 };
        const t = s.t ?? 0;
        rgb.push(t, c.r ?? 0, c.g ?? 0, c.b ?? 0);
        alpha.push(t, c.a ?? 1);
    }
    return {
        _mode: val._mode ?? 0,
        _colorRGBKeysCount: stops.length,
        _colorAlphaKeysCount: stops.length,
        _rgbElements: rgb,
        _alphaElements: alpha,
    };
}

/** IDE {_rgbElements/_alphaElements} → 运行时 {stops} */
function gradientToRuntime(val: any): any {
    // 已是运行时格式（有 stops）直接返回
    if (val && Array.isArray(val.stops)) return val;
    if (!val || !Array.isArray(val._rgbElements)) return val;

    const rgbCount = val._colorRGBKeysCount ?? Math.floor((val._rgbElements?.length || 0) / 4);
    const alphaCount = val._colorAlphaKeysCount ?? Math.floor((val._alphaElements?.length || 0) / 2);
    const rgbArr = val._rgbElements || [];
    const alphaArr = val._alphaElements || [];

    const rgbKeys: Array<{ pos: number; r: number; g: number; b: number }> = [];
    for (let i = 0; i < rgbCount; i++) {
        rgbKeys.push({ pos: rgbArr[i * 4], r: rgbArr[i * 4 + 1], g: rgbArr[i * 4 + 2], b: rgbArr[i * 4 + 3] });
    }
    const alphaKeys: Array<{ pos: number; alpha: number }> = [];
    for (let i = 0; i < alphaCount; i++) {
        alphaKeys.push({ pos: alphaArr[i * 2], alpha: alphaArr[i * 2 + 1] });
    }
    rgbKeys.sort((a, b) => a.pos - b.pos);
    alphaKeys.sort((a, b) => a.pos - b.pos);

    // 位置并集 → 每个位置在两轨各采样一次（同位置 → 无损还原）
    const posSet = new Set<number>();
    for (const k of rgbKeys) posSet.add(k.pos);
    for (const k of alphaKeys) posSet.add(k.pos);
    const positions = Array.from(posSet).sort((a, b) => a - b);
    if (positions.length === 0) positions.push(0);

    const lerpRGB = (a: any, b: any, f: number) => ({
        r: a.r + (b.r - a.r) * f, g: a.g + (b.g - a.g) * f, b: a.b + (b.b - a.b) * f,
    });
    const lerpAlpha = (a: any, b: any, f: number) => ({ alpha: a.alpha + (b.alpha - a.alpha) * f });

    const stops: IGradientStop[] = positions.map(pos => {
        const c = _sampleTrack(rgbKeys, pos, lerpRGB) || { r: 1, g: 1, b: 1 };
        const a = _sampleTrack(alphaKeys, pos, lerpAlpha) || { alpha: 1 };
        return { t: pos, color: { r: c.r, g: c.g, b: c.b, a: a.alpha } };
    });
    return { stops };
}

// ─── Texture2D / Mesh（资源引用）─────────────────────

/** 运行时 ["res://uuid"] / "res://uuid" → IDE { _$uuid } */
function assetRefToIDE(val: any): any {
    if (val && typeof val === "object" && !Array.isArray(val)) {
        // 已是 IDE 格式
        if (typeof val._$uuid === "string") return val;
    }
    let s: string = null;
    if (Array.isArray(val)) s = val.length > 0 ? val[0] : null;
    else if (typeof val === "string") s = val;
    if (!s) return null;
    if (s.startsWith("res://")) s = s.slice("res://".length);
    return { _$uuid: s };
}

/** IDE { _$uuid } / "res://uuid" → 运行时 ["res://uuid"] */
function assetRefToRuntime(val: any): any {
    if (Array.isArray(val)) return val; // 已是运行时格式
    let uuid: string = null;
    if (val && typeof val === "object" && typeof val._$uuid === "string") uuid = val._$uuid;
    else if (typeof val === "string") uuid = val.startsWith("res://") ? val.slice("res://".length) : val;
    if (!uuid) return [];
    return ["res://" + uuid];
}

// ─── 对外分派入口 ────────────────────────────────────

const _ASSET_TYPES = new Set(["Texture2D", "Texture3D", "TextureCube", "Mesh"]);

/** 运行时格式 → IDE 编辑器格式（按 prop.type 分派；不识别的类型原样返回） */
export function propDefaultToIDE(type: string, val: any): any {
    if (val == null) return val;
    if (type === "Gradient") return gradientToIDE(val);
    if (_ASSET_TYPES.has(type)) return assetRefToIDE(val);
    return val;
}

/** IDE 编辑器格式 → 运行时格式（按 prop.type 分派；不识别的类型原样返回） */
export function propDefaultToRuntime(type: string, val: any): any {
    if (val == null) return val;
    if (type === "Gradient") return gradientToRuntime(val);
    if (_ASSET_TYPES.has(type)) return assetRefToRuntime(val);
    return val;
}

// ─── AABox / Bounds 类型提升 ─────────────────────────
//
// 转换器把 Unity AABox(Bounds) 降级成 type:"float"，但 default 仍是
// { center:{x,y,z}, size:{x,y,z} } 对象 → float 编辑器只显示 0。
// 编辑器内存里把这类属性 type 提升为 "AABox"（渲染 Center/Size），存盘时再降回
// "float"（runtime normalizePropertyType 把 "float"/"AABox" 都当 Float，行为一致）。

/** 判断 default 值是否是 AABox 形状（含 center+size 对象） */
export function isAABoxShape(val: any): boolean {
    return !!val && typeof val === "object" && !Array.isArray(val)
        && val.center != null && typeof val.center === "object"
        && val.size != null && typeof val.size === "object";
}

/** 打开文件时：default 为 AABox 形状的属性，type 提升为 "AABox"（仅内存，用于正确渲染） */
export function promoteAABoxType(prop: { type?: string; default?: any }): void {
    if (prop && isAABoxShape(prop.default)) prop.type = "AABox";
}

/** 存盘时：type==="AABox" 降回 "float"，保持 .vfx 文件与 runtime 格式不变 */
export function demoteAABoxType(prop: { type?: string }): void {
    if (prop && prop.type === "AABox") prop.type = "float";
}
