"""Check native PNG label/icon ink against its immediate rendered backdrop.

This measures simulator raster evidence, not physical-screen or OS a11y support.
Antialias edge pixels are excluded; WCAG compares the intended foreground ink
with the actual adjacent material. Original screenshots are never rescaled.
"""
import json
import re
from pathlib import Path
from xml.etree import ElementTree
from PIL import Image

ROOT = Path(__file__).resolve().parent.parent
MINIPROGRAM = ROOT.parents[2] / 'apps' / 'miniprogram'
ICON_PAIRS = re.findall(r'icon: "([^"]+)", activeIcon: "([^"]+)"',
                        (MINIPROGRAM / 'custom-tab-bar' / 'index.ts').read_text())
assert len(ICON_PAIRS) == 4


def luminance(rgb):
    values = [x / 255 for x in rgb]
    return sum(w * (v / 12.92 if v <= .04045 else ((v + .055) / 1.055) ** 2.4)
               for w, v in zip((.2126, .7152, .0722), values))


def measure(image, rect, foreground, require_opaque_core=True):
    pixels = image.load()
    ink = []
    for y in range(rect[1], rect[3]):
        for x in range(rect[0], rect[2]):
            color = pixels[x, y][:3]
            if max(abs(a - b) for a, b in zip(color, foreground)) <= 12:
                ink.append((x, y))
    opaque_core = len(ink)
    if len(ink) < 10:
        if require_opaque_core:
            raise ValueError(f'Insufficient core ink pixels: {rect}, {foreground}, {len(ink)}')
        # Thin SVG strokes may cover fractions of every physical pixel. Use
        # the closest raster stroke only to locate its neighboring background;
        # do not call that raster pixel the opaque source color.
        candidates = [(max(abs(a - b) for a, b in zip(pixels[x, y][:3], foreground)), x, y)
                      for y in range(rect[1], rect[3]) for x in range(rect[0], rect[2])]
        nearest = min(value[0] for value in candidates)
        ink = [(x, y) for delta, x, y in candidates if delta <= nearest + 4]
    backgrounds = []
    for x, y in ink:
        # A 5px neighborhood reaches beyond the narrow icon/text stroke.
        surrounding = [luminance(pixels[nx, ny][:3])
                       for ny in range(max(rect[1], y - 5), min(rect[3], y + 6))
                       for nx in range(max(rect[0], x - 5), min(rect[2], x + 6))]
        backgrounds.append(max(surrounding))
    return {'foreground': foreground, 'opaqueCorePixels': opaque_core,
            'method': 'intended foreground against adjacent raster material',
            'rasterStrokeHasOpaqueCore': opaque_core >= 10,
            'minimumContrast': min((value + .05) / (luminance(foreground) + .05) for value in backgrounds)}


results = []
for width in (375, 412):
    facts = json.loads((ROOT / f'glass-{width}-native.json').read_text())
    geometry = facts['geometry']
    for scene in facts['backdrops']:
        image = Image.open(ROOT / scene['screenshot']).convert('RGB')
        sx, sy = image.width / geometry['width'], image.height / geometry['height']
        for index, item in enumerate(geometry['items']):
            center = (item['left'] + item['right']) / 2
            foreground = list(map(int, re.findall(r'\d+', item['color'])))
            label = (int((center - 22) * sx), int((item['top'] + 36) * sy),
                     int((center + 22) * sx), int((item['top'] + 54) * sy))
            text = measure(image, label, foreground)
            icon_asset = ICON_PAIRS[index][1 if index == scene['active'] else 0]
            icon_fill = ElementTree.parse(MINIPROGRAM / icon_asset.lstrip('/')).getroot().get('fill')
            if not re.fullmatch(r'#[0-9a-fA-F]{6}', icon_fill or ''):
                raise ValueError(f'Expected a single explicit SVG fill: {icon_asset}')
            icon_foreground = tuple(int(icon_fill[i:i + 2], 16) for i in (1, 3, 5))
            icon = (int((center - 13) * sx), int((item['top'] + 8) * sy),
                    int((center + 13) * sx), int((item['top'] + 35) * sy))
            symbol = measure(image, icon, icon_foreground, require_opaque_core=False)
            if text['minimumContrast'] < 4.5 or symbol['minimumContrast'] < 3:
                raise ValueError(f'Contrast below target: {width}/{scene["name"]}/{index}: {text}, {symbol}')
            results.append({'width': width, 'scene': scene['name'], 'item': index,
                            'label': text, 'icon': {**symbol, 'asset': icon_asset, 'sourceFill': icon_fill}})
report = {'scope': 'Native simulator PNGs, four controlled backdrops per width; actual neighboring material pixels, intended ink colors, antialias edges excluded.',
          'samplingLimit': 'For each located stroke pixel, the brightest pixel in a 5px neighborhood estimates the adjacent background. Reported minima are among these 32 sampled positions, not every background pixel or a formal whole-region worst case.',
          'iconLimit': 'Thin SVG strokes do not always contain opaque raster pixels. Icon values compare the intended source SVG fill with sampled adjacent material, not every antialiased pixel or physical-device perception.',
          'labelTarget': 4.5, 'iconTarget': 3, 'results': results,
          'minimumLabel': min(r['label']['minimumContrast'] for r in results),
          'minimumIcon': min(r['icon']['minimumContrast'] for r in results)}
(ROOT / 'glass-contrast.json').write_text(json.dumps(report, ensure_ascii=False, indent=2) + '\n')
print(json.dumps({k: v for k, v in report.items() if k != 'results'}, ensure_ascii=False))
