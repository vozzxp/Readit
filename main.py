import sys
import json
import threading
from pathlib import Path

import gi
gi.require_version("Gtk", "4.0")
gi.require_version("Adw", "1")
gi.require_version("WebKit", "6.0")
from gi.repository import Gtk, Adw, WebKit, Gio, GLib, Gdk

import parser

APP_DIR = Path(__file__).resolve().parent
READER_HTML = APP_DIR / "assets" / "reader.html"

FONT_OPTIONS = [
    ("literata", "Literata (Book Serif)"),
    ("plex-serif", "IBM Plex Serif (Editorial)"),
    ("garamond", "EB Garamond (Classic Literary)"),
    ("hyperlegible", "Atkinson Hyperlegible (Clarity Sans)"),
    ("inter", "Inter (Clean GNOME Sans)"),
    ("mono", "JetBrains Mono (Technical)"),
]

THEME_OPTIONS = [
    ("gnome-dark", "GNOME Dark (#1e1e1e)"),
    ("oled-black", "OLED Pitch Black (#0b0b0c)"),
    ("warm-sepia", "Warm Paper (#f3ecdc)"),
    ("crisp-light", "Crisp Light (#fafafa)"),
]

FAST_STRENGTH_OPTIONS = [
    (1, "Subtle"),
    (2, "Balanced"),
    (3, "Strong"),
]


class ReaditWindow(Adw.ApplicationWindow):
    def __init__(self, app):
        super().__init__(application=app, title="Readit")
        self.set_default_size(1060, 760)
        self.active_book_id = None
        self.webview_ready = False
        self.pending_book_payload = None

        # Root stack switches between Library (with headerbar) and Reader (100% chromeless)
        self.root_stack = Gtk.Stack()
        self.root_stack.set_transition_type(Gtk.StackTransitionType.CROSSFADE)
        self.root_stack.set_transition_duration(180)
        self.set_content(self.root_stack)

        self._build_library_page()
        self._build_reader_page()
        self._setup_shortcuts()

        # Keep the reader's fullscreen button in sync with the real window state
        self.connect("notify::fullscreened", self._on_fullscreen_changed)

        self.refresh_library()

    # ------------------------------------------------------------------
    # SHORTCUTS
    # ------------------------------------------------------------------
    def _setup_shortcuts(self):
        key_ctrl = Gtk.EventControllerKey()
        # Capture phase: the window sees Esc / F11 before the WebView can swallow them
        key_ctrl.set_propagation_phase(Gtk.PropagationPhase.CAPTURE)
        key_ctrl.connect("key-pressed", self._on_key_pressed)
        self.add_controller(key_ctrl)

    def _on_key_pressed(self, controller, keyval, keycode, state):
        if keyval == Gdk.KEY_Escape and self.root_stack.get_visible_child_name() == "reader":
            self.close_book_to_library()
            return True
        if keyval == Gdk.KEY_F11:
            self.toggle_fullscreen()
            return True
        return False

    def toggle_fullscreen(self):
        if self.is_fullscreen():
            self.unfullscreen()
        else:
            self.fullscreen()

    def _on_fullscreen_changed(self, *_args):
        if self.webview_ready:
            flag = "true" if self.is_fullscreen() else "false"
            self.webview.evaluate_javascript(
                f"window.ReaditEngine && window.ReaditEngine.setFullscreen({flag});",
                -1, None, None, None, None,
            )

    # ------------------------------------------------------------------
    # LIBRARY VIEW
    # ------------------------------------------------------------------
    def _build_library_page(self):
        toolbar_view = Adw.ToolbarView()

        header = Adw.HeaderBar()
        title_widget = Adw.WindowTitle(title="Readit", subtitle="Focused Book Reader")
        header.set_title_widget(title_widget)

        add_btn = Gtk.Button(label="Add Book")
        add_btn.set_icon_name("list-add-symbolic")
        add_btn.add_css_class("suggested-action")
        add_btn.connect("clicked", self._on_add_book_clicked)
        header.pack_start(add_btn)

        settings_btn = Gtk.Button(icon_name="emblem-system-symbolic")
        settings_btn.set_tooltip_text("Reading & Appearance Settings")
        settings_btn.connect("clicked", self._on_open_settings)
        header.pack_end(settings_btn)

        toolbar_view.add_top_bar(header)

        self.lib_stack = Gtk.Stack()
        toolbar_view.set_content(self.lib_stack)

        # Empty State
        empty_page = Adw.StatusPage(
            icon_name="accessories-dictionary-symbolic",
            title="Your Library is Empty",
            description="Import any PDF book to reflow text and illustrations into a distraction-free vertical stream.",
        )
        empty_btn = Gtk.Button(label="Import PDF Book")
        empty_btn.add_css_class("pill")
        empty_btn.add_css_class("suggested-action")
        empty_btn.set_halign(Gtk.Align.CENTER)
        empty_btn.connect("clicked", self._on_add_book_clicked)
        empty_page.set_child(empty_btn)
        self.lib_stack.add_named(empty_page, "empty")

        # Loading Spinner State
        loading_box = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=16)
        loading_box.set_valign(Gtk.Align.CENTER)
        loading_box.set_halign(Gtk.Align.CENTER)
        self.spinner = Gtk.Spinner(spinning=True)
        self.spinner.set_size_request(42, 42)
        self.loading_label = Gtk.Label(label="Reflowing text & extracting illustrations…")
        self.loading_label.add_css_class("title-4")
        loading_box.append(self.spinner)
        loading_box.append(self.loading_label)
        self.lib_stack.add_named(loading_box, "loading")

        # Books Grid
        scroll = Gtk.ScrolledWindow()
        scroll.set_policy(Gtk.PolicyType.NEVER, Gtk.PolicyType.AUTOMATIC)

        clamp = Adw.Clamp(maximum_size=1100, tightening_threshold=700)
        clamp.set_margin_top(28)
        clamp.set_margin_bottom(36)
        clamp.set_margin_start(24)
        clamp.set_margin_end(24)

        self.flowbox = Gtk.FlowBox()
        self.flowbox.set_valign(Gtk.Align.START)
        self.flowbox.set_max_children_per_line(5)
        self.flowbox.set_min_children_per_line(2)
        self.flowbox.set_column_spacing(22)
        self.flowbox.set_row_spacing(22)
        self.flowbox.set_homogeneous(True)
        self.flowbox.set_selection_mode(Gtk.SelectionMode.NONE)

        clamp.set_child(self.flowbox)
        scroll.set_child(clamp)
        self.lib_stack.add_named(scroll, "grid")

        self.root_stack.add_named(toolbar_view, "library")

    def refresh_library(self):
        while child := self.flowbox.get_first_child():
            self.flowbox.remove(child)

        library = parser.load_library()
        if not library:
            self.lib_stack.set_visible_child_name("empty")
            return

        for book_id, book in library.items():
            card = self._create_book_card(book)
            self.flowbox.append(card)

        self.lib_stack.set_visible_child_name("grid")

    def _create_book_card(self, book: dict) -> Gtk.Widget:
        card_box = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=10)
        card_box.add_css_class("card")
        card_box.set_size_request(190, 310)
        card_box.set_margin_top(4)
        card_box.set_margin_bottom(4)

        # Cover area + clickable button
        cover_btn = Gtk.Button()
        cover_btn.add_css_class("flat")
        cover_btn.set_hexpand(True)
        cover_btn.set_vexpand(True)
        cover_btn.connect("clicked", lambda _b, bid=book["id"]: self.open_book(bid))

        inner = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=10)
        inner.set_margin_top(12)
        inner.set_margin_bottom(8)
        inner.set_margin_start(12)
        inner.set_margin_end(12)

        cover_frame = Gtk.Frame()
        cover_frame.set_size_request(156, 210)
        cover_frame.set_halign(Gtk.Align.CENTER)

        cover_path = book.get("cover_path", "")
        if cover_path and Path(cover_path).exists():
            pic = Gtk.Picture.new_for_filename(cover_path)
            pic.set_content_fit(Gtk.ContentFit.COVER)
            cover_frame.set_child(pic)
        else:
            fallback_icon = Gtk.Image.new_from_icon_name("x-office-document-symbolic")
            fallback_icon.set_pixel_size(64)
            cover_frame.set_child(fallback_icon)

        title_lbl = Gtk.Label(label=book.get("title", "Untitled"))
        title_lbl.set_wrap(True)
        title_lbl.set_lines(2)
        title_lbl.set_ellipsize(3)  # PANGO_ELLIPSIZE_END
        title_lbl.set_justify(Gtk.Justification.CENTER)
        title_lbl.add_css_class("heading")

        inner.append(cover_frame)
        inner.append(title_lbl)
        cover_btn.set_child(inner)
        card_box.append(cover_btn)

        # Bottom progress label + delete icon row
        footer = Gtk.Box(orientation=Gtk.Orientation.HORIZONTAL, spacing=8)
        footer.set_margin_start(14)
        footer.set_margin_end(10)
        footer.set_margin_bottom(10)

        pct = float(book.get("progress_pct", 0.0))
        prog_lbl = Gtk.Label(label=f"{pct:.0f}% read" if pct > 0 else "Unread")
        prog_lbl.add_css_class("dim-label")
        prog_lbl.add_css_class("caption")
        prog_lbl.set_hexpand(True)
        prog_lbl.set_xalign(0.0)

        del_btn = Gtk.Button(icon_name="user-trash-symbolic")
        del_btn.add_css_class("flat")
        del_btn.add_css_class("circular")
        del_btn.set_tooltip_text("Remove book from library")
        del_btn.connect("clicked", self._on_delete_book, book["id"])

        footer.append(prog_lbl)
        footer.append(del_btn)
        card_box.append(footer)

        return card_box

    def _on_delete_book(self, _btn, book_id: str):
        parser.remove_book(book_id)
        self.refresh_library()

    def _on_add_book_clicked(self, _btn):
        dialog = Gtk.FileDialog(title="Select a PDF Book")
        pdf_filter = Gtk.FileFilter()
        pdf_filter.set_name("PDF Books (*.pdf)")
        pdf_filter.add_mime_type("application/pdf")
        pdf_filter.add_pattern("*.pdf")

        filters = Gio.ListStore.new(Gtk.FileFilter)
        filters.append(pdf_filter)
        dialog.set_filters(filters)
        dialog.open(self, None, self._on_file_selected)

    def _on_file_selected(self, dialog, result):
        try:
            gfile = dialog.open_finish(result)
            if not gfile:
                return
            filepath = gfile.get_path()
        except GLib.Error:
            return

        self.lib_stack.set_visible_child_name("loading")

        def worker():
            try:
                book_entry = parser.import_pdf(filepath)
                GLib.idle_add(self._on_import_complete, book_entry)
            except Exception as e:
                print("PDF Import Error:", e, file=sys.stderr)
                GLib.idle_add(self.refresh_library)

        threading.Thread(target=worker, daemon=True).start()

    def _on_import_complete(self, book_entry: dict):
        self.refresh_library()
        if book_entry and "id" in book_entry:
            self.open_book(book_entry["id"])
        return False

    # ------------------------------------------------------------------
    # READER VIEW (WebKitGTK 6.0)
    # ------------------------------------------------------------------
    def _build_reader_page(self):
        self.ucm = WebKit.UserContentManager()
        self.ucm.register_script_message_handler("readit")
        self.ucm.connect("script-message-received::readit", self._on_reader_message)

        self.webview = WebKit.WebView(user_content_manager=self.ucm)
        self.webview.set_hexpand(True)
        self.webview.set_vexpand(True)

        # Match GNOME Dark background before HTML paints so there is zero white flash
        bg = Gdk.RGBA()
        bg.parse("#1e1e1e")
        self.webview.set_background_color(bg)

        wk_settings = self.webview.get_settings()
        wk_settings.set_allow_file_access_from_file_urls(True)
        wk_settings.set_allow_universal_access_from_file_urls(True)
        wk_settings.set_enable_smooth_scrolling(True)
        wk_settings.set_enable_page_cache(False)

        self.webview.connect("load-changed", self._on_webview_load_changed)
        self.webview.load_uri(READER_HTML.as_uri())

        self.root_stack.add_named(self.webview, "reader")

    def _on_webview_load_changed(self, _webview, load_event):
        if load_event == WebKit.LoadEvent.FINISHED:
            self.webview_ready = True
            if self.pending_book_payload is not None:
                self._dispatch_to_reader(self.pending_book_payload)
                self.pending_book_payload = None

    def open_book(self, book_id: str):
        library = parser.load_library()
        book = library.get(book_id)
        if not book:
            return

        # Books imported by an older parser are rebuilt once, in the background
        if parser.needs_reparse(book):
            self.root_stack.set_visible_child_name("library")
            self.lib_stack.set_visible_child_name("loading")

            def worker():
                try:
                    parser.import_pdf(book["filepath"], force=True)
                except Exception as e:
                    print("Re-parse error:", e, file=sys.stderr)
                GLib.idle_add(self._open_book_now, book_id)

            threading.Thread(target=worker, daemon=True).start()
            return

        self._open_book_now(book_id)

    def _open_book_now(self, book_id: str):
        library = parser.load_library()
        book = library.get(book_id)
        if not book:
            self.refresh_library()
            return False

        blocks = parser.get_book_blocks(book_id)
        settings = parser.load_settings()
        self.active_book_id = book_id

        payload = {
            "book": book,
            "blocks": blocks,
            "settings": settings,
            "fullscreen": self.is_fullscreen(),
        }

        self.root_stack.set_visible_child_name("reader")

        if self.webview_ready:
            self._dispatch_to_reader(payload)
        else:
            self.pending_book_payload = payload
        return False

    def _dispatch_to_reader(self, payload: dict):
        json_str = json.dumps(payload, ensure_ascii=False)
        js_call = f"window.ReaditEngine && window.ReaditEngine.loadBook({json_str});"
        self.webview.evaluate_javascript(js_call, -1, None, None, None, None)

    def _push_settings_to_reader(self, settings: dict):
        if self.webview_ready:
            json_str = json.dumps(settings, ensure_ascii=False)
            js_call = f"window.ReaditEngine && window.ReaditEngine.applySettings({json_str});"
            self.webview.evaluate_javascript(js_call, -1, None, None, None, None)

    def _save_progress_from_msg(self, msg: dict):
        if "block_id" in msg and self.active_book_id:
            parser.update_reading_progress(
                self.active_book_id,
                msg.get("block_id", 0),
                msg.get("offset", 0.0),
                msg.get("progress_pct", 0.0),
            )

    def _on_reader_message(self, _ucm, js_value):
        try:
            msg = json.loads(js_value.to_string())
        except Exception as e:
            print("Bridge message parse error:", e, file=sys.stderr)
            return

        action = msg.get("action")
        if action == "save_progress":
            self._save_progress_from_msg(msg)
        elif action == "save_settings":
            parser.save_settings(msg.get("settings", {}))
        elif action == "close_book":
            self._save_progress_from_msg(msg)
            self.close_book_to_library()
        elif action == "toggle_fullscreen":
            self.toggle_fullscreen()
        elif action == "close_app":
            self._save_progress_from_msg(msg)
            self.close()

    def close_book_to_library(self):
        if self.is_fullscreen():
            self.unfullscreen()
        self.active_book_id = None
        self.refresh_library()
        self.root_stack.set_visible_child_name("library")

    # ------------------------------------------------------------------
    # GLOBAL SETTINGS DIALOG (FROM LIBRARY HEADER)
    # ------------------------------------------------------------------
    def _on_open_settings(self, _btn):
        settings = parser.load_settings()

        win = Adw.PreferencesWindow(transient_for=self, modal=True, title="Reading Preferences")
        win.set_default_size(520, 640)

        page = Adw.PreferencesPage()
        win.add(page)

        # Group 1: Typography & Fonts
        typo_group = Adw.PreferencesGroup(
            title="Typography",
            description="Choose a comfortable long-form reading typeface and text scale.",
        )
        page.add(typo_group)

        font_row = Adw.ComboRow(title="Reading Font")
        font_names = Gtk.StringList.new([label for _, label in FONT_OPTIONS])
        font_row.set_model(font_names)
        curr_font_idx = next(
            (i for i, (k, _) in enumerate(FONT_OPTIONS) if k == settings.get("font_family")),
            0,
        )
        font_row.set_selected(curr_font_idx)

        def on_font_changed(row, _param):
            key = FONT_OPTIONS[row.get_selected()][0]
            updated = parser.save_settings({"font_family": key})
            self._push_settings_to_reader(updated)

        font_row.connect("notify::selected", on_font_changed)
        typo_group.add(font_row)

        size_row = Adw.ActionRow(title="Default Font Size (px)")
        size_spin = Gtk.SpinButton.new_with_range(14, 32, 1)
        size_spin.set_value(settings.get("font_size", 19))
        size_spin.set_valign(Gtk.Align.CENTER)
        size_spin.connect(
            "value-changed",
            lambda sp: self._push_settings_to_reader(
                parser.save_settings({"font_size": int(sp.get_value())})
            ),
        )
        size_row.add_suffix(size_spin)
        typo_group.add(size_row)

        # Group 2: Fast reading
        fast_group = Adw.PreferencesGroup(
            title="Fast Reading",
            description="Highlights the first letters of each word and dims the rest, so your eyes glide across the line.",
        )
        page.add(fast_group)

        fast_row = Adw.ActionRow(title="Enable Fast Reading")
        fast_switch = Gtk.Switch()
        fast_switch.set_active(bool(settings.get("fast_reading", False)))
        fast_switch.set_valign(Gtk.Align.CENTER)

        def on_fast_toggled(sw, _param):
            updated = parser.save_settings({"fast_reading": sw.get_active()})
            self._push_settings_to_reader(updated)

        fast_switch.connect("notify::active", on_fast_toggled)
        fast_row.add_suffix(fast_switch)
        fast_row.set_activatable_widget(fast_switch)
        fast_group.add(fast_row)

        strength_row = Adw.ComboRow(title="Focus Strength")
        strength_row.set_model(Gtk.StringList.new([label for _, label in FAST_STRENGTH_OPTIONS]))
        curr_strength = int(settings.get("fast_strength", 2))
        strength_row.set_selected(
            next((i for i, (v, _) in enumerate(FAST_STRENGTH_OPTIONS) if v == curr_strength), 1)
        )

        def on_strength_changed(row, _param):
            value = FAST_STRENGTH_OPTIONS[row.get_selected()][0]
            updated = parser.save_settings({"fast_strength": value})
            self._push_settings_to_reader(updated)

        strength_row.connect("notify::selected", on_strength_changed)
        fast_group.add(strength_row)

        # Group 3: Theme & Illustrations
        visual_group = Adw.PreferencesGroup(
            title="Theme & Illustration Blending",
            description="Control how page surfaces and inline illustrations blend together.",
        )
        page.add(visual_group)

        theme_row = Adw.ComboRow(title="Color Theme")
        theme_names = Gtk.StringList.new([label for _, label in THEME_OPTIONS])
        theme_row.set_model(theme_names)
        curr_theme_idx = next(
            (i for i, (k, _) in enumerate(THEME_OPTIONS) if k == settings.get("theme")),
            0,
        )
        theme_row.set_selected(curr_theme_idx)

        def on_theme_changed(row, _param):
            key = THEME_OPTIONS[row.get_selected()][0]
            updated = parser.save_settings({"theme": key})
            self._push_settings_to_reader(updated)

        theme_row.connect("notify::selected", on_theme_changed)
        visual_group.add(theme_row)

        color_img_row = Adw.ActionRow(
            title="Keep Illustrations Colorful",
            subtitle="When off, illustrations are converted to monochrome and blended seamlessly into the dark or light page background.",
        )
        color_switch = Gtk.Switch()
        color_switch.set_active(bool(settings.get("colorful_images", False)))
        color_switch.set_valign(Gtk.Align.CENTER)

        def on_color_toggled(sw, _param):
            updated = parser.save_settings({"colorful_images": sw.get_active()})
            self._push_settings_to_reader(updated)

        color_switch.connect("notify::active", on_color_toggled)
        color_img_row.add_suffix(color_switch)
        visual_group.add(color_img_row)

        win.present()


class ReaditApp(Adw.Application):
    def __init__(self):
        super().__init__(
            application_id="org.Readit.Readit",
            flags=Gio.ApplicationFlags.FLAGS_NONE,
        )

    def do_startup(self):
        Adw.Application.do_startup(self)
        style_manager = Adw.StyleManager.get_default()
        style_manager.set_color_scheme(Adw.ColorScheme.PREFER_DARK)

    def do_activate(self):
        win = self.props.active_window
        if not win:
            win = ReaditWindow(self)
        win.present()


if __name__ == "__main__":
    app = ReaditApp()
    sys.exit(app.run(sys.argv))