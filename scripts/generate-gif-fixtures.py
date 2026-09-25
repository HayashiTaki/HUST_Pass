"""Generate tiny disposal/transparency cases and independent Pillow reference pixels."""
import json
from pathlib import Path
from PIL import Image, ImageDraw
root = Path(__file__).resolve().parents[1] / 'tests' / 'fixtures' / 'gif'
root.mkdir(parents=True, exist_ok=True)
palette = [255,255,255, 0,0,0, 255,0,0, 0,0,255] + [0,0,0] * 252
for disposal in [1, 2, 3]:
    frames = []
    for i in range(3):
        frame = Image.new('P', (8, 6), 0)
        frame.putpalette(palette)
        ImageDraw.Draw(frame).rectangle((i*2,1,i*2+1,3), fill=i+1)
        frames.append(frame)
    path = root / f'disposal-{disposal}.gif'
    frames[0].save(path, save_all=True, append_images=frames[1:], duration=100,
                   loop=0, transparency=0, background=0, disposal=disposal, optimize=False)
    im = Image.open(path)
    expected = []
    for i in range(im.n_frames):
        im.seek(i)
        rgba = Image.alpha_composite(Image.new('RGBA',im.size,'white'),im.convert('RGBA'))
        expected.append({'width':im.width,'height':im.height,'data':list(rgba.tobytes())})
    path.with_suffix('.json').write_text(json.dumps(expected),encoding='utf-8')
print('Generated independent disposal 1/2/3 and transparency references.')
