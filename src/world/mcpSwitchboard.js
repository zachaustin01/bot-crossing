import * as THREE from 'three'
import * as BufferGeometryUtils from 'three/addons/utils/BufferGeometryUtils.js'
import { withCurve } from '../core/curve.js'

/**
 * The MCP switchboard — a small relay tower, the colony's one piece of fixed furniture
 * besides the ship. It has no crew of its own; its only job is to say **where** something
 * is happening. Whenever a thread calls an MCP tool, a beam fires from the top of the tower
 * down to the middle of that thread's plot, tinted with the plot's own accent, and fades out
 * over a couple of seconds. The plot's own border glows for as long as the beam is up (see
 * `Plot.setNight`'s `mcpPulse`), so the connection reads at both ends: the beam says where it
 * came from, the glowing tile says who lit up.
 *
 * Because the colony only learns about a call on the next poll (see `pulseMcpCall` in
 * `colony.js`), a beam means "an MCP call landed recently here," not "one is in flight right
 * now" — there is no faster signal to show truthfully.
 */

const BEAM_LIFETIME = 2.6
const MAX_BEAMS = 6
/** Unit length in local Z; stretched to the real distance per beam. */
const BEAM_WIDTH = 0.16
const UNIT_Z = new THREE.Vector3(0, 0, 1)

const HULL = 0x2c2f38
const HULL_LIGHT = 0x565b68
const METAL = 0x8f9299
const RING = 0x4f7ec9

const SURFACE = new Map([
  [HULL, [0.6, 0.35]],
  [HULL_LIGHT, [0.5, 0.3]],
  [METAL, [0.28, 0.85]],
  [RING, [0.4, 0.1]],
])
const DEFAULT_SURFACE = [0.55, 0.15]

export class MCPSwitchboard {
  constructor(scene, position) {
    this.group = new THREE.Group()
    this.group.position.copy(position)
    this.group.name = 'mcp-switchboard'
    scene.add(this.group)
    this.scene = scene

    this._buildTower()
    this._buildBeams()
  }

  _buildTower() {
    const parts = []
    const colors = []
    const push = (geo, color) => {
      parts.push(geo)
      colors.push(new THREE.Color(color))
    }

    const base = new THREE.CylinderGeometry(1.3, 1.55, 0.9, 10)
    base.translate(0, 0.45, 0)
    push(base, HULL)

    const collar = new THREE.CylinderGeometry(0.95, 1.1, 0.3, 10)
    collar.translate(0, 0.95, 0)
    push(collar, HULL_LIGHT)

    const mast = new THREE.CylinderGeometry(0.22, 0.3, 3.0, 8)
    mast.translate(0, 1.1 + 1.5, 0)
    push(mast, METAL)

    // Rungs of a dish ring near the top — the visual cue that this thing relays outward.
    for (let i = 0; i < 3; i++) {
      const r = 0.5 + i * 0.28
      const ring = new THREE.TorusGeometry(r, 0.06, 6, 16)
      ring.rotateX(Math.PI / 2)
      ring.translate(0, 3.5 + i * 0.22, 0)
      push(ring, RING)
    }

    // Six emitter ports around the collar rim — one per potential concurrent beam, echoing
    // the max beam count even though any port can fire any beam.
    for (let i = 0; i < 6; i++) {
      const a = (i / 6) * Math.PI * 2
      const nub = new THREE.SphereGeometry(0.13, 8, 6)
      nub.translate(Math.cos(a) * 1.05, 0.95, Math.sin(a) * 1.05)
      push(nub, METAL)
    }

    const merged = mergeWithColors(parts, colors)
    this.hull = new THREE.Mesh(merged, hullMaterial())
    this.hull.castShadow = true
    this.hull.receiveShadow = true
    this.group.add(this.hull)

    this.beaconMaterial = new THREE.MeshBasicMaterial({ color: 0x9fd8ff, toneMapped: true })
    this.beacon = new THREE.Mesh(new THREE.SphereGeometry(0.15, 10, 8), this.beaconMaterial)
    this.beacon.position.set(0, 4.2, 0)
    this.group.add(this.beacon)

    // Scorched-looking apron, same idea as the ship's, so the tower does not just stand on
    // bare scatterable ground.
    const apron = new THREE.Mesh(
      new THREE.CircleGeometry(3.2, 24),
      new THREE.MeshStandardMaterial({ color: 0x24242a, roughness: 1, transparent: true, opacity: 0.55 })
    )
    apron.rotation.x = -Math.PI / 2
    apron.position.y = 0.03
    apron.receiveShadow = true
    this.group.add(apron)

    // The very top of the mast, right by the beacon — where a beam visually leaves the tower.
    this.emitLocal = new THREE.Vector3(0, 4.2, 0)
  }

  /**
   * A small pool of reusable beam meshes, so firing calls never allocates. Parented straight
   * to the scene rather than to `this.group`: `fire()` positions each beam in world space
   * (its target is wherever the plot happens to be, nowhere near the tower's own origin), and
   * a child's `position` is local to its parent — added under the tower's own group, a
   * world-space position would be offset by the tower's position a second time.
   */
  _buildBeams() {
    const geo = new THREE.BoxGeometry(BEAM_WIDTH, BEAM_WIDTH, 1)
    geo.translate(0, 0, 0.5) // pivot at one end, so scale.z alone stretches it to length
    this.beams = []
    for (let i = 0; i < MAX_BEAMS; i++) {
      const material = new THREE.MeshBasicMaterial({
        color: 0xffffff,
        transparent: true,
        opacity: 0,
        depthWrite: false,
        toneMapped: false,
        blending: THREE.AdditiveBlending,
      })
      const mesh = new THREE.Mesh(geo, material)
      mesh.visible = false
      mesh.renderOrder = 6
      mesh.frustumCulled = false
      this.scene.add(mesh)
      this.beams.push({ mesh, life: 0 })
    }
  }

  /**
   * Fire a beam at a point in the colony (world space), tinted with that plot's own accent.
   * Steals the longest-idle slot when every beam is already lit — a burst of simultaneous
   * calls thins out gracefully rather than dropping the newest one.
   */
  fire(targetWorld, color) {
    this.group.updateWorldMatrix(true, false)
    const from = this.emitLocal.clone().applyMatrix4(this.group.matrixWorld)
    // The caller hands back a real point on the tile's edge, ground height included — the
    // beam's own job is just to connect the two points, in three dimensions, not to pick them.
    const to = targetWorld

    let slot = this.beams.find((b) => b.life <= 0)
    if (!slot) slot = this.beams.reduce((a, b) => (a.life < b.life ? a : b))

    const delta = new THREE.Vector3().subVectors(to, from)
    const dist = delta.length()
    slot.mesh.position.copy(from)
    slot.mesh.quaternion.setFromUnitVectors(UNIT_Z, delta.normalize())
    slot.mesh.scale.set(1, 1, dist)
    slot.mesh.material.color.set(color)
    slot.mesh.visible = true
    slot.life = BEAM_LIFETIME
  }

  /** Cut every beam immediately — used when the feature is switched off mid-flight. */
  clear() {
    for (const beam of this.beams) {
      beam.life = 0
      beam.mesh.visible = false
      beam.mesh.material.opacity = 0
    }
  }

  update(dt, elapsed, night) {
    const t = elapsed % 2.4
    const strobe = t < 0.1 ? 1 : 0.15
    this.beaconMaterial.color.setRGB(0.6 * strobe, 1.2 * strobe, 1.6 * strobe)

    for (const beam of this.beams) {
      if (beam.life <= 0) continue
      beam.life -= dt
      if (beam.life <= 0) {
        beam.mesh.visible = false
        beam.mesh.material.opacity = 0
        continue
      }
      // A quick flare in, then a longer fade — reads as a pulse rather than a slow leak.
      const frac = beam.life / BEAM_LIFETIME
      beam.mesh.material.opacity = Math.min(1, frac * 3) * frac
    }
  }

  dispose() {
    this.group.traverse((o) => {
      if (o.isMesh) {
        o.geometry.dispose()
        o.material.dispose()
      }
    })
    this.scene.remove(this.group)
    // Beams live directly on the scene, not under `this.group` — see `_buildBeams`. They all
    // share one geometry, so it is only disposed once even though every beam's own material is.
    this.beams[0]?.mesh.geometry.dispose()
    for (const { mesh } of this.beams) {
      mesh.material.dispose()
      this.scene.remove(mesh)
    }
  }
}

/** Same technique as the ship: one flat colour per merged part, baked into vertex colours. */
function mergeWithColors(parts, colors) {
  parts.forEach((geo, i) => {
    const count = geo.attributes.position.count
    const arr = new Float32Array(count * 3)
    const surf = new Float32Array(count * 2)
    const c = colors[i]
    const s = SURFACE.get(colors[i].getHex()) || DEFAULT_SURFACE
    for (let k = 0; k < count; k++) {
      arr[k * 3] = c.r
      arr[k * 3 + 1] = c.g
      arr[k * 3 + 2] = c.b
      surf[k * 2] = s[0]
      surf[k * 2 + 1] = s[1]
    }
    geo.setAttribute('color', new THREE.BufferAttribute(arr, 3))
    geo.setAttribute('aSurface', new THREE.BufferAttribute(surf, 2))
    geo.deleteAttribute('uv')
    if (!geo.attributes.normal) geo.computeVertexNormals()
  })
  const merged = BufferGeometryUtils.mergeGeometries(parts, false)
  parts.forEach((g) => g.dispose())
  return merged
}

function hullMaterial() {
  const mat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.55, metalness: 0.22 })
  mat.onBeforeCompile = (shader) => {
    withCurve(shader)
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>\n attribute vec2 aSurface;\n varying vec2 vSurface;`)
      .replace('#include <begin_vertex>', `#include <begin_vertex>\n vSurface = aSurface;`)
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\n varying vec2 vSurface;`)
      .replace('#include <roughnessmap_fragment>', 'float roughnessFactor = vSurface.x;')
      .replace('#include <metalnessmap_fragment>', 'float metalnessFactor = vSurface.y;')
  }
  return mat
}
