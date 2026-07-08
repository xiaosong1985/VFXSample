/**
 * Event 类型定义 — 事件触发节点
 *
 * 添加新 Event 类型只需在 VFX_EVENT_DEFS 数组中追加条目。
 */

import type { IVfxEventTypeDef } from "./VfxTypes";

// ─── 颜色常量 ──────────────────────────────────────

const C_EVENT = "#C25B56";
const C_GPU_EVENT = "#D4A017";

// ─── Event 定义 ─────────────────────────────────────

export const VFX_EVENT_DEFS: IVfxEventTypeDef[] = [
    {
        typeId: "event",
        title: "Event",
        color: C_EVENT,
        flowOutputs: [
            { id: "evt", name: "Event", type: "flow" },
        ],
        properties: [
            { name: "eventName", caption: "Event Name", type: "string", default: "OnPlay" },
        ],
    },
    {
        typeId: "gpuEvent",
        title: "GPUEvent",
        color: C_GPU_EVENT,
        flowInputs: [
            { id: "evt", name: "Evt", type: "flow" },
        ],
        flowOutputs: [
            { id: "spawnEvt", name: "SpawnEvent", type: "flow" },
        ],
    },
];
