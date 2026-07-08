import type { VfxScenePanel } from "./VfxScenePanel";
import type { VfxPropertyPanel } from "./VfxPropertyPanel";
import type { VfxInspectorPanel } from "./VfxInspectorPanel";

/**
 * 合并面板 VfxGraphPanel 暴露给子组件的协作接口。
 * 子组件不再通过 panelManager 互相查找，改为通过 host 访问兄弟组件 / 通知 title 变化。
 */
export interface IVfxHost {
    readonly scene: VfxScenePanel;
    readonly propertyPanel: VfxPropertyPanel;
    readonly inspector: VfxInspectorPanel;
    /** 文件名或脏状态变化时调用，更新面板内部的标题显示 */
    updateTitle(fileName: string, modified: boolean): void;
}
