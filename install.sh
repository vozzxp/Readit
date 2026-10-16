#!/usr/bin/env bash
set -euo pipefail

APP_ID="org.Readit.Readit"
SRC_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
INSTALL_DIR="$HOME/.local/share/readit-app"
BIN_DIR="$HOME/.local/bin"
APPS_DIR="$HOME/.local/share/applications"
ICON_DIR="$HOME/.local/share/icons/hicolor/scalable/apps"

echo "==> Installing Readit to $INSTALL_DIR..."
mkdir -p "$INSTALL_DIR/assets" "$BIN_DIR" "$APPS_DIR" "$ICON_DIR"

cp "$SRC_DIR/main.py" "$SRC_DIR/parser.py" "$INSTALL_DIR/"
cp -r "$SRC_DIR/assets/"* "$INSTALL_DIR/assets/"

if [ -f "$SRC_DIR/assets/logo.svg" ]; then
    cp "$SRC_DIR/assets/logo.svg" "$ICON_DIR/${APP_ID}.svg"
fi

cat > "$BIN_DIR/readit" <<EOF
#!/usr/bin/env bash
exec python3 "$INSTALL_DIR/main.py" "\$@"
EOF
chmod +x "$BIN_DIR/readit"

sed "s|Exec=readit %f|Exec=$BIN_DIR/readit %f|g" \
    "$SRC_DIR/packaging/${APP_ID}.desktop" > "$APPS_DIR/${APP_ID}.desktop"

update-desktop-database "$APPS_DIR" 2>/dev/null || true
gtk-update-icon-cache -f -t "$HOME/.local/share/icons/hicolor" 2>/dev/null || true

echo "==> Readit installed! Launch it from your GNOME app grid or run: readit"