/**
 * GPU Event 类型模板注册表
 *
 * 每种 eventType 定义：
 *   - accSlotsPerParticle: 每粒子在 AccumulatorBuffer 中占用的 float 数
 *   - genUpdateSnippet:    Update shader 中插入的事件输出 GLSL
 *   - genInitClearSnippet:  Initialize shader 中插入的累加器清零 GLSL
 */

export interface IGPUEventSnippetCtx {
    eventIdx: number;         // 此 event 在当前 Update 中的序号 (0, 1, 2...)
    accOffset: number;        // 在 AccumulatorBuffer 中的偏移
    totalAccSlots: number;    // 每粒子总累加器 slot 数
    paramValue: number;       // 硬编码到 GLSL 的参数值
    bufferName: string;       // "GPUEvent0" 等
}

export interface IGPUEventTemplate {
    accSlotsPerParticle: number;
    genUpdateSnippet(ctx: IGPUEventSnippetCtx): string;
    genInitClearSnippet(ctx: { accOffset: number; totalAccSlots: number }): string;
}

// ─── OnDie ──────────────────────────────────────────

const OnDie: IGPUEventTemplate = {
    accSlotsPerParticle: 0,

    genUpdateSnippet(ctx) {
        const count = Math.max(1, Math.round(ctx.paramValue));
        return `\
    // GPU Event [${ctx.eventIdx}]: OnDie (spawn ${count} on death)
    if (!p.alive) {
        for (uint i = 0u; i < ${count}u; i++) {
            uint slot = atomicAdd(${ctx.bufferName}.count, 1u);
            ${ctx.bufferName}.indices[slot] = particleIndex;
        }
    }`;
    },

    genInitClearSnippet() {
        return ""; // OnDie 不需要累加器
    },
};

// ─── OverTime ───────────────────────────────────────

const OverTime: IGPUEventTemplate = {
    accSlotsPerParticle: 1,

    genUpdateSnippet(ctx) {
        const accExpr = ctx.totalAccSlots > 1
            ? `particleIndex * ${ctx.totalAccSlots}u + ${ctx.accOffset}u`
            : `particleIndex`;
        const rate = Number(ctx.paramValue) || 1;
        const rateLit = String(rate).includes('.') ? String(rate) : rate + ".0";
        return `\
    // GPU Event [${ctx.eventIdx}]: OverTime (rate = ${rate}/s)
    {
        uint accIdx_${ctx.eventIdx} = ${accExpr};
        float acc_${ctx.eventIdx} = Accumulators.data[accIdx_${ctx.eventIdx}];
        acc_${ctx.eventIdx} += ${rateLit} * u_DeltaTime;
        uint spawnCount_${ctx.eventIdx} = uint(floor(acc_${ctx.eventIdx}));
        acc_${ctx.eventIdx} -= float(spawnCount_${ctx.eventIdx});
        Accumulators.data[accIdx_${ctx.eventIdx}] = acc_${ctx.eventIdx};

        for (uint i = 0u; i < spawnCount_${ctx.eventIdx}; i++) {
            uint slot = atomicAdd(${ctx.bufferName}.count, 1u);
            ${ctx.bufferName}.indices[slot] = particleIndex;
        }
    }`;
    },

    genInitClearSnippet(ctx) {
        const accExpr = ctx.totalAccSlots > 1
            ? `particleIndex * ${ctx.totalAccSlots}u + ${ctx.accOffset}u`
            : `particleIndex`;
        return `    Accumulators.data[${accExpr}] = 0.0;`;
    },
};

// ─── OverDistance ────────────────────────────────────

const OverDistance: IGPUEventTemplate = {
    accSlotsPerParticle: 1,

    genUpdateSnippet(ctx) {
        const accExpr = ctx.totalAccSlots > 1
            ? `particleIndex * ${ctx.totalAccSlots}u + ${ctx.accOffset}u`
            : `particleIndex`;
        const rate = Number(ctx.paramValue) || 1;
        const rateLit = String(rate).includes('.') ? String(rate) : rate + ".0";
        return `\
    // GPU Event [${ctx.eventIdx}]: OverDistance (rate = ${rate}/m)
    {
        uint accIdx_${ctx.eventIdx} = ${accExpr};
        float acc_${ctx.eventIdx} = Accumulators.data[accIdx_${ctx.eventIdx}];
        acc_${ctx.eventIdx} += ${rateLit} * length(p.position - p.oldPosition);
        uint spawnCount_${ctx.eventIdx} = uint(floor(acc_${ctx.eventIdx}));
        acc_${ctx.eventIdx} -= float(spawnCount_${ctx.eventIdx});
        Accumulators.data[accIdx_${ctx.eventIdx}] = acc_${ctx.eventIdx};

        for (uint i = 0u; i < spawnCount_${ctx.eventIdx}; i++) {
            uint slot = atomicAdd(${ctx.bufferName}.count, 1u);
            ${ctx.bufferName}.indices[slot] = particleIndex;
        }
    }`;
    },

    genInitClearSnippet(ctx) {
        const accExpr = ctx.totalAccSlots > 1
            ? `particleIndex * ${ctx.totalAccSlots}u + ${ctx.accOffset}u`
            : `particleIndex`;
        return `    Accumulators.data[${accExpr}] = 0.0;`;
    },
};

// ─── Always ─────────────────────────────────────────

const Always: IGPUEventTemplate = {
    accSlotsPerParticle: 0,

    genUpdateSnippet(ctx) {
        const count = Math.max(1, Math.round(ctx.paramValue));
        return `\
    // GPU Event [${ctx.eventIdx}]: Always (${count} events per particle per frame)
    {
        for (uint i = 0u; i < ${count}u; i++) {
            uint slot = atomicAdd(${ctx.bufferName}.count, 1u);
            ${ctx.bufferName}.indices[slot] = particleIndex;
        }
    }`;
    },

    genInitClearSnippet() {
        return ""; // Always 不需要累加器
    },
};

// ─── 注册表 ─────────────────────────────────────────

export const GPU_EVENT_TEMPLATES: Record<string, IGPUEventTemplate> = {
    OnDie,
    Always,
    OverTime,
    OverDistance,
};
