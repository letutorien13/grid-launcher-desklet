const Desklet = imports.ui.desklet;
const St = imports.gi.St;
const Cinnamon = imports.gi.Cinnamon;
const GLib = imports.gi.GLib;
const Gio = imports.gi.Gio;
const Meta = imports.gi.Meta;
const Main = imports.ui.main;
const PopupMenu = imports.ui.popupMenu;
const Clutter = imports.gi.Clutter;
const Tooltips = imports.ui.tooltips;
const Pango = imports.gi.Pango;
const DND = imports.ui.dnd;

const STORAGE_PATH = GLib.get_home_dir() + '/.config/cinnamon_grid_launcher_data.json';
const ICON_SLOT = 72;
const ICON_SIZE = 56;
const EDGE_GRAB = 22;
const PAD = 10;
const TITLE_H = 32;
const MIN_COLS = 3;
const MAX_COLS = 16;
const MIN_ROWS = 2;
const MAX_ROWS = 16;
const DISPLAY_GRID = 'grid';
const DISPLAY_LIST = 'list';
const LIST_ICON_SIZE = 24;
const LIST_ROW_HEIGHT = 34;
const LIST_WIDTH = 220;

class GridLauncherV2Desklet extends Desklet.Desklet {
    _init(metadata, instance_id) {
        super._init(metadata, instance_id);

        this.instance_id = String(instance_id);
        this.appSystem = Cinnamon.AppSystem.get_default();
        this._menuManager = new PopupMenu.PopupMenuManager(this);
        this._itemMenus = [];
        this._lastRightClickOnIcon = false;
        this._isResizing = false;
        this._resizeMode = null;
        this._motionId = null;
        this._releaseId = null;
        this._xdndHovering = false;
        this._xdndDropPending = false;

        this._loadData();
        this._buildUi();
        this._setupDesktopDrop();
        this._buildDeskletMenu();
        this._applyLayout();
        this._updateResizeMenuVisibility();
        this._refreshGrid();
    }

    _buildUi() {
        this.frame = new St.BoxLayout({
            vertical: true,
            reactive: true,
            track_hover: true,
            style_class: 'gl2-frame'
        });

        this.titleLabel = new St.Label({
            text: this.deskletLabel,
            style_class: 'gl2-title',
            reactive: true
        });

        this.titleEntry = new St.Entry({
            visible: false,
            reactive: true,
            style_class: 'gl2-title-entry'
        });

        this.titleLabel.connect('button-press-event', (a, ev) => {
            if (ev.get_click_count() === 2 && ev.get_button() === 1) {
                this._startRename();
                return Clutter.EVENT_STOP;
            }
            return Clutter.EVENT_PROPAGATE;
        });

        this.titleEntry.clutter_text.connect('activate', () => this._finishRename(true));
        this.titleEntry.clutter_text.connect('key-press-event', (a, ev) => {
            if (ev.get_key_symbol() === Clutter.KEY_Escape) {
                this._finishRename(false);
                return Clutter.EVENT_STOP;
            }
            return Clutter.EVENT_PROPAGATE;
        });

        this.grid = new St.Table({ homogeneous: true, style_class: 'gl2-grid' });
        this.listScroll = new St.ScrollView({
            style_class: 'gl2-list-scroll',
            x_expand: true,
            y_expand: true
        });
        this.listScroll.set_policy(St.PolicyType.NEVER, St.PolicyType.AUTOMATIC);
        this.listBox = new St.BoxLayout({ vertical: true, style_class: 'gl2-list', x_expand: true });
        this.listScroll.add_actor(this.listBox);
        this.listScroll.hide();

        this.frame.add_actor(this.titleLabel);
        this.frame.add_actor(this.titleEntry);
        this.frame.add_actor(this.grid);
        this.frame.add_actor(this.listScroll);

        this.setContent(this.frame);
        this.setHeader(this.deskletLabel);
        this.actor._delegate = this;

        this._connectEdgeResize(this.frame);
        this._connectEdgeResize(this.titleLabel);
        this._connectEdgeResize(this.grid);
        this._connectEdgeResize(this.listScroll);
    }

    _isListMode() {
        return this.displayMode === DISPLAY_LIST;
    }

    _openIconContextMenu(menu, btn, event) {
        this._lastRightClickOnIcon = true;

        for (let m of this._itemMenus) {
            if (m !== menu && m.isOpen)
                m.close(true);
        }

        let [gx, gy] = event.get_coords();
        GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
            menu.open(false);
            let [, , mw, mh] = menu.actor.get_preferred_size();
            let x = Math.round(gx - mw / 2);
            let y = Math.round(gy + 6);
            let mon = Main.layoutManager.findMonitorForPoint(x, y);
            if (x + mw > mon.x + mon.width)
                x = mon.x + mon.width - mw;
            if (x < mon.x)
                x = mon.x;
            if (y + mh > mon.y + mon.height)
                y = Math.round(gy - mh - 6);
            if (y < mon.y)
                y = mon.y;
            menu.actor.set_position(x, y);
            return false;
        });
    }

    _clickOnIconButton(event) {
        let actor = event.get_source();
        while (actor) {
            if (actor._gl2IconBtn)
                return true;
            if (actor === this.actor)
                break;
            actor = actor.get_parent();
        }
        return false;
    }

    _onButtonReleaseEvent(actor, event) {
        if (event.get_button() === 3) {
            if (this._lastRightClickOnIcon || this._clickOnIconButton(event)) {
                this._lastRightClickOnIcon = false;
                return Clutter.EVENT_STOP;
            }
            this._menu.toggle();
            return Clutter.EVENT_STOP;
        }
        if (this._menu.isOpen)
            this._menu.toggle();
        this.on_desklet_clicked(event);
        return Clutter.EVENT_STOP;
    }

    _buildDeskletMenu() {
        let rename = new PopupMenu.PopupMenuItem('Renommer');
        rename.connect('activate', () => this._startRename());
        this._menu.addMenuItem(rename);

        let sortByName = new PopupMenu.PopupMenuItem('Trier par nom');
        sortByName.connect('activate', () => this._sortItemsByName());
        this._menu.addMenuItem(sortByName);

        this.toggleDisplayModeItem = new PopupMenu.PopupMenuItem('');
        this._updateDisplayModeMenuLabel();
        this.toggleDisplayModeItem.connect('activate', () => this._toggleDisplayMode());
        this._menu.addMenuItem(this.toggleDisplayModeItem);

        this._menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        this.addColItem = new PopupMenu.PopupMenuItem('Ajouter une colonne');
        this.addColItem.connect('activate', () => this._changeCols(1));
        this._menu.addMenuItem(this.addColItem);

        this.remColItem = new PopupMenu.PopupMenuItem('Retirer une colonne');
        this.remColItem.connect('activate', () => this._changeCols(-1));
        this._menu.addMenuItem(this.remColItem);

        this.addRowItem = new PopupMenu.PopupMenuItem('Ajouter une ligne');
        this.addRowItem.connect('activate', () => this._changeRows(1));
        this._menu.addMenuItem(this.addRowItem);

        this.remRowItem = new PopupMenu.PopupMenuItem('Retirer une ligne');
        this.remRowItem.connect('activate', () => this._changeRows(-1));
        this._menu.addMenuItem(this.remRowItem);

        this._updateResizeMenuVisibility();
    }

    _updateDisplayModeMenuLabel() {
        if (!this.toggleDisplayModeItem)
            return;
        let text = this._isListMode() ? 'Afficher en mode grille' : 'Afficher en mode liste';
        this.toggleDisplayModeItem.label.set_text(text);
    }

    _updateResizeMenuVisibility() {
        let gridOnly = !this._isListMode();
        if (this.addColItem)
            this.addColItem.actor.visible = gridOnly;
        if (this.remColItem)
            this.remColItem.actor.visible = gridOnly;
        if (this.addRowItem)
            this.addRowItem.actor.visible = gridOnly;
        if (this.remRowItem)
            this.remRowItem.actor.visible = gridOnly;
    }

    _toggleDisplayMode() {
        this.displayMode = this._isListMode() ? DISPLAY_GRID : DISPLAY_LIST;
        this._updateDisplayModeMenuLabel();
        this._updateResizeMenuVisibility();
        this._applyLayout();
        this._refreshGrid();
        this._saveData();
    }

    _chromeW() {
        return 2 * PAD + 2 * EDGE_GRAB;
    }

    _chromeH() {
        return TITLE_H + 2 * PAD + 2 * EDGE_GRAB;
    }

    _widthForCols(cols) {
        return cols * ICON_SLOT + this._chromeW();
    }

    _heightForRows(rows) {
        return rows * ICON_SLOT + this._chromeH();
    }

    _listRowsForItems() {
        return Math.max(MIN_ROWS, Math.min(MAX_ROWS, this.savedItems.length));
    }

    _listVisibleRows() {
        return Math.max(MIN_ROWS, this.rows, this._listRowsForItems());
    }

    _listContentHeight() {
        return this._listVisibleRows() * LIST_ROW_HEIGHT;
    }

    _widthForList() {
        return LIST_WIDTH + this._chromeW();
    }

    _heightForList() {
        return this._listContentHeight() + this._chromeH();
    }

    _applyLayout() {
        let w, h;
        if (this._isListMode()) {
            w = this._widthForList();
            h = this._heightForList();
        } else {
            w = this._widthForCols(this.columns);
            h = this._heightForRows(this.rows);
        }
        this.frame.set_size(w, h);
        this.content.set_width(w);
        this.content.set_height(h);
        this.actor.set_width(w);
        this.actor.set_height(h);
        if (this._isListMode() && this.listScroll) {
            let innerW = Math.max(1, w - 2 * PAD);
            this.listScroll.set_size(innerW, this._listContentHeight());
        }
    }

    _getItemDisplayName(item) {
        if (!item)
            return '';
        if (item.type === 'app') {
            let app = this.appSystem.lookup_app(item.id);
            return app ? app.get_name() : item.id;
        }
        try {
            let file = Gio.File.new_for_uri(item.id);
            let info = file.query_info('standard::display-name',
                Gio.FileQueryInfoFlags.NONE, null);
            return info.get_display_name();
        } catch (e) {
            return GLib.path_get_basename(item.id);
        }
    }

    _sortItemsByName() {
        if (this.savedItems.length < 2)
            return;
        this.savedItems.sort((a, b) => {
            return this._getItemDisplayName(a).localeCompare(this._getItemDisplayName(b));
        });
        this._saveData();
        this._refreshGrid();
    }

    _changeCols(delta) {
        if (this._isListMode())
            return;
        let next = Math.max(MIN_COLS, Math.min(MAX_COLS, this.columns + delta));
        if (next === this.columns)
            return;
        this.columns = next;
        this._applyLayout();
        this._refreshGrid();
        this._saveData();
    }

    _changeRows(delta) {
        if (this._isListMode())
            return;
        let next = Math.max(MIN_ROWS, Math.min(MAX_ROWS, this.rows + delta));
        if (next === this.rows)
            return;
        this.rows = next;
        this._applyLayout();
        this._refreshGrid();
        this._saveData();
    }

    _slotHasItem(row, col, cols, count) {
        let idx = row * cols + col;
        return idx < count;
    }

    _rowIsEmpty(row, cols, rows, count) {
        for (let c = 0; c < cols; c++) {
            if (this._slotHasItem(row, c, cols, count))
                return false;
        }
        return true;
    }

    _columnIsEmpty(col, cols, rows, count) {
        for (let r = 0; r < rows; r++) {
            if (this._slotHasItem(r, col, cols, count))
                return false;
        }
        return true;
    }

    _syncListRows() {
        if (!this._isListMode())
            return false;
        let need = this._listRowsForItems();
        if (this.rows !== need) {
            this.rows = need;
            return true;
        }
        return false;
    }

    _trimEmptyGrid() {
        if (this._isListMode())
            return false;
        let cols = this.columns;
        let rows = this.rows;
        let count = this.savedItems.length;
        let changed = false;

        if (count === 0) {
            if (cols !== MIN_COLS || rows !== MIN_ROWS) {
                this.columns = MIN_COLS;
                this.rows = MIN_ROWS;
                return true;
            }
            return false;
        }

        let minRows = Math.ceil(count / cols);
        while (rows < minRows && rows < MAX_ROWS) {
            rows++;
            changed = true;
        }

        while (rows > MIN_ROWS && this._rowIsEmpty(rows - 1, cols, rows, count)) {
            rows--;
            changed = true;
        }

        while (cols > MIN_COLS && this._columnIsEmpty(cols - 1, cols, rows, count)) {
            cols--;
            changed = true;
        }

        if (this.columns !== cols || this.rows !== rows) {
            this.columns = cols;
            this.rows = rows;
            changed = true;
        }

        return changed;
    }

    _localOnFrame(event) {
        let [gx, gy] = event.get_coords();
        let box = this.frame.get_allocation_box();
        if (gx < box.x1 || gx > box.x2 || gy < box.y1 || gy > box.y2)
            return null;
        return [gx - box.x1, gy - box.y1];
    }

    _edgeAt(x, y) {
        let w = this.frame.get_width();
        let h = this.frame.get_height();
        if (w <= 0 || h <= 0)
            return null;
        let m = EDGE_GRAB;
        let L = x <= m;
        let R = x >= w - m;
        let T = y <= m;
        let B = y >= h - m;
        if (T && L) return 'nw';
        if (T && R) return 'ne';
        if (B && L) return 'sw';
        if (B && R) return 'se';
        if (T) return 'n';
        if (B) return 's';
        if (L) return 'w';
        if (R) return 'e';
        return null;
    }

    _cursorForEdge(edge) {
        let map = {
            n: Cinnamon.Cursor.RESIZE_TOP,
            s: Cinnamon.Cursor.RESIZE_BOTTOM,
            e: Cinnamon.Cursor.RESIZE_RIGHT,
            w: Cinnamon.Cursor.RESIZE_LEFT,
            nw: Cinnamon.Cursor.RESIZE_TOP_LEFT,
            ne: Cinnamon.Cursor.RESIZE_TOP_RIGHT,
            sw: Cinnamon.Cursor.RESIZE_BOTTOM_LEFT,
            se: Cinnamon.Cursor.RESIZE_BOTTOM_RIGHT
        };
        return map[edge] || Cinnamon.Cursor.DEFAULT;
    }

    _connectEdgeResize(actor) {
        actor.connect('motion-event', (a, ev) => {
            if (this._isResizing || this._isListMode()) {
                if (!this._isResizing)
                    global.unset_cursor();
                return;
            }
            let p = this._localOnFrame(ev);
            if (!p) {
                global.unset_cursor();
                return;
            }
            let edge = this._edgeAt(p[0], p[1]);
            if (edge)
                global.set_cursor(this._cursorForEdge(edge));
            else
                global.unset_cursor();
        });

        actor.connect('button-press-event', (a, ev) => {
            if (ev.get_button() !== 1 || this._isResizing || this._isListMode())
                return Clutter.EVENT_PROPAGATE;
            let p = this._localOnFrame(ev);
            if (!p)
                return Clutter.EVENT_PROPAGATE;
            let edge = this._edgeAt(p[0], p[1]);
            if (!edge)
                return Clutter.EVENT_PROPAGATE;
            this._beginResize(edge, ev.get_coords());
            return Clutter.EVENT_STOP;
        });
    }

    _anchorsLeft(mode) {
        return mode === 'w' || mode === 'nw' || mode === 'sw';
    }

    _anchorsTop(mode) {
        return mode === 'n' || mode === 'nw' || mode === 'ne';
    }

    _beginResize(mode, coords) {
        this._isResizing = true;
        this._resizeMode = mode;
        this._resizeStartX = coords[0];
        this._resizeStartY = coords[1];
        this._resizeStartCols = this.columns;
        this._resizeStartRows = this.rows;
        this._resizeStartActorX = this.actor.get_x();
        this._resizeStartActorY = this.actor.get_y();

        global.set_cursor(this._cursorForEdge(mode));
        this.frame.add_style_class_name('gl2-resizing');

        this._motionId = global.stage.connect('motion-event', (stage, ev) => {
            if (!this._isResizing)
                return;
            this._onResizeMotion(ev.get_coords());
        });

        this._releaseId = global.stage.connect('button-release-event', () => {
            if (this._isResizing)
                this._endResize();
        });
    }

    _onResizeMotion(coords) {
        let dx = coords[0] - this._resizeStartX;
        let dy = coords[1] - this._resizeStartY;
        let mode = this._resizeMode;
        let cols = this._resizeStartCols;
        let rows = this._resizeStartRows;

        if (mode === 'e' || mode === 'ne' || mode === 'se')
            cols = this._resizeStartCols + Math.round(dx / ICON_SLOT);
        else if (mode === 'w' || mode === 'nw' || mode === 'sw')
            cols = this._resizeStartCols - Math.round(dx / ICON_SLOT);

        if (mode === 's' || mode === 'se' || mode === 'sw')
            rows = this._resizeStartRows + Math.round(dy / ICON_SLOT);
        else if (mode === 'n' || mode === 'ne' || mode === 'nw')
            rows = this._resizeStartRows - Math.round(dy / ICON_SLOT);

        cols = Math.max(MIN_COLS, Math.min(MAX_COLS, cols));
        rows = Math.max(MIN_ROWS, Math.min(MAX_ROWS, rows));

        if (cols === this.columns && rows === this.rows)
            return;

        this.columns = cols;
        this.rows = rows;
        this._applyLayout();
        this._refreshGrid(true);

        let w = this._widthForCols(cols);
        let h = this._heightForRows(rows);
        let x = this._resizeStartActorX;
        let y = this._resizeStartActorY;

        if (this._anchorsLeft(mode))
            x = this._resizeStartActorX + (this._widthForCols(this._resizeStartCols) - w);
        if (this._anchorsTop(mode))
            y = this._resizeStartActorY + (this._heightForRows(this._resizeStartRows) - h);

        this.actor.set_x(Math.round(x));
        this.actor.set_y(Math.round(y));
    }

    _endResize() {
        if (this._motionId !== null) {
            global.stage.disconnect(this._motionId);
            this._motionId = null;
        }
        if (this._releaseId !== null) {
            global.stage.disconnect(this._releaseId);
            this._releaseId = null;
        }

        global.unset_cursor();
        this.frame.remove_style_class_name('gl2-resizing');

        let anchor = this._anchorsLeft(this._resizeMode) || this._anchorsTop(this._resizeMode);
        this._isResizing = false;
        this._resizeMode = null;

        this._refreshGrid();
        this._saveData();
        if (anchor)
            this._persistPosition();
    }

    _persistPosition() {
        try {
            let uuid = this._uuid || 'grid-launcher-v2@local';
            let list = global.settings.get_strv('enabled-desklets');
            let prefix = uuid + ':' + this.instance_id + ':';
            for (let i = 0; i < list.length; i++) {
                if (list[i].indexOf(prefix) === 0) {
                    let parts = list[i].split(':');
                    parts[2] = Math.round(this.actor.get_x());
                    parts[3] = Math.round(this.actor.get_y());
                    list[i] = parts.join(':');
                    global.settings.set_strv('enabled-desklets', list);
                    break;
                }
            }
        } catch (e) {
            global.logError(e);
        }
    }

    _refreshGrid(skipTrim) {
        this._itemMenus.forEach(m => m.destroy());
        this._itemMenus = [];

        if (this._isListMode()) {
            this.grid.hide();
            this.listScroll.show();
            this._refreshList(skipTrim);
            return;
        }

        this.listScroll.hide();
        this.grid.show();
        this._refreshGridCells(skipTrim);
    }

    _refreshList(skipTrim) {
        this.listBox.destroy_all_children();

        if (!this._isListMode())
            return;

        if (!skipTrim && this._syncListRows())
            this._saveData();
        this._applyLayout();

        for (let i = 0; i < this.savedItems.length; i++) {
            this._addListRow(this.savedItems[i], i);
        }
    }

    _addListRow(item, index) {
        let displayName = this._getItemDisplayName(item);
        let row = new St.Button({
            reactive: true,
            style_class: 'gl2-list-row',
            x_expand: true,
            can_focus: true
        });
        row._gl2IconBtn = true;

        let rowBox = new St.BoxLayout({ vertical: false, style: 'spacing: 8px;' });
        let icon = null;

        if (item.type === 'app') {
            let app = this.appSystem.lookup_app(item.id);
            icon = app
                ? app.create_icon_texture(LIST_ICON_SIZE)
                : new St.Icon({ icon_name: 'application-x-executable', icon_size: LIST_ICON_SIZE });
            row.connect('clicked', () => { if (app) app.activate(); });
        } else {
            try {
                let file = Gio.File.new_for_uri(item.id);
                let info = file.query_info('standard::display-name,standard::icon',
                    Gio.FileQueryInfoFlags.NONE, null);
                icon = new St.Icon({ gicon: info.get_icon(), icon_size: LIST_ICON_SIZE });
            } catch (e) {
                icon = new St.Icon({ icon_name: 'folder', icon_size: LIST_ICON_SIZE });
            }
            row.connect('clicked', () => {
                Gio.app_info_launch_default_for_uri(item.id, null);
            });
        }

        let label = new St.Label({
            text: displayName,
            style_class: 'gl2-list-label',
            y_align: St.Align.MIDDLE,
            x_expand: true
        });
        label.clutter_text.set_ellipsize(Pango.EllipsizeMode.END);

        rowBox.add(icon, { expand: false, x_fill: false, y_fill: false });
        rowBox.add(label, { expand: true, x_fill: true, y_fill: false });
        row.set_child(rowBox);
        new Tooltips.Tooltip(row, displayName);

        let menu = new PopupMenu.PopupMenu(row, St.Side.TOP);
        this._menuManager.addMenu(menu);
        Main.uiGroup.add_actor(menu.actor);
        menu.actor.hide();

        let removeItem = new PopupMenu.PopupMenuItem("Retirer l'élément");
        removeItem.connect('activate', () => {
            this.savedItems.splice(index, 1);
            this._saveData();
            this._refreshGrid();
        });
        menu.addMenuItem(removeItem);

        row.connect('button-press-event', (a, ev) => {
            if (ev.get_button() === 3) {
                this._openIconContextMenu(menu, row, ev);
                return true;
            }
            return false;
        });

        this._itemMenus.push(menu);
        this.listBox.add(row, { expand: false, x_fill: true, y_fill: false });
    }

    _refreshGridCells(skipTrim) {
        this.grid.destroy_all_children();

        if (!skipTrim && this._trimEmptyGrid())
            this._applyLayout();

        let slots = this.columns * this.rows;

        for (let i = 0; i < slots; i++) {
            let row = Math.floor(i / this.columns);
            let col = i % this.columns;
            let item = this.savedItems[i];

            if (item) {
                let btn = new St.Button({ reactive: true, style_class: 'gl2-cell-btn' });
                btn._gl2IconBtn = true;
                let icon = null;
                let tip = '';

                if (item.type === 'app') {
                    let app = this.appSystem.lookup_app(item.id);
                    icon = app
                        ? app.create_icon_texture(ICON_SIZE)
                        : new St.Icon({ icon_name: 'application-x-executable', icon_size: ICON_SIZE });
                    tip = app ? app.get_name() : item.id;
                    btn.connect('clicked', () => { if (app) app.activate(); });
                } else {
                    try {
                        let file = Gio.File.new_for_uri(item.id);
                        let info = file.query_info('standard::display-name,standard::icon',
                            Gio.FileQueryInfoFlags.NONE, null);
                        icon = new St.Icon({ gicon: info.get_icon(), icon_size: ICON_SIZE });
                        tip = info.get_display_name();
                    } catch (e) {
                        icon = new St.Icon({ icon_name: 'folder', icon_size: ICON_SIZE });
                        tip = item.id;
                    }
                    btn.connect('clicked', () => {
                        Gio.app_info_launch_default_for_uri(item.id, null);
                    });
                }

                btn.set_child(icon);
                new Tooltips.Tooltip(btn, tip);

                let menu = new PopupMenu.PopupMenu(btn, St.Side.TOP);
                this._menuManager.addMenu(menu);
                Main.uiGroup.add_actor(menu.actor);
                menu.actor.hide();

                let idx = i;
                let removeItem = new PopupMenu.PopupMenuItem("Retirer l'élément");
                removeItem.connect('activate', () => {
                    this.savedItems.splice(idx, 1);
                    this._saveData();
                    this._refreshGrid();
                });
                menu.addMenuItem(removeItem);

                btn.connect('button-press-event', (a, ev) => {
                    if (ev.get_button() === 3) {
                        this._openIconContextMenu(menu, btn, ev);
                        return true;
                    }
                    return false;
                });

                this._itemMenus.push(menu);
                this.grid.add(btn, { row: row, col: col });
            } else {
                let empty = new St.Bin({ style_class: 'gl2-cell-empty' });
                this.grid.add(empty, { row: row, col: col });
            }
        }
    }

    _setupDesktopDrop() {
        if (Main.xdndHandler) {
            this._xdndDragBeginId = Main.xdndHandler.connect('drag-begin', () => {
                this._xdndHovering = false;
                this._xdndDropPending = false;
            });
            this._xdndDragEndId = Main.xdndHandler.connect('drag-end', () => {
                if (this._xdndDropPending)
                    this._handleXdndDrop();
                this._xdndHovering = false;
                this._xdndDropPending = false;
            });
        }

        try {
            let dnd = Meta.get_backend().get_dnd();
            this._metaDndLeaveId = dnd.connect('dnd-leave', () => {
                if (this._xdndDropPending)
                    this._handleXdndDrop();
                this._xdndHovering = false;
                this._xdndDropPending = false;
            });
        } catch (e) {
            global.logError(e);
        }
    }

    _teardownDesktopDrop() {
        if (this._xdndDragBeginId && Main.xdndHandler) {
            Main.xdndHandler.disconnect(this._xdndDragBeginId);
            this._xdndDragBeginId = null;
        }
        if (this._xdndDragEndId && Main.xdndHandler) {
            Main.xdndHandler.disconnect(this._xdndDragEndId);
            this._xdndDragEndId = null;
        }
        if (this._metaDndLeaveId) {
            try {
                Meta.get_backend().get_dnd().disconnect(this._metaDndLeaveId);
            } catch (e) {
            }
            this._metaDndLeaveId = null;
        }
    }

    _localPointOnFrame(stageX, stageY) {
        let [ok, lx, ly] = this.frame.transform_stage_point(stageX, stageY);
        if (!ok)
            return false;
        let w = this.frame.get_width();
        let h = this.frame.get_height();
        return lx >= 0 && ly >= 0 && lx <= w && ly <= h;
    }

    _pointerOverDesklet() {
        let [px, py] = global.get_pointer();
        return this._localPointOnFrame(px, py);
    }

    _pickXdndMime(selection, dndType) {
        let mimes = selection.get_mimetypes(dndType);
        if (!mimes || mimes.length === 0)
            return null;
        let preferred = [
            'text/x-uri-list',
            'x-special/gnome-copied-files',
            'text/plain',
            'UTF8_STRING',
            'STRING'
        ];
        for (let i = 0; i < preferred.length; i++) {
            if (mimes.indexOf(preferred[i]) >= 0)
                return preferred[i];
        }
        return mimes[0];
    }

    _parseDropText(text, mime) {
        let uris = [];
        if (!text)
            return uris;

        let lines = text.split(/\r?\n/);
        if (mime === 'x-special/gnome-copied-files') {
            for (let i = 0; i < lines.length; i++) {
                let line = lines[i].trim();
                if (!line || line === 'copy' || line === 'cut')
                    continue;
                if (line.indexOf('file://') === 0 || line.indexOf('/') === 0)
                    uris.push(line.indexOf('file://') === 0 ? line : GLib.filename_to_uri(line, null));
            }
            return uris;
        }

        for (let i = 0; i < lines.length; i++) {
            let line = lines[i].trim();
            if (!line)
                continue;
            if (line.indexOf('file://') === 0)
                uris.push(line);
            else if (line.indexOf('/') === 0)
                uris.push(GLib.filename_to_uri(line, null));
        }
        return uris;
    }

    _readXdndUris() {
        let uris = [];
        try {
            let selection = global.display.get_selection();
            if (!selection)
                return uris;
            let dndType = Meta.SelectionType.DND;
            let mime = this._pickXdndMime(selection, dndType);
            if (!mime)
                return uris;

            let out = Gio.MemoryOutputStream.new_resizable();
            let loop = GLib.MainLoop.new(null, false);
            selection.transfer_async(dndType, mime, -1, out, null, () => {
                try {
                    selection.transfer_finish(null);
                    let bytes = out.steal_as_bytes();
                    let text = String(bytes.get_data());
                    uris = this._parseDropText(text, mime);
                } catch (e) {
                    global.logError(e);
                }
                loop.quit();
            });
            loop.run();
        } catch (e) {
            global.logError(e);
        }
        return uris;
    }

    _itemFromUri(uri) {
        if (!uri)
            return null;
        try {
            let file = Gio.File.new_for_uri(uri);
            let path = file.get_path();
            if (path && path.endsWith('.desktop')) {
                let desktopInfo = Gio.DesktopAppInfo.new_from_filename(path);
                if (desktopInfo) {
                    let appId = desktopInfo.get_id ? desktopInfo.get_id() : GLib.path_get_basename(path);
                    let app = this.appSystem.lookup_app(appId);
                    if (app)
                        return { type: 'app', id: app.get_id() };
                }
            }
        } catch (e) {
            global.logError(e);
        }
        return { type: 'uri', id: uri };
    }

    _addDroppedItem(item) {
        if (!item || this.savedItems.some(i => i.id === item.id))
            return false;
        this.savedItems.push(item);
        this._saveData();
        this._refreshGrid();
        return true;
    }

    _extractItemFromSource(source) {
        if (!source)
            return null;

        if (source.app && typeof source.app.get_id === 'function')
            return { type: 'app', id: source.app.get_id() };
        if (typeof source.get_app_id === 'function')
            return { type: 'app', id: source.get_app_id() };
        if (source.uri)
            return this._itemFromUri(source.uri);
        if (source.uris && source.uris.length > 0)
            return this._itemFromUri(source.uris[0]);
        if (source.file && typeof source.file.get_uri === 'function')
            return this._itemFromUri(source.file.get_uri());
        if (typeof source.get_uri === 'function')
            return this._itemFromUri(source.get_uri());
        if (source.id && typeof source.id === 'string' && source.id.indexOf('.') >= 0)
            return { type: 'app', id: source.id };

        return null;
    }

    _handleXdndDrop() {
        if (!this._xdndDropPending)
            return;
        this._xdndDropPending = false;

        if (!this._pointerOverDesklet())
            return;

        let uris = this._readXdndUris();
        for (let i = 0; i < uris.length; i++) {
            let item = this._itemFromUri(uris[i]);
            this._addDroppedItem(item);
        }
    }

    handleDragOver(source, actor, x, y, time) {
        if (source === Main.xdndHandler) {
            this._xdndHovering = this._localPointOnFrame(x, y);
            this._xdndDropPending = this._xdndHovering;
            return this._xdndHovering
                ? DND.DragMotionResult.COPY_DROP
                : DND.DragMotionResult.CONTINUE;
        }
        return DND.DragMotionResult.COPY_DROP;
    }

    acceptDrop(source, actor, x, y, time) {
        if (source === Main.xdndHandler) {
            this._xdndDropPending = this._localPointOnFrame(x, y);
            this._handleXdndDrop();
            return true;
        }

        let item = this._extractItemFromSource(source);
        if (item)
            return this._addDroppedItem(item);
        return false;
    }

    _startRename() {
        this.titleLabel.hide();
        this.titleEntry.text = this.deskletLabel;
        this.titleEntry.show();
        this.titleEntry.clutter_text.grab_key_focus();
        Main.pushModal(this.titleEntry);
    }

    _finishRename(save) {
        Main.popModal(this.titleEntry);
        this.titleEntry.hide();
        this.titleLabel.show();
        if (save) {
            let t = this.titleEntry.text.trim();
            if (t)
                this.deskletLabel = t;
            this.titleLabel.text = this.deskletLabel;
            this.setHeader(this.deskletLabel);
            this._saveData();
        }
    }

    _storageKey() {
        return 'v2:' + this.instance_id;
    }

    _loadData() {
        this.savedItems = [];
        this.deskletLabel = 'Mes raccourcis';
        this.displayMode = DISPLAY_GRID;
        this.columns = MIN_COLS;
        this.rows = MIN_ROWS;
        try {
            let file = Gio.File.new_for_path(STORAGE_PATH);
            if (!file.query_exists(null))
                return;
            let [ok, content] = file.load_contents(null);
            if (!ok)
                return;
            let json = JSON.parse(String(content));
            let data = json[this._storageKey()] || json[this.instance_id];
            if (!data)
                return;
            this.savedItems = data.items || [];
            this.deskletLabel = data.label || this.deskletLabel;
            if (data.columns)
                this.columns = data.columns;
            if (data.rows)
                this.rows = data.rows;
            if (data.displayMode === DISPLAY_LIST || data.displayMode === DISPLAY_GRID)
                this.displayMode = data.displayMode;
        } catch (e) {
            global.logError(e);
        }
        this.columns = Math.max(MIN_COLS, Math.min(MAX_COLS, this.columns));
        this.rows = Math.max(MIN_ROWS, Math.min(MAX_ROWS, this.rows));
    }

    _saveData() {
        try {
            let file = Gio.File.new_for_path(STORAGE_PATH);
            let currentData = {};
            if (file.query_exists(null)) {
                let [ok, content] = file.load_contents(null);
                if (ok)
                    currentData = JSON.parse(String(content));
            }
            currentData[this._storageKey()] = {
                label: this.deskletLabel,
                items: this.savedItems,
                columns: this.columns,
                rows: this.rows,
                displayMode: this.displayMode
            };
            file.replace_contents(JSON.stringify(currentData), null, false,
                Gio.FileCreateFlags.NONE, null);
        } catch (e) {
            global.logError(e);
        }
    }

    on_desklet_removed_from_desktop() {
        if (this._isResizing)
            this._endResize();
        this._teardownDesktopDrop();
        this._itemMenus.forEach(m => m.destroy());
        super.on_desklet_removed_from_desktop();
    }
}

function main(metadata, instance_id) {
    return new GridLauncherV2Desklet(metadata, instance_id);
}