/**
 * VfxEditor i18n 命名空间 holder —— 独立文件 / 不带任何 @IEditor/@IEditorEnv 装饰器，
 * 可以被 main 进程和 scene 进程的任意脚本安全 import，不会反向拽入带装饰器的入口类。
 *
 * 实际 namespace 在 index.ts 的 @IEditor.onLoad 中 setup（gui.Translations.create
 * + setContent code.json）。display/ 等 panel 代码用法：
 *
 *   import { VfxI18n } from "../i18n";
 *   menu.label = VfxI18n.ns.t("deleteBlock");
 *
 * 通用词（save/delete/property...）仍直接走全局 i18n.t，不必过这里。
 */
export const VfxI18n: { ns: gui.Translations } = { ns: null as any };
