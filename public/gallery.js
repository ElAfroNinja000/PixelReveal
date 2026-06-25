// Galerie des œuvres terminées. Lit /gallery (méta) + /gallery/item (image complète) du worker.
const API =
  new URLSearchParams(location.search).get("api") ||
  (/^(localhost|127\.0\.0\.1)$/.test(location.hostname) || location.protocol === "file:"
    ? "http://127.0.0.1:8787"
    : location.origin); // prod : worker derrière le même origin (à ajuster au déploiement)

const hex = (h) => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];

function render(item) {
  const cv = document.createElement("canvas");
  cv.width = item.width;
  cv.height = item.height;
  cv.className = "thumb";
  const ctx = cv.getContext("2d");
  const img = ctx.createImageData(item.width, item.height);
  const pal = item.palette.map(hex);
  for (let i = 0; i < item.answer.length; i++) {
    const [r, g, b] = pal[item.answer[i]] || [0, 0, 0];
    const o = i * 4;
    img.data[o] = r; img.data[o + 1] = g; img.data[o + 2] = b; img.data[o + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
  return cv;
}

async function main() {
  let list;
  try {
    list = await (await fetch(`${API}/gallery`)).json();
  } catch {
    document.getElementById("empty").hidden = false;
    return;
  }
  if (!Array.isArray(list) || list.length === 0) {
    document.getElementById("empty").hidden = false;
    return;
  }
  const grid = document.getElementById("grid");
  for (const meta of list) {
    const card = document.createElement("figure");
    card.className = "gcard";
    const cap = document.createElement("figcaption");
    cap.textContent = `${meta.artworkId} · ${new Date(meta.ts).toLocaleDateString()}`;
    card.append(cap);
    grid.append(card);
    try {
      const item = await (await fetch(`${API}/gallery/item?key=${encodeURIComponent(meta.key)}`)).json();
      card.insertBefore(render(item), cap);
    } catch {
      /* image indisponible : on garde la légende */
    }
  }
}

main();
