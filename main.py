import sys
import json
import shutil
import threading
import webbrowser
import urllib.parse
import urllib.request
from pathlib import Path

import gi
gi.require_version("Gtk", "4.0")
gi.require_version("Adw", "1")
gi.require_version("WebKit", "6.0")
gi.require_version("GdkPixbuf", "2.0")
from gi.repository import Gtk, Adw, WebKit, Gio, GLib, Gdk, GdkPixbuf

import parser
import dictionary

APP_ID = "org.voz.Readit"
APP_DIR = Path(__file__).resolve().parent
ASSETS_DIR = APP_DIR / "assets"
READER_HTML = ASSETS_DIR / "reader.html"
LOGO_SVG = ASSETS_DIR / "logo.svg"
HEADER_LOGO_SVG = ASSETS_DIR / "logo-header.svg"

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

LIBRARY_CSS = """
.book-card {
    border-radius: 12px;
    padding: 8px;
    transition: transform 140ms ease, box-shadow 140ms ease;
}
.book-add-card {
    min-width: 140px;
    min-height: 256px;
    padding: 0;
    border: 1px dotted rgba(255, 255, 255, 0.32);
    border-radius: 12px;
    background: transparent;
    color: rgba(255, 255, 255, 0.68);
    transition: background 140ms ease, border-color 140ms ease, color 140ms ease;
}
.book-add-card:hover {
    border-color: #62a0ea;
    background: rgba(98, 160, 234, 0.08);
    color: #62a0ea;
}
.book-card button.flat,
.book-cover-frame {
    background: transparent;
    border: none;
    box-shadow: none;
}
.book-cover-frame {
    border-radius: 7px;
    overflow: hidden;
}
.book-title-label {
    font-size: 12px;
    font-weight: 600;
    line-height: 1.25;
}
.book-meta-label {
    font-size: 11px;
    opacity: 0.65;
}
.book-progress-bar trough {
    min-height: 4px;
    border-radius: 99px;
}
.book-progress-bar progress {
    min-height: 4px;
    border-radius: 99px;
}
"""


def install_user_app_icon():
    """Ensure logo.svg is registered in ~/.local/share/icons/hicolor so GNOME & GTK4
    use it for the top-left window icon and dock instead of the generic gear icon."""
    if not LOGO_SVG.exists():
        return
    try:
        icon_dir = Path.home() / ".local" / "share" / "icons" / "hicolor" / "scalable" / "apps"
        icon_dir.mkdir(parents=True, exist_ok=True)
        dest = icon_dir / f"{APP_ID}.svg"
        if not dest.exists() or dest.stat().st_mtime < LOGO_SVG.stat().st_mtime:
            shutil.copy2(LOGO_SVG, dest)
    except Exception:
        pass


class ReaditWindow(Adw.ApplicationWindow):
    def __init__(self, app):
        super().__init__(application=app, title="Readit")
        self.set_default_size(1060, 760)
        self.active_book_id = None
        self.webview_ready = False
        self.pending_book_payload = None
        self.lock_deadline = None  # monotonic µs; None = not locked
        self._lock_tick_id = None

        self._apply_custom_css()
        self._setup_app_icon()

        self.root_stack = Gtk.Stack()
        self.root_stack.set_transition_type(Gtk.StackTransitionType.CROSSFADE)
        self.root_stack.set_transition_duration(150)
        self.set_content(self.root_stack)

        self._build_library_page()
        self._build_reader_page()
        self._setup_shortcuts()

        self.connect("notify::fullscreened", self._on_window_state_changed)
        self.connect("notify::maximized", self._on_window_state_changed)
        self.connect("close-request", self._on_close_request)

        self.refresh_library()

    def _apply_custom_css(self):
        provider = Gtk.CssProvider()
        provider.load_from_string(LIBRARY_CSS)
        Gtk.StyleContext.add_provider_for_display(
            Gdk.Display.get_default(),
            provider,
            Gtk.STYLE_PROVIDER_PRIORITY_APPLICATION,
        )

    def _setup_app_icon(self):
        install_user_app_icon()
        display = Gdk.Display.get_default()
        if display:
            icon_theme = Gtk.IconTheme.get_for_display(display)
            user_icons = Path.home() / ".local" / "share" / "icons"
            if user_icons.exists():
                icon_theme.add_search_path(str(user_icons))
            if ASSETS_DIR.exists():
                icon_theme.add_search_path(str(ASSETS_DIR))
        self.set_icon_name(APP_ID)

    # ------------------------------------------------------------------
    # SHORTCUTS & WINDOW STATES
    # ------------------------------------------------------------------
    def _setup_shortcuts(self):
        key_ctrl = Gtk.EventControllerKey()
        key_ctrl.set_propagation_phase(Gtk.PropagationPhase.CAPTURE)
        key_ctrl.connect("key-pressed", self._on_key_pressed)
        self.add_controller(key_ctrl)

    def _on_key_pressed(self, controller, keyval, keycode, state):
        if keyval == Gdk.KEY_F11:
            self.toggle_fullscreen()
            return True
        return False

    # ------------------------------------------------------------------
    # LOCK IN  (no close / back / leaving fullscreen until time is up)
    # ------------------------------------------------------------------
    def _is_locked(self) -> bool:
        return (
            self.lock_deadline is not None
            and GLib.get_monotonic_time() < self.lock_deadline
        )

    def _start_lock(self, seconds: int):
        seconds = max(1, min(int(seconds), 240 * 60))
        self.lock_deadline = GLib.get_monotonic_time() + seconds * 1_000_000
        if not self.is_fullscreen():
            self.fullscreen()
        self.present()

        # Ask the compositor to hand us Alt+Tab, Super, etc. instead of
        # acting on them. GNOME shows a one-time "allow" prompt for this.
        surface = self.get_surface()
        if surface is not None and hasattr(surface, "inhibit_system_shortcuts"):
            surface.inhibit_system_shortcuts(None)

        # Once a second: end the lock on time, and pull the window back
        # to the front if something still managed to switch away.
        if self._lock_tick_id:
            GLib.source_remove(self._lock_tick_id)
        self._lock_tick_id = GLib.timeout_add(500, self._lock_tick)

    def _lock_tick(self):
        if not self._is_locked():
            self._end_lock()
            return False
        if not self.is_active() or not self.is_fullscreen():
            if not self.is_fullscreen():
                self.fullscreen()
            self.present()
        return True

    def _end_lock(self):
        self.lock_deadline = None
        self._lock_tick_id = None
        surface = self.get_surface()
        if surface is not None and hasattr(surface, "restore_system_shortcuts"):
            surface.restore_system_shortcuts()

    def _on_close_request(self, _win):
        # Returning True cancels the close (Alt+F4, window manager, etc.)
        return self._is_locked()

    def toggle_fullscreen(self):
        if self._is_locked():
            return
        if self.is_fullscreen():
            self.unfullscreen()
        else:
            self.fullscreen()

    def toggle_maximize(self):
        if self._is_locked():
            return
        if self.is_fullscreen():
            self.unfullscreen()
        if self.is_maximized():
            self.unmaximize()
        else:
            self.maximize()

    def _on_window_state_changed(self, *_args):
        if self.webview_ready:
            fs = "true" if self.is_fullscreen() else "false"
            mx = "true" if self.is_maximized() else "false"
            self.webview.evaluate_javascript(
                f"window.ReaditEngine && window.ReaditEngine.setWindowState({{fullscreen: {fs}, maximized: {mx}}});",
                -1, None, None, None, None,
            )

    # ------------------------------------------------------------------
    # LIBRARY VIEW (CLEAN HEADERBAR & COMPACT SHELF)
    # ------------------------------------------------------------------
    def _build_library_page(self):
        toolbar_view = Adw.ToolbarView()

        header = Adw.HeaderBar()
        header.set_show_start_title_buttons(False)
        header.set_show_title(False)

        brand = Gtk.Box(orientation=Gtk.Orientation.HORIZONTAL, spacing=5)
        logo = Gtk.Image.new_from_file(str(HEADER_LOGO_SVG))
        logo.set_pixel_size(32)
        title_widget = Gtk.Label(label="Readit")
        title_widget.add_css_class("title-4")
        title_widget.set_margin_start(0)
        title_widget.set_margin_end(0)
        brand.append(logo)
        brand.append(title_widget)
        header.pack_start(brand)

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

        # Compact Books Shelf
        scroll = Gtk.ScrolledWindow()
        scroll.set_policy(Gtk.PolicyType.NEVER, Gtk.PolicyType.AUTOMATIC)

        clamp = Adw.Clamp(maximum_size=1040, tightening_threshold=680)
        clamp.set_margin_top(24)
        clamp.set_margin_bottom(32)
        clamp.set_margin_start(24)
        clamp.set_margin_end(24)

        self.flowbox = Gtk.FlowBox()
        self.flowbox.set_valign(Gtk.Align.START)
        self.flowbox.set_halign(Gtk.Align.START)
        self.flowbox.set_max_children_per_line(7)
        self.flowbox.set_min_children_per_line(2)
        self.flowbox.set_column_spacing(16)
        self.flowbox.set_row_spacing(18)
        self.flowbox.set_homogeneous(False)
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

        self.flowbox.append(self._create_add_book_card())
        self.lib_stack.set_visible_child_name("grid")

    def _create_add_book_card(self) -> Gtk.Widget:
        button = Gtk.Button()
        button.add_css_class("book-add-card")
        button.set_size_request(140, 256)
        button.set_tooltip_text("Add a book")
        button.connect("clicked", self._on_add_book_clicked)

        plus_icon = Gtk.Image.new_from_icon_name("list-add-symbolic")
        plus_icon.set_pixel_size(32)
        button.set_child(plus_icon)
        return button

    def _create_book_card(self, book: dict) -> Gtk.Widget:
        card_box = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=6)
        card_box.add_css_class("book-card")
        card_box.set_size_request(140, -1)
        card_box.set_hexpand(False)
        card_box.set_vexpand(False)
        card_box.set_halign(Gtk.Align.START)
        card_box.set_valign(Gtk.Align.START)

        cover_btn = Gtk.Button()
        cover_btn.add_css_class("flat")
        cover_btn.connect("clicked", lambda _b, bid=book["id"]: self.open_book(bid))

        inner = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=6)
        inner.set_margin_top(2)
        inner.set_margin_bottom(2)
        inner.set_margin_start(2)
        inner.set_margin_end(2)

        cover_frame = Gtk.Frame()
        cover_frame.add_css_class("book-cover-frame")
        cover_frame.set_size_request(124, 168)
        cover_frame.set_halign(Gtk.Align.CENTER)
        cover_frame.set_valign(Gtk.Align.START)

        cover_path = book.get("cover_path", "")
        if cover_path and Path(cover_path).exists():
            try:
                # Scale pixbuf to exact thumbnail dimensions so Gtk.Picture never expands the card
                pixbuf = GdkPixbuf.Pixbuf.new_from_file_at_scale(cover_path, 124, 168, False)
                texture = Gdk.Texture.new_for_pixbuf(pixbuf)
                pic = Gtk.Picture.new_for_paintable(texture)
                pic.set_can_shrink(False)
                cover_frame.set_child(pic)
            except Exception:
                fallback_icon = Gtk.Image.new_from_icon_name("x-office-document-symbolic")
                fallback_icon.set_pixel_size(40)
                cover_frame.set_child(fallback_icon)
        else:
            fallback_icon = Gtk.Image.new_from_icon_name("x-office-document-symbolic")
            fallback_icon.set_pixel_size(40)
            cover_frame.set_child(fallback_icon)

        title_lbl = Gtk.Label(label=book.get("title", "Untitled"))
        title_lbl.set_wrap(True)
        title_lbl.set_lines(2)
        title_lbl.set_width_chars(14)
        title_lbl.set_max_width_chars(14)
        title_lbl.set_ellipsize(3)  # PANGO_ELLIPSIZE_END
        title_lbl.set_justify(Gtk.Justification.CENTER)
        title_lbl.add_css_class("book-title-label")

        inner.append(cover_frame)
        inner.append(title_lbl)
        cover_btn.set_child(inner)
        card_box.append(cover_btn)

        pct = float(book.get("progress_pct", 0.0))
        pbar = Gtk.ProgressBar()
        pbar.add_css_class("book-progress-bar")
        pbar.set_fraction(max(0.0, min(1.0, pct / 100.0)))
        pbar.set_margin_start(6)
        pbar.set_margin_end(6)
        card_box.append(pbar)

        footer = Gtk.Box(orientation=Gtk.Orientation.HORIZONTAL, spacing=4)
        footer.set_margin_start(6)
        footer.set_margin_end(2)

        prog_lbl = Gtk.Label(label=f"{pct:.0f}%" if pct > 0 else "New")
        prog_lbl.add_css_class("book-meta-label")
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
        self.import_and_open_pdf(filepath)

    def import_and_open_pdf(self, filepath: str):
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
            "maximized": self.is_maximized(),
        }

        self.root_stack.set_visible_child_name("reader")

        if self.webview_ready:
            self._dispatch_to_reader(payload)
        else:
            self.pending_book_payload = payload
        return False

    def _dispatch_to_reader(self, payload: dict):
        json_str = (
            json.dumps(payload, ensure_ascii=False)
            .replace("\u2028", "\\u2028")
            .replace("\u2029", "\\u2029")
        )
        js_call = f"window.ReaditEngine && window.ReaditEngine.loadBook({json_str});"
        self.webview.evaluate_javascript(js_call, -1, None, None, None, None)

    def _push_settings_to_reader(self, settings: dict):
        if self.webview_ready:
            json_str = json.dumps(settings, ensure_ascii=False)
            js_call = f"window.ReaditEngine && window.ReaditEngine.applySettings({json_str});"
            self.webview.evaluate_javascript(js_call, -1, None, None, None, None)

    # ------------------------------------------------------------------
    # IN-APP DICTIONARY + FREE AI + GOOGLE AI SEARCH
    # ------------------------------------------------------------------
    def _handle_lookup_selection(self, req_id: int, text: str, context: str, mode: str):
        def worker():
            clean_text = text.strip()
            words = clean_text.split()
            result = {
                "req_id": req_id,
                "mode": mode,
                "title": clean_text[:60],
                "phonetic": "",
                "badge": "",
                "body": "",
                "example": "",
                "error": False,
            }

            headers = {"User-Agent": "ReaditLinuxReader/1.0"}

            if mode == "dict" or (mode == "auto" and len(words) == 1 and len(clean_text) <= 32):
                word_clean = clean_text.strip(".,!?;:\"'()[]{}").lower()
                try:
                    local_entry = dictionary.lookup(word_clean)
                except Exception:
                    local_entry = None
                if local_entry:
                    result.update(dictionary.format_for_card(local_entry, word_clean))
                    result["mode"] = "dict"
                    GLib.idle_add(self._send_lookup_result, result)
                    return

                dict_url = f"https://api.dictionaryapi.dev/api/v2/entries/en/{urllib.parse.quote(word_clean)}"
                try:
                    req = urllib.request.Request(dict_url, headers=headers)
                    with urllib.request.urlopen(req, timeout=5) as resp:
                        data = json.loads(resp.read().decode("utf-8"))
                        if isinstance(data, list) and data:
                            entry = data[0]
                            result["title"] = entry.get("word", word_clean)
                            result["phonetic"] = entry.get("phonetic") or ""
                            meanings = entry.get("meanings") or []
                            if meanings:
                                m0 = meanings[0]
                                result["badge"] = m0.get("partOfSpeech", "word")
                                defs = m0.get("definitions") or []
                                lines = []
                                for idx, d in enumerate(defs[:2], 1):
                                    lines.append(f"{idx}. {d.get('definition', '')}")
                                    if not result["example"] and d.get("example"):
                                        result["example"] = f"“{d.get('example')}”"
                                result["body"] = "\n".join(lines)
                                result["mode"] = "dict"
                                GLib.idle_add(self._send_lookup_result, result)
                                return
                except Exception:
                    pass

            try:
                prompt = (
                    f"Explain the meaning of \"{clean_text}\" clearly and concisely in 2 to 3 sentences. "
                    f"Context from the book: \"{context[:360]}\". "
                    f"Reply with only the direct explanation, no markdown headers or intro fluff."
                )
                ai_url = f"https://text.pollinations.ai/{urllib.parse.quote(prompt)}?model=openai"
                req = urllib.request.Request(ai_url, headers=headers)
                with urllib.request.urlopen(req, timeout=9) as resp:
                    ai_text = resp.read().decode("utf-8").strip()
                    if ai_text:
                        result["mode"] = "ai"
                        result["badge"] = "AI Context Explanation"
                        result["body"] = ai_text
                        GLib.idle_add(self._send_lookup_result, result)
                        return
            except Exception:
                pass

            result["error"] = True
            result["badge"] = "Offline / Unavailable"
            result["body"] = "Could not reach the online dictionary or AI service. Click 'Google AI' below to open in your browser."
            GLib.idle_add(self._send_lookup_result, result)

        threading.Thread(target=worker, daemon=True).start()

    def _send_lookup_result(self, result: dict):
        if self.webview_ready:
            json_str = json.dumps(result, ensure_ascii=False)
            self.webview.evaluate_javascript(
                f"window.ReaditEngine && window.ReaditEngine.onLookupResult({json_str});",
                -1, None, None, None, None,
            )
        return False

    def _open_google_ai_query(self, text: str, context: str):
        clean = text.strip()
        if len(clean.split()) <= 2:
            query = f'define "{clean}" meaning and usage'
        else:
            query = f'Explain the meaning of "{clean}"'
        url = f"https://www.google.com/search?q={urllib.parse.quote(query)}"
        try:
            Gio.AppInfo.launch_default_for_uri(url, None)
        except Exception:
            webbrowser.open(url)

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
        elif action == "start_lock":
            self._start_lock(msg.get("seconds", 300))
        elif action == "close_book":
            self._save_progress_from_msg(msg)
            self.close_book_to_library()
        elif action == "toggle_fullscreen":
            self.toggle_fullscreen()
        elif action == "toggle_maximize":
            self.toggle_maximize()
        elif action == "lookup_selection":
            self._handle_lookup_selection(
                int(msg.get("req_id", 1)),
                str(msg.get("text", "")),
                str(msg.get("context", "")),
                str(msg.get("mode", "auto")),
            )
        elif action == "open_google_ai":
            self._open_google_ai_query(
                str(msg.get("text", "")),
                str(msg.get("context", "")),
            )
        elif action == "close_app":
            self._save_progress_from_msg(msg)
            if not self._is_locked():
                self.close()

    def close_book_to_library(self):
        if self._is_locked():
            return
        if self.is_fullscreen():
            self.unfullscreen()
        self.active_book_id = None
        self.refresh_library()
        self.root_stack.set_visible_child_name("library")

    # ------------------------------------------------------------------
    # GLOBAL SETTINGS DIALOG
    # ------------------------------------------------------------------
    def _on_open_settings(self, _btn):
        settings = parser.load_settings()

        win = Adw.PreferencesWindow(transient_for=self, modal=True, title="Reading Preferences")
        win.set_default_size(520, 640)

        page = Adw.PreferencesPage()
        win.add(page)

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
            application_id=APP_ID,
            flags=Gio.ApplicationFlags.HANDLES_OPEN,
        )

    def do_startup(self):
        Adw.Application.do_startup(self)
        install_user_app_icon()
        style_manager = Adw.StyleManager.get_default()
        style_manager.set_color_scheme(Adw.ColorScheme.PREFER_DARK)
        Gtk.Window.set_default_icon_name(APP_ID)

    def do_activate(self):
        win = self.props.active_window
        if not win:
            win = ReaditWindow(self)
        win.present()

    def do_open(self, files, _n_files, _hint):
        self.do_activate()
        win = self.props.active_window
        if win and files:
            filepath = files[0].get_path()
            if filepath and filepath.lower().endswith(".pdf"):
                win.import_and_open_pdf(filepath)


if __name__ == "__main__":
    app = ReaditApp()
    sys.exit(app.run(sys.argv))