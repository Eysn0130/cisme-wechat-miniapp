"""Check the new white selection using actual clear material sample points."""
import hashlib
import json
import re
from pathlib import Path
from xml.etree import ElementTree
from PIL import Image

ROOT = Path(__file__).resolve().parent
helper = ROOT.parent / 'qa-source/measure-glass-contrast.py'
namespace = {'__file__': str(helper)}
exec(compile(helper.read_text().split('\nresults = []')[0], str(helper), 'exec'), namespace)
measure, luminance = namespace['measure'], namespace['luminance']
app, pairs = namespace['MINIPROGRAM'], namespace['ICON_PAIRS']
ratio = lambda a, b: (max(luminance(a), luminance(b)) + .05) / (min(luminance(a), luminance(b)) + .05)
results, rims = [], []
for width in (375, 412):
    facts = json.loads((ROOT / f'review-{width}.json').read_text())
    geometry = facts['geometry']
    for scene in facts['backdrops']:
        image = Image.open(ROOT / scene['screenshot']).convert('RGB')
        sx, sy = image.width / geometry['width'], image.height / geometry['height']
        for index, item in enumerate(geometry['items']):
            center = (item['left'] + item['right']) / 2
            foreground = list(map(int, re.findall(r'\d+', item['color'])))
            asset = pairs[index][1 if index == scene['active'] else 0]
            fill = ElementTree.parse(app / asset.lstrip('/')).getroot().get('fill')
            ink = tuple(int(fill[i:i + 2], 16) for i in (1, 3, 5))
            label_rect = (int((center - 22) * sx), int((item['top'] + 36) * sy),
                          int((center + 22) * sx), int((item['top'] + 54) * sy))
            icon_rect = (int((center - 13) * sx), int((item['top'] + 8) * sy),
                         int((center + 13) * sx), int((item['top'] + 35) * sy))
            if index == scene['active']:
                assert foreground == [255, 255, 255] and ink == (255, 255, 255)
                # Fixed sample points lie outside the 25px SVG and two-character
                # label's ink bounds, inside the opaque selected lens. White
                # glyph pixels are not mistaken for their own background.
                def sample(offset, y):
                    pixels = [image.getpixel((int((center + dx) * sx), int((item['top'] + y) * sy)))
                              for dx in (-offset, offset)]
                    return {'foreground': foreground, 'materialSamples': pixels,
                            'minimumContrast': min(ratio(foreground, bg) for bg in pixels),
                            'method': 'white source ink versus fixed clear material points outside glyph bounds'}
                text, symbol = sample(21, 45), sample(16, 21)
                opaque_text = sum(max(abs(c - 255) for c in image.getpixel((x, y))) <= 12
                                  for y in range(label_rect[1], label_rect[3])
                                  for x in range(label_rect[0], label_rect[2]))
                assert opaque_text >= 10, (width, scene['name'], opaque_text)
                text['opaqueCorePixels'] = opaque_text
            else:
                text = measure(image, label_rect, foreground)
                symbol = measure(image, icon_rect, ink, require_opaque_core=False)
            assert text['minimumContrast'] >= 4.5, (width, scene['name'], index, text)
            assert symbol['minimumContrast'] >= 3, (width, scene['name'], index, symbol)
            results.append({'width': width, 'scene': scene['name'], 'item': index,
                            'selected': index == scene['active'], 'label': text,
                            'icon': {**symbol, 'asset': asset, 'sourceFill': fill}})
        lens = geometry['lens']
        border = tuple(map(int, re.findall(r'\d+', lens['borderLeftColor'])))
        y = int((lens['top'] + lens['height'] / 2) * sy)
        for side, x in [('left', lens['left'] - 3), ('right', lens['right'] + 3)]:
            material = image.getpixel((int(x * sx), y))
            contrast = ratio(border, material)
            assert contrast >= 3, (width, scene['name'], side, contrast)
            rims.append({'width': width, 'scene': scene['name'], 'side': side,
                         'borderInk': border, 'outsideMaterial': material, 'contrast': contrast})
selected = [r for r in results if r['selected']]
report = {'helperSha256': hashlib.sha256(helper.read_bytes()).hexdigest(),
          'scope': 'Current filled-selection native simulator PNGs; no old screenshots or resizing.',
          'samplingLimit': 'Selected white ink uses fixed neighboring clear material points; other ink uses the earlier 5px-neighborhood estimator. Reported minima cover these sampled positions, not every background/antialias pixel or physical-device perception.',
          'minimumLabel': min(r['label']['minimumContrast'] for r in results),
          'minimumIcon': min(r['icon']['minimumContrast'] for r in results),
          'minimumSelectedLabel': min(r['label']['minimumContrast'] for r in selected),
          'minimumSelectedIcon': min(r['icon']['minimumContrast'] for r in selected),
          'minimumRimOutside': min(r['contrast'] for r in rims), 'results': results, 'rims': rims}
(ROOT / 'contrast.json').write_text(json.dumps(report, ensure_ascii=False, indent=2) + '\n')
print(json.dumps({k: v for k, v in report.items() if k not in ('results', 'rims')}, ensure_ascii=False))
