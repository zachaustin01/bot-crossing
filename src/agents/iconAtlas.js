import * as THREE from 'three'

/**
 * A rounded speech plate with a little tail pointing down at the astronaut. Shared by every
 * billboarded icon chip in the colony — status badges above the head, task chips beside the
 * shoulder — so the two read as one family instead of two different UI languages.
 *
 * Every turn in it is an arc, including the two where the tail leaves the bottom edge and the
 * one at the point, so the outline is tangent-continuous the whole way round. That is what keeps
 * it looking drawn rather than assembled at the magnification the closest zoom gives it: a corner
 * between two straight runs would put a mitre in the ring and a hard glint on the silhouette, and
 * a needle-sharp tip would thin out to nothing before it got there.
 */
export function platePath(ctx) {
  const left = 0.11
  const right = 0.89
  const top = 0.08
  const bottom = 0.74
  const r = 0.19
  // The tail is a wide, shallow wedge rather than a spike: at a fifth of the plate's width it
  // reads as part of the same shape, and it still has room for the fillets at its base and the
  // rounding at its point without either eating the other.
  const tailHalf = 0.105
  const tailY = 0.915
  const tailPoint = 0.038
  const tailFlare = 0.07

  ctx.beginPath()
  ctx.moveTo(left + r, top)
  ctx.arcTo(right, top, right, bottom, r)
  ctx.arcTo(right, bottom, left, bottom, r)
  ctx.arcTo(0.5 + tailHalf, bottom, 0.5, tailY, tailFlare)
  ctx.arcTo(0.5, tailY, 0.5 - tailHalf, bottom, tailPoint)
  ctx.arcTo(0.5 - tailHalf, bottom, left, bottom, tailFlare)
  ctx.arcTo(left, bottom, left, top, r)
  ctx.arcTo(left, top, right, top, r)
  ctx.closePath()
}

const ICON_VIEWBOX = 24
// MDI authors on a 24-unit grid and means the result to be read at 24 pixels. A chip is usually
// smaller than that, with a lit ring around it competing for the eye.

/**
 * How much of the cell the icon box covers, and where it sits. Centred on the *plate's body*
 * rather than on the cell, which runs lower because of the tail, and then lifted a hair further
 * because the tail pulls the eye down and a symbol centred by measurement reads low.
 */
const ICON_SIZE = 0.5
const ICON_X = 0.5
const ICON_Y = 0.405

/**
 * Filled, never stroked: MDI ships one closed path per icon, so the silhouette *is* the glyph
 * and there is nothing to outline. The path is scaled out of its own 24-unit space into the
 * cell, which is square, so that scale is uniform and nothing skews.
 */
function drawIcon(ctx, icon) {
  ctx.save()
  ctx.translate(ICON_X - ICON_SIZE / 2, ICON_Y - ICON_SIZE / 2)
  ctx.scale(ICON_SIZE / ICON_VIEWBOX, ICON_SIZE / ICON_VIEWBOX)
  // Nonzero winding, which is what the icons are authored for: the counter in a `?` or the
  // gap in an exit arrow is a subpath wound the other way, and it has to stay a hole.
  ctx.fill(icon, 'nonzero')
  ctx.restore()
}

/**
 * Build a `cols` x `rows` atlas of icon chips from MDI path data. Red channel = the glyph, green
 * channel = the plate's alpha, blue = a ring straddling the plate's edge — packing three masks
 * into one RGBA texture so a shader can composite a dark plate with a glowing symbol and its own
 * ring from a single sampler. See `indicators.js` for how the three channels are read back apart.
 *
 * Sized for the *closest* a chip is ever seen rather than the average, same reasoning as the
 * original badge atlas this was pulled out of: a chip holds a near-constant size on screen, so
 * leaning in is where it magnifies, and a cell comfortable at arm's length turns to mush there.
 */
export function buildIconAtlas(iconPaths, cols, rows, cellSize = 512) {
  const canvas = document.createElement('canvas')
  canvas.width = cellSize * cols
  canvas.height = cellSize * rows
  const ctx = canvas.getContext('2d')
  ctx.clearRect(0, 0, canvas.width, canvas.height)

  const icons = iconPaths.map((d) => new Path2D(d))

  icons.forEach((icon, index) => {
    const x = (index % cols) * cellSize
    const y = Math.floor(index / cols) * cellSize
    ctx.save()
    ctx.translate(x, y)
    ctx.scale(cellSize, cellSize)

    ctx.fillStyle = 'rgb(0,255,0)'
    platePath(ctx)
    ctx.fill()

    ctx.save()
    ctx.globalCompositeOperation = 'lighter'
    ctx.strokeStyle = 'rgb(0,0,255)'
    ctx.lineWidth = 0.055
    ctx.lineJoin = 'round'
    platePath(ctx)
    ctx.stroke()

    ctx.fillStyle = 'rgb(255,0,0)'
    drawIcon(ctx, icon)
    ctx.restore()
    ctx.restore()
  })

  const texture = new THREE.CanvasTexture(canvas)
  texture.colorSpace = THREE.NoColorSpace
  texture.minFilter = THREE.LinearMipmapLinearFilter
  texture.magFilter = THREE.LinearFilter
  texture.wrapS = texture.wrapT = THREE.ClampToEdgeWrapping
  // Chips are seen at a glance from any angle; a sharp one at 60° costs one texture flag.
  texture.anisotropy = 8
  return texture
}
