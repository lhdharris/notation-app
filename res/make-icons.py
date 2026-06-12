#!/usr/bin/env python3
"""Render electron-app/renderer/notation-icon.svg (the single source of truth
for the app icon) into every PNG the build consumes:

  electron-app/build/icons/<N>x<N>.png   (electron-builder: Linux icon set,
                                          mac .icns from 1024, win .ico from 256)
  electron-app/assets/icon.png           (BrowserWindow window/taskbar icon)

Rendered with librsvg + cairo because ImageMagick's SVG delegate is
unavailable here. Re-run after editing the SVG; res/make-banner.py inlines the
same SVG, so regenerate the banner too.
"""
import os

import gi
gi.require_version('Rsvg', '2.0')
from gi.repository import Rsvg  # noqa: E402
import cairo  # noqa: E402

RES = os.path.dirname(os.path.abspath(__file__))
APP = os.path.join(RES, '..', 'electron-app')
SVG = os.path.join(APP, 'renderer', 'notation-icon.svg')
ICONS = os.path.join(APP, 'build', 'icons')

SIZES = [16, 24, 32, 48, 64, 128, 256, 512, 1024]

handle = Rsvg.Handle.new_from_file(SVG)

def render(size, out):
    surface = cairo.ImageSurface(cairo.FORMAT_ARGB32, size, size)
    ctx = cairo.Context(surface)
    viewport = Rsvg.Rectangle()
    viewport.x, viewport.y, viewport.width, viewport.height = 0, 0, size, size
    handle.render_document(ctx, viewport)
    surface.write_to_png(out)
    print('wrote', out)

for s in SIZES:
    render(s, os.path.join(ICONS, f'{s}x{s}.png'))
render(1024, os.path.join(APP, 'assets', 'icon.png'))
