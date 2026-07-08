import { registerAllVfxTypes } from "./data/VfxNodeDefs";
import { componentTypes } from "./editor/ComponentTypes";
import { VfxPropertyOverridesField } from "./editor/VfxPropertyOverridesField";
import { VfxI18n } from "./i18n";
import "./panels/VfxGraphPanel";

/**
 * VFX 插件 IDE 主进程入口
 * - @IEditor.onLoad 在 IDE 启动期注册所有 VFX typeRegistry 类型
 * - 组件菜单（SelectComponentDialog）从 IDE 主进程的 typeRegistry 读，所以这里需要
 *   主动注册 VisualEffect / VFXRenderer
 * - i18n 三类资源同步加载（对齐粒子 Main.ts:onLoad）：
 *     typeCaption.json — 节点显示名翻译，注入到 type.captionTranslation 和 def.title
 *     typeTips.json    — 节点提示翻译，注入到 type.tipsTranslation
 *     code.json        — 面板/按钮/菜单等代码里的 UI 字符串，setContent 到 gui.Translations 命名空间
 * - VfxExtension.i18n 命名空间供面板代码取本地化文案，通用词（save/delete/property）
 *   优先走全局 i18n.t（LayaPro 内置 bin/locales）。
 * - VfxGraphPanel 通过 @IEditor.panel 装饰器自注册，这里只需 side-effect import
 *
 * scene 进程那一份在 ./Scene.ts —— LayaPro 按文件第一个装饰器分进程，不能合并到这个文件。
 */
export class VfxExtension {
    @IEditor.onLoad
    static async onLoad() {
        VfxI18n.ns = gui.Translations.create("VfxEditor");

        let captionTrans: Record<string, string> | undefined;
        let tipsTrans: Record<string, string> | undefined;
        try {
            const localesAsset = await Editor.assetDb.getAsset("VfxEditor/editorResources/locales", true);
            if (localesAsset) {
                const localesDir = Editor.assetDb.getFullPath(localesAsset);
                await Promise.all([
                    IEditor.utils.readJsonAsync(`${localesDir}/${i18n.language}/typeCaption.json`)
                        .then(data => { if (data) captionTrans = data; })
                        .catch(() => { /* 缺翻译表不影响主流程 */ }),
                    IEditor.utils.readJsonAsync(`${localesDir}/${i18n.language}/typeTips.json`)
                        .then(data => { if (data) tipsTrans = data; })
                        .catch(() => { }),
                    IEditor.utils.readJsonAsync(`${localesDir}/${i18n.language}/code.json`)
                        .then(data => { if (data) VfxI18n.ns.setContent(i18n.language, data); })
                        .catch(() => { }),
                ]);
            }
        } catch {
            /* getAsset 失败也兜底走默认英文 caption */
        }

        registerAllVfxTypes(captionTrans, tipsTrans);
        Editor.typeRegistry.addTypes(componentTypes);

        // 注册 VisualEffect 组件 Inspector 的 Properties 区域自定义渲染器
        IEditor.InspectorRegistry.registerFieldClass("VfxPropertyOverrides", VfxPropertyOverridesField as any);
    }
}
