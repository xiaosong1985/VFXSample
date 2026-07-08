/**
 * FlagsField — bitmask 多选下拉 Inspector 控件
 *
 * 属性定义需要 type: "flags" + enumSource: string[]，
 * resolveProps 会转为 type: "number", inspector: "flags"。
 * 值存为 number（bitmask），enumSource[i] 对应 bit i。
 */

export class FlagsField extends IEditor.PropertyField {
    private _dropBg: gui.Shape;
    private _valText: gui.TextField;
    private _options: string[];

    public create() {
        this._options = (this.property.enumSource as string[]) || [];

        // 下拉背景
        const dropBg = new gui.Shape();
        dropBg.setSize(120, 22);
        const g = dropBg.getGraphics(gui.SRect);
        g.borderRadius = [3, 3, 3, 3];
        g.lineWidth = 0;
        g.fillColor.parse("#2a2a2a");
        dropBg.touchable = true;
        this._dropBg = dropBg;

        // 值文字
        const valText = new gui.TextField();
        valText.style.fontSize = 11;
        valText.color = 0xDDDDDD;
        valText.setPos(6, 2);
        valText.setSize(96, 18);
        dropBg.addChild(valText);
        this._valText = valText;

        // 下拉箭头
        const arrow = new gui.TextField();
        arrow.text = "\u25BC";
        arrow.style.fontSize = 9;
        arrow.color = 0x999999;
        arrow.setPos(102, 3);
        arrow.setSize(14, 16);
        arrow.style.align = gui.AlignType.Right;
        dropBg.addChild(arrow);

        dropBg.on("pointer_down", (e: gui.Event) => {
            if (e.input.button !== 0) return;
            e.stopPropagation();
            this._showMenu();
        });

        return { ui: dropBg, stretchWidth: true };
    }

    public refresh(): void {
        const mask = (this.target.getValue() as number) ?? 0;
        this._updateText(mask);
    }

    private _updateText(mask: number): void {
        const options = this._options;
        const selected = options.filter((_, i) => mask & (1 << i));
        this._valText.text = selected.length === 0 ? "None" : selected.length === options.length ? "All" : selected.join(", ");
    }

    private _showMenu(): void {
        let curMask = (this.target.getValue() as number) ?? 0;
        const options = this._options;
        const allMask = (1 << options.length) - 1;

        const items: any[] = [
            {
                label: "None", click: () => {
                    this.target.setValue(0);
                    this._updateText(0);
                }
            },
            {
                label: "All", click: () => {
                    this.target.setValue(allMask);
                    this._updateText(allMask);
                }
            },
            { type: "separator" },
            ...options.map((v, i) => ({
                label: v,
                type: "checkbox" as const,
                checked: !!(curMask & (1 << i)),
                click: () => {
                    curMask = (this.target.getValue() as number) ?? 0;
                    curMask ^= (1 << i);
                    this.target.setValue(curMask);
                    this._updateText(curMask);
                },
            })),
        ];
        IEditor.Menu.create(items).show(this._dropBg);
    }
}
