"""Gera o ícone (.ico/.png) do Gerenciador de Projetos no mesmo padrão dos demais apps
(iconografia TOTVS: grade 24x24, traço 1,5, quinas arredondadas; fundo em gradiente azul escuro +
cor adicional (laranja); glifo branco com destaque limão).  Desenho original - não usa o logotipo da marca.
Uso: python gerar_icone.py   ->   icone.ico, icone.png (e ../public/icone.png)
"""
import math
from pathlib import Path

from PIL import Image, ImageDraw

NAVY, CYAN, WHITE = (0, 34, 51), (0, 219, 255), (255, 255, 255)
PURPLE, GREEN, LIME, ORANGE, PINK = (164, 77, 255), (0, 255, 212), (217, 255, 101), (255, 137, 0), (255, 0, 158)

S = 1024          # tamanho de render
SS = 2            # supersampling do glifo
OUT = Path(__file__).parent


class Glyph:
    """Camada de traços com terminações/juntas arredondadas, em coordenadas da grade 24x24."""

    def __init__(self, margin, stroke_mod):
        self.size = S * SS
        self.scale = (S - 2 * margin) * SS / 24
        self.off = margin * SS
        self.w = stroke_mod * self.scale
        self.img = Image.new("L", (self.size, self.size), 0)
        self.d = ImageDraw.Draw(self.img)

    def P(self, p):
        return (self.off + p[0] * self.scale, self.off + p[1] * self.scale)

    def poly(self, pts, fill=255, draw=None):
        d = draw or self.d
        pts = [self.P(p) for p in pts]
        d.line(pts, fill=fill, width=int(self.w), joint="curve")
        r = self.w / 2
        for x, y in (pts[0], pts[-1]) if len(pts) > 1 else pts:
            d.ellipse((x - r, y - r, x + r, y + r), fill=fill)
        for x, y in pts[1:-1]:
            d.ellipse((x - r, y - r, x + r, y + r), fill=fill)

    def rpath(self, pts, r=2.0, closed=False, fill=255, draw=None):
        """Polilinha com quinas arredondadas (curva de Bézier quadrática)."""
        n = len(pts)
        out = []
        rng = range(n) if closed else range(1, n - 1)
        if not closed:
            out.append(pts[0])
        for i in rng:
            p, a, b = pts[i], pts[i - 1], pts[(i + 1) % n]
            v1, v2 = (a[0] - p[0], a[1] - p[1]), (b[0] - p[0], b[1] - p[1])
            l1, l2 = math.hypot(*v1), math.hypot(*v2)
            dd = min(r, l1 / 2, l2 / 2)
            s = (p[0] + v1[0] / l1 * dd, p[1] + v1[1] / l1 * dd)
            e = (p[0] + v2[0] / l2 * dd, p[1] + v2[1] / l2 * dd)
            for t in [k / 14 for k in range(15)]:
                out.append(((1 - t) ** 2 * s[0] + 2 * (1 - t) * t * p[0] + t * t * e[0],
                            (1 - t) ** 2 * s[1] + 2 * (1 - t) * t * p[1] + t * t * e[1]))
        if not closed:
            out.append(pts[-1])
        else:
            out.append(out[0])
        self.poly(out, fill, draw)

    def rect(self, x0, y0, x1, y1, r=2.0, **kw):
        self.rpath([(x0, y0), (x1, y0), (x1, y1), (x0, y1)], r, closed=True, **kw)

    def arc(self, cx, cy, rx, ry, a0, a1, fill=255, draw=None):
        pts = [(cx + rx * math.cos(math.radians(a)), cy + ry * math.sin(math.radians(a)))
               for a in [a0 + (a1 - a0) * k / 40 for k in range(41)]]
        self.poly(pts, fill, draw)

    def ellipse(self, cx, cy, rx, ry, **kw):
        self.arc(cx, cy, rx, ry, 0, 360, **kw)

    def knock(self, cx, cy, r):
        x, y = self.P((cx, cy))
        rr = r * self.scale
        self.d.ellipse((x - rr, y - rr, x + rr, y + rr), fill=0)


def cylinder(g, cx, top, bottom, rx, ry, bands=1):
    g.ellipse(cx, top, rx, ry)
    g.poly([(cx - rx, top), (cx - rx, bottom)])
    g.poly([(cx + rx, top), (cx + rx, bottom)])
    g.arc(cx, bottom, rx, ry, 0, 180)
    for i in range(1, bands + 1):
        y = top + (bottom - top) * i / (bands + 1)
        g.arc(cx, y, rx, ry, 0, 180)



def glyph_projetos(main, acc):
    # pasta de projeto + barras de cronograma (destaque)
    main.rpath([(2.5, 5.5), (9.3, 5.5), (11.5, 8.5), (21.5, 8.5), (21.5, 19.5), (2.5, 19.5)], 2.2, closed=True)
    acc.poly([(6.3, 13), (12.6, 13)])
    acc.poly([(6.3, 16.2), (17.4, 16.2)])


def gradient_tile(color, size=S):
    """Gradiente azul escuro (topo-esquerda) + cor adicional (base-direita), com máscara arredondada."""
    tile = Image.new("RGB", (size, size))
    px = tile.load()
    for y in range(size):
        for x in range(size):
            t = (x + y) / (2 * (size - 1))          # 0..1 na diagonal
            t = max(0.0, (t - 0.38) / 0.62)          # azul escuro domina a primeira parte
            t = t * t * (3 - 2 * t)
            px[x, y] = tuple(round(NAVY[i] + (color[i] - NAVY[i]) * t) for i in range(3))
    mask = Image.new("L", (size * 2, size * 2), 0)
    ImageDraw.Draw(mask).rounded_rectangle((0, 0, size * 2 - 1, size * 2 - 1), radius=int(size * 2 * 0.225), fill=255)
    mask = mask.resize((size, size), Image.LANCZOS)
    tile.putalpha(mask)
    return tile


def render(glyph_fn, color, margin=190, stroke=1.5):
    main, acc = Glyph(margin, stroke), Glyph(margin, stroke)
    glyph_fn(main, acc)
    tile = gradient_tile(color)
    for g, col in ((main, WHITE), (acc, LIME)):
        m = g.img.resize((S, S), Image.LANCZOS)
        layer = Image.new("RGBA", (S, S), col + (0,))
        layer.putalpha(m)
        tile = Image.alpha_composite(tile, layer)
    return tile



SIZES = [16, 20, 24, 32, 40, 48, 64, 128, 256]

if __name__ == "__main__":
    big = render(glyph_projetos, ORANGE)
    small = render(glyph_projetos, ORANGE, margin=150, stroke=2.1)          # traço mais grosso p/ tamanhos pequenos
    big.resize((256, 256), Image.LANCZOS).save(OUT / "icone.png")
    big.resize((256, 256), Image.LANCZOS).save(OUT.parent / "public" / "icone.png")
    frames = {s: (small if s <= 32 else big).resize((s, s), Image.LANCZOS) for s in SIZES}
    frames[256].save(OUT / "icone.ico", format="ICO", sizes=[(s, s) for s in SIZES],
                     append_images=[frames[s] for s in SIZES if s != 256])
    print("gerado icone.ico / icone.png")
