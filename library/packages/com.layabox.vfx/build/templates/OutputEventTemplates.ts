/**
 * Output Event 类型模板注册表
 *
 * triggerEvent block 路由到 outputEvent context 时，update shader 在条件满足时
 * 写入 OutputEventBuffer（CPU readback 后由 VisualEffect 派发到回调）。
 *
 * 与 GPU Event 区别：
 *   - GPU Event 写 EventIndexBuffer（粒子索引），用于 spawn 子粒子
 *   - Output Event 写 OutputEventBuffer（固定 attribute 快照），用于 CPU 通知
 *   - param 参数仅 GPU Event 使用（spawn count / rate），Output Event 每次条件满足写 1 条
 *
 * 每条 entry 固定 16 float / 64 byte 布局（与 runtime 解析匹配）：
 *   [0]    particleId   (uint via uintBitsToFloat)
 *   [1-3]  position     (vec3)
 *   [4]    age
 *   [5-7]  velocity     (vec3)
 *   [8]    lifetime
 *   [9-12] color        (vec4 rgba)
 *   [13]   size
 *   [14-15] padding
 */

export const OUTPUT_EVENT_ENTRY_FLOATS = 16;
export const OUTPUT_EVENT_ENTRY_BYTES = OUTPUT_EVENT_ENTRY_FLOATS * 4;

export interface IOutputEventSnippetCtx {
    eventIdx: number;         // 此 event 在当前 Update 中的序号 (0, 1, 2...)
    capacity: number;         // 缓冲容量上限（写入时检查溢出）
    bufferName: string;       // "OutputEvent0" 等
    paramValue: number;       // 触发参数（OverTime rate / OverDistance rate / Always count）
    accExpr?: string;         // 累加器索引表达式（OverTime/OverDistance 用）
    attrNames?: Set<string>;  // 此 system 的 Particle struct 包含的字段名，决定 writeEntry 读哪些
}

export interface IOutputEventTemplate {
    /** 是否需要 AccumulatorBuffer slot（与 GPU Event 共用累加器） */
    accSlotsPerParticle: number;
    /** Update shader 触发条件下的 entry 写入代码 */
    genUpdateSnippet(ctx: IOutputEventSnippetCtx): string;
}

/** 写一条 entry 到 OutputEventBuffer（共用代码片段）— 按 attrNames 决定读 Particle 字段或写 0.0 */
function writeEntry(bufferName: string, capacity: number, indent: string, attrNames?: Set<string>): string {
    // attrNames 缺省 → 假设所有字段都存在（向后兼容）；否则按集合判定
    // 注意：color 是 vec3（rgb 三通道），alpha 是独立 float 字段（见 VFX_PARTICLE_ATTRIBUTES）
    const has = (n: string) => !attrNames || attrNames.has(n);
    const hasPosition = has("position");
    const hasVelocity = has("velocity");
    const hasColor = has("color");
    const hasAlpha = has("alpha");
    const hasSize = has("size");
    const hasAge = has("age");
    const hasLifetime = has("lifetime");
    return `\
${indent}uint _slot = atomicAdd(${bufferName}.count, 1u);
${indent}if (_slot < ${capacity}u) {
${indent}    uint _b = _slot * ${OUTPUT_EVENT_ENTRY_FLOATS}u;
${indent}    ${bufferName}.data[_b + 0u]  = uintBitsToFloat(particleIndex);
${indent}    ${bufferName}.data[_b + 1u]  = ${hasPosition ? "p.position.x" : "0.0"};
${indent}    ${bufferName}.data[_b + 2u]  = ${hasPosition ? "p.position.y" : "0.0"};
${indent}    ${bufferName}.data[_b + 3u]  = ${hasPosition ? "p.position.z" : "0.0"};
${indent}    ${bufferName}.data[_b + 4u]  = ${hasAge ? "p.age" : "0.0"};
${indent}    ${bufferName}.data[_b + 5u]  = ${hasVelocity ? "p.velocity.x" : "0.0"};
${indent}    ${bufferName}.data[_b + 6u]  = ${hasVelocity ? "p.velocity.y" : "0.0"};
${indent}    ${bufferName}.data[_b + 7u]  = ${hasVelocity ? "p.velocity.z" : "0.0"};
${indent}    ${bufferName}.data[_b + 8u]  = ${hasLifetime ? "p.lifetime" : "0.0"};
${indent}    ${bufferName}.data[_b + 9u]  = ${hasColor ? "p.color.x" : "0.0"};
${indent}    ${bufferName}.data[_b + 10u] = ${hasColor ? "p.color.y" : "0.0"};
${indent}    ${bufferName}.data[_b + 11u] = ${hasColor ? "p.color.z" : "0.0"};
${indent}    ${bufferName}.data[_b + 12u] = ${hasAlpha ? "p.alpha" : "1.0"};
${indent}    ${bufferName}.data[_b + 13u] = ${hasSize ? "p.size" : "0.0"};
${indent}    ${bufferName}.data[_b + 14u] = 0.0;
${indent}    ${bufferName}.data[_b + 15u] = 0.0;
${indent}}`;
}

// ─── OnDie ──────────────────────────────────────────

const OnDie: IOutputEventTemplate = {
    accSlotsPerParticle: 0,

    genUpdateSnippet(ctx) {
        return `\
    // Output Event [${ctx.eventIdx}]: OnDie
    if (!p.alive) {
${writeEntry(ctx.bufferName, ctx.capacity, "        ", ctx.attrNames)}
    }`;
    },
};

// ─── Always ─────────────────────────────────────────

const Always: IOutputEventTemplate = {
    accSlotsPerParticle: 0,

    genUpdateSnippet(ctx) {
        return `\
    // Output Event [${ctx.eventIdx}]: Always (every frame)
    {
${writeEntry(ctx.bufferName, ctx.capacity, "        ", ctx.attrNames)}
    }`;
    },
};

// ─── OverTime ───────────────────────────────────────

const OverTime: IOutputEventTemplate = {
    accSlotsPerParticle: 1,

    genUpdateSnippet(ctx) {
        const rate = Number(ctx.paramValue) || 1;
        const rateLit = String(rate).includes('.') ? String(rate) : rate + ".0";
        const accExpr = ctx.accExpr || "particleIndex";
        return `\
    // Output Event [${ctx.eventIdx}]: OverTime (rate = ${rate}/s)
    {
        uint _accIdx = ${accExpr};
        float _acc = AccumulatorsOE.data[_accIdx];
        _acc += ${rateLit} * u_DeltaTime;
        uint _spawnCount = uint(floor(_acc));
        _acc -= float(_spawnCount);
        AccumulatorsOE.data[_accIdx] = _acc;
        for (uint i = 0u; i < _spawnCount; i++) {
${writeEntry(ctx.bufferName, ctx.capacity, "            ", ctx.attrNames)}
        }
    }`;
    },
};

// ─── OverDistance ────────────────────────────────────

const OverDistance: IOutputEventTemplate = {
    accSlotsPerParticle: 1,

    genUpdateSnippet(ctx) {
        const rate = Number(ctx.paramValue) || 1;
        const rateLit = String(rate).includes('.') ? String(rate) : rate + ".0";
        const accExpr = ctx.accExpr || "particleIndex";
        return `\
    // Output Event [${ctx.eventIdx}]: OverDistance (rate = ${rate}/m)
    {
        uint _accIdx = ${accExpr};
        float _acc = AccumulatorsOE.data[_accIdx];
        _acc += ${rateLit} * length(p.position - p.oldPosition);
        uint _spawnCount = uint(floor(_acc));
        _acc -= float(_spawnCount);
        AccumulatorsOE.data[_accIdx] = _acc;
        for (uint i = 0u; i < _spawnCount; i++) {
${writeEntry(ctx.bufferName, ctx.capacity, "            ", ctx.attrNames)}
        }
    }`;
    },
};

// ─── 注册表 ─────────────────────────────────────────

export const OUTPUT_EVENT_TEMPLATES: Record<string, IOutputEventTemplate> = {
    OnDie,
    Always,
    OverTime,
    OverDistance,
};
