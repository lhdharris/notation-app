#!/usr/bin/env python3
"""Generate res/banner.png (1280x320) in the projector-app banner style:
dark slate background, the rounded-square Notation icon on the left, a big
Varela Round wordmark + grey subtitle + small blue feature bullets, and a thin
pastel rainbow strip (the app's sticky-note palette) along the bottom edge.

Varela Round ships next to this script (VarelaRound-Regular.ttf, not installed
system-wide), so we point fontconfig at this directory via FONTCONFIG_FILE
before Rsvg/Pango initialise. Rendered with librsvg + cairo (ImageMagick's SVG
delegate is unavailable here).
"""
import os
import tempfile

RES = os.path.dirname(os.path.abspath(__file__))

# fontconfig must know about this dir before gi loads Pango.
conf = os.path.join(tempfile.mkdtemp(prefix='notation-banner-fc'), 'fonts.conf')
with open(conf, 'w') as f:
    f.write(f"""<?xml version="1.0"?>
<!DOCTYPE fontconfig SYSTEM "fonts.dtd">
<fontconfig>
  <dir>{RES}</dir>
  <dir>/usr/share/fonts</dir>
  <cachedir>{os.path.dirname(conf)}/cache</cachedir>
</fontconfig>
""")
os.environ['FONTCONFIG_FILE'] = conf

import gi  # noqa: E402
gi.require_version('Rsvg', '2.0')
from gi.repository import Rsvg  # noqa: E402
import cairo  # noqa: E402

W, H = 1280, 320

# The sticky-note pastel palette (renderer/palette.js PRESETS), hue-ordered.
PASTELS = [
    '#ffb3a3', '#faceb7', '#ffd39e', '#ffe59e', '#ffffb8',
    '#d8f59e', '#ccfcc0', '#bbe7c8', '#a9efd8', '#b6f1ed',
    '#adf1ff', '#add6ff', '#91a8f3', '#bbb8ff', '#b39df1',
    '#dcc2ff', '#ddacf6', '#f2bef9', '#ffc2f3', '#ffb8db',
]
STRIP_H = 10
seg = W / len(PASTELS)
strip = ''.join(
    f'<rect x="{i * seg:.1f}" y="{H - STRIP_H}" width="{seg + 1:.1f}" height="{STRIP_H}" fill="{c}"/>'
    for i, c in enumerate(PASTELS)
)

# The app icon, inlined straight from the source SVG (its ids are ni-prefixed
# so they can't clash with the banner's), scaled into a tile on the left. The
# tile's dark background nearly matches the banner's, so the fanned notes read
# as floating; a hairline stroke keeps the rounded square legible.
import re  # noqa: E402

ICON_SVG = os.path.join(RES, '..', 'electron-app', 'renderer', 'notation-icon.svg')
with open(ICON_SVG) as f:
    icon_body = re.sub(r'^.*?<svg[^>]*>|</svg>\s*$', '', f.read(), flags=re.S)

ICON_X, ICON_Y, ICON_S = 56, 64, 182
icon = f"""
<g transform="translate({ICON_X},{ICON_Y}) scale({ICON_S / 1024})">
  {icon_body}
  <rect width="1024" height="1024" rx="200" ry="200" fill="none" stroke="#3d414d" stroke-width="8"/>
</g>"""

TX = ICON_X + ICON_S + 42  # text column, left-aligned beside the icon
svg = f"""<svg xmlns="http://www.w3.org/2000/svg" width="{W}" height="{H}" viewBox="0 0 {W} {H}">
  <rect width="{W}" height="{H}" fill="#23252d"/>
  {icon}
  {strip}
  <g font-family="Varela Round">
    <text x="{TX}" y="138" font-size="68" fill="#ffffff">Notation</text>
    <text x="{TX + 2}" y="186" font-size="27" fill="#b9bdc7">Minimalist Markdown notes &amp; desktop sticky notes</text>
    <text x="{TX + 2}" y="232" font-size="20" fill="#5b9dd9">No cloud&#160;&#160;&#160;&#183;&#160;&#160;&#160;No account&#160;&#160;&#160;&#183;&#160;&#160;&#160;Just text files</text>
  </g>
</svg>"""

handle = Rsvg.Handle.new_from_data(svg.encode())
surface = cairo.ImageSurface(cairo.FORMAT_ARGB32, W, H)
ctx = cairo.Context(surface)
viewport = Rsvg.Rectangle()
viewport.x, viewport.y, viewport.width, viewport.height = 0, 0, W, H
handle.render_document(ctx, viewport)
out = os.path.join(RES, 'banner.png')
surface.write_to_png(out)
print('wrote', out)
