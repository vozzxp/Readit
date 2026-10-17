# Maintainer: voz Readit
pkgname=readit
pkgver=1.0.2
pkgrel=1
pkgdesc="Distraction-free reflowable PDF book reader for GNOME Wayland"
arch=('any')
url="https://github.com/vozzxp/Readit"
license=('MIT')
depends=('python' 'python-gobject' 'gtk4' 'libadwaita' 'webkitgtk-6.0' 'python-pymupdf')
optdepends=(
  'ttf-ibm-plex: IBM Plex Serif editorial reading font'
  'inter-font: Inter UI and reading font'
  'ttf-jetbrains-mono: Technical monospace font'
)
source=()
sha256sums=()

package() {
  install -d "$pkgdir/usr/lib/readit/assets"
  install -d "$pkgdir/usr/bin"

  install -m644 "$startdir/main.py" "$pkgdir/usr/lib/readit/main.py"
  install -m644 "$startdir/parser.py" "$pkgdir/usr/lib/readit/parser.py"
  install -m644 "$startdir/dictionary.py" "$pkgdir/usr/lib/readit/dictionary.py"
  install -m644 "$startdir/dictionary.sqlite" "$pkgdir/usr/lib/readit/dictionary.sqlite"
  install -m644 "$startdir/assets/reader.html" "$pkgdir/usr/lib/readit/assets/reader.html"
  install -m644 "$startdir/assets/reader.css" "$pkgdir/usr/lib/readit/assets/reader.css"
  install -m644 "$startdir/assets/reader.js" "$pkgdir/usr/lib/readit/assets/reader.js"
  install -m644 "$startdir/assets/logo-header.svg" "$pkgdir/usr/lib/readit/assets/logo-header.svg"

  if [ -f "$startdir/assets/logo.svg" ]; then
    install -m644 "$startdir/assets/logo.svg" "$pkgdir/usr/lib/readit/assets/logo.svg"
    install -Dm644 "$startdir/assets/logo.svg" \
      "$pkgdir/usr/share/icons/hicolor/scalable/apps/org.voz.Readit.svg"
  fi

  install -Dm644 "$startdir/packaging/org.voz.Readit.desktop" \
    "$pkgdir/usr/share/applications/org.voz.Readit.desktop"

  cat > "$pkgdir/usr/bin/readit" << 'EOF'
#!/usr/bin/env bash
exec python3 /usr/lib/readit/main.py "$@"
EOF
  chmod 755 "$pkgdir/usr/bin/readit"
}