import fs from "fs";
import { VfxStage } from "../display/VfxStage";
import type { IVfxGraphData } from "../data/VfxTypes";
import { VFX_GRAPH_PROPERTIES } from "../data/VfxNodeDefs";
import { propDefaultToIDE, propDefaultToRuntime, promoteAABoxType, demoteAABoxType } from "../data/VfxPropValueBridge";
import type { IVfxHost } from "./IVfxHost";

/**
 * VFX Graph 中央画布组件。
 * 不再是独立 EditorPanel，由 VfxGraphPanel 持有并嵌入到中栏。
 */
export class VfxScenePanel {
    panel: gui.Widget;

    private _host: IVfxHost;
    private _stage: VfxStage;
    private _history: IEditor.IDataHistory;
    private _assetId: string;
    private _filePath: string;
    private _fileName: string = "";
    private _versionTracker: IEditor.IVersionTracker;

    get stage(): VfxStage {
        return this._stage;
    }

    get history(): IEditor.IDataHistory {
        return this._history;
    }

    get isModified(): boolean {
        return this._versionTracker?.isModified ?? false;
    }

    get fileName(): string {
        return this._fileName;
    }

    /** 当前打开的 .vfx 资源 UUID（无文件时为空串）。用于 panel 持久化记忆 */
    get assetId(): string {
        return this._assetId || "";
    }

    async create(parent: gui.Widget, host: IVfxHost): Promise<void> {
        this._host = host;

        this.panel = new gui.Widget();
        parent.addChild(this.panel);

        this._stage = new VfxStage();
        this.panel.addChild(this._stage);

        // 不用 chained relation，手动监听父容器 size_changed 显式 setSize 整链
        // chained Size relation 在某些初始 size = 0 的场景下传播不可靠
        const syncSize = () => {
            const w = parent.width;
            const h = parent.height;
            this.panel.setSize(w, h);
            this._stage.setSize(w, h);
        };
        parent.on("size_changed", syncSize, this);
        syncSize();

        await this._stage.init();

        // 版本跟踪（脏状态）
        this._versionTracker = {
            savePoint: 0,
            isModified: false,
            setModified: (value: boolean) => {
                if (this._versionTracker.isModified !== value) {
                    this._versionTracker.isModified = value;
                    this._notifyTitle();
                }
            },
        };

        // 初始化空图数据
        this._history = new IEditor.DataHistory(this._versionTracker);
        let rawData: IVfxGraphData = { autoID: 0, events: [], contexts: [], operators: [] };
        this._ensureGraphProps(rawData);
        let emptyData = this._history.trace(rawData) as IVfxGraphData;
        this._stage.setData(emptyData, this._history);

        // 选择变更 → 更新 Inspector
        this._stage.onSelectionChanged = () => this.refreshInspector();

        // 默认显示图级属性
        this.refreshInspector();
        this.refreshPropertyPanel();
    }

    refreshInspector(): void {
        const inspector = this._host.inspector;
        if (!inspector) return;

        const sel = this._stage.selection;
        if (sel.length === 1) {
            inspector.show(sel[0]);
        } else {
            inspector.showGraph(this._stage.graphData);
        }
    }

    refreshPropertyPanel(): void {
        const propPanel = this._host.propertyPanel;
        if (!propPanel) return;
        propPanel.setGraphData(this._stage.graphData);
    }

    /** 打开 .vfx 文件 */
    async open(assetId: string): Promise<void> {
        // 立即清空 stage 上的旧内容，避免用户在 await 加载新文件期间还看到上一个文件
        // title 不动，等下面 setData 后由 _notifyTitle() 一次性更新到新文件名（避免中间闪 Untitled）
        this._stage.clearAll();
        this._assetId = assetId;
        this._filePath = null;
        this._versionTracker.isModified = false;

        let info = await Editor.assetDb.getAsset(assetId);
        if (!info) {
            console.warn("[VfxScenePanel] open failed: asset not found for id:", assetId);
            return;
        }

        this._filePath = Editor.assetDb.getFullPath(info);
        this._fileName = info.name;
        console.log("[VfxScenePanel] opened file:", this._filePath);

        let data: IVfxGraphData = null;
        try {
            if (fs.existsSync(this._filePath)) {
                data = JSON.parse(await fs.promises.readFile(this._filePath, "utf8"));
            }
        } catch (err: any) {
            console.error("read '" + this._filePath + "' failed", err);
        }
        if (!data) data = { autoID: 0, events: [], contexts: [], operators: [] };
        if (!data.events) data.events = [];
        if (!data.contexts) data.contexts = [];
        if (!data.operators) data.operators = [];
        this._ensureGraphProps(data);

        // 属性 default 值：运行时格式 → IDE 编辑器格式（Gradient/资源类型），
        // 让内置 Gradient/Asset 编辑器能直接显示真实值。存盘时由 save() 转回运行时格式。
        if (Array.isArray(data.properties)) {
            for (const p of data.properties as any[]) {
                if (!p) continue;
                // 先把 AABox 形状的属性 type 提升为 "AABox"（转换器降级成了 float）
                promoteAABoxType(p);
                if (p.type != null) p.default = propDefaultToIDE(p.type, p.default);
            }
        }

        // 重置脏状态
        this._versionTracker.isModified = false;
        this._versionTracker.savePoint++;

        this._history = new IEditor.DataHistory(this._versionTracker);
        let watchedData = this._history.trace(data) as IVfxGraphData;
        this._stage.setData(watchedData, this._history);

        this.refreshInspector();
        this.refreshPropertyPanel();
        this._notifyTitle();
    }

    /** 保存当前图数据到 .vfx 文件 */
    async save(): Promise<boolean> {
        if (!this._filePath) {
            console.warn("[VfxScenePanel] save failed: no file path (file not opened)");
            return false;
        }
        if (!this._stage.graphData) {
            console.warn("[VfxScenePanel] save failed: no graph data");
            return false;
        }

        let data = IEditor.DataWatcher.getOriginalObj(this._stage.graphData);
        console.log("[VfxScenePanel] saving to:", this._filePath,
            "contexts:", data.contexts.length, "operators:", data.operators.length);

        // 属性 default 值：IDE 编辑器格式 → 运行时格式（Gradient/资源类型）。
        // 深拷贝整个对象再转换，绝不改内存里被 watch 的 graphData（继续保持 IDE 格式可编辑）。
        let saveData = data;
        if (Array.isArray(data.properties)) {
            saveData = JSON.parse(JSON.stringify(data));
            for (const p of saveData.properties as any[]) {
                if (!p || p.type == null) continue;
                p.default = propDefaultToRuntime(p.type, p.default);
                // AABox 降回 "float"，保持 .vfx 文件与 runtime 格式跟转换器产出一致
                demoteAABoxType(p);
            }
        }

        this._history.paused = true;
        try {
            await fs.promises.writeFile(this._filePath, JSON.stringify(saveData, null, 2), { encoding: "utf-8" });
        } catch (err: any) {
            console.error("write '" + this._filePath + "' failed: " + err);
        }
        this._history.paused = false;

        // 重置脏状态
        this._versionTracker.isModified = false;
        this._versionTracker.savePoint++;
        this._notifyTitle();

        return true;
    }

    /** 确保图级属性默认值存在 */
    private _ensureGraphProps(data: IVfxGraphData): void {
        if (!data.props) data.props = {};
        if (!data.properties) data.properties = [];
        for (const prop of VFX_GRAPH_PROPERTIES) {
            if (data.props[prop.name] == null && prop.default != null) {
                data.props[prop.name] = prop.default;
            }
        }
    }

    /** 通知宿主面板更新标题 */
    private _notifyTitle(): void {
        this._host.updateTitle(this._fileName || "Untitled", this._versionTracker.isModified);
    }
}
