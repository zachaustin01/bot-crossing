import * as THREE from 'three'
import * as BufferGeometryUtils from 'three/addons/utils/BufferGeometryUtils.js'
import { createLabel } from './plots.js'

/**
 * The usage canister — a tank of glowing goo standing for this month's estimated spend
 * against a configured monthly budget.
 *
 * Two numbers, two different readouts, deliberately kept apart:
 *  - **fill height** is `1 − spend ÷ budget` — how much of the month's allowance is *left*,
 *    a fuel gauge rather than an odometer: full means plenty of runway, empty means none.
 *    This is also what the "N% left" flag above the tank says in words.
 *  - **colour** — on the goo and on the flag alike — is a traffic light for the *burn rate*
 *    against the calendar, independent of fill: green comfortably under pace, amber close to
 *    it, red over. A tank that is three-quarters full on day three of the month still glows
 *    red, because looking full is not the same as being on pace.
 */

const TANK_RADIUS = 1.35
const TANK_HEIGHT = 3.0
/** Leaves headroom so a 100% fill does not touch the cap. */
const GOO_MAX_HEIGHT = TANK_HEIGHT - 0.35
const BASE_Y = 0.4

/**
 * How far over pace this month's spend is, as a ratio: 1 means spending exactly in step with
 * the calendar, 2 means spending twice as fast as the budget allows for the days elapsed so
 * far. A pure function of three numbers — kept apart from any THREE.js so it is trivial to
 * unit test.
 */
export function burnRatio(spendThisMonth, budget, now = new Date()) {
  if (!(budget > 0)) return 1
  const day = now.getDate()
  const daysInMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate()
  const paceSoFar = (budget / daysInMonth) * day
  return paceSoFar > 0 ? spendThisMonth / paceSoFar : 1
}

/**
 * The traffic-light colour for the burn rate, shared by the goo and the flag: green
 * comfortably under pace, amber within shouting distance of it either way, red over.
 */
export function paceColor(ratio) {
  if (ratio < 0.85) return 0x4caf6a
  if (ratio <= 1.15) return 0xd9b23c
  return 0xd6543f
}

export class UsageCanister {
  constructor(scene, position) {
    this.group = new THREE.Group()
    this.group.position.copy(position)
    this.group.name = 'usage-canister'
    scene.add(this.group)
    this.scene = scene

    this._fraction = 0
    this._targetFraction = 0
    this._color = new THREE.Color(paceColor(1))
    this._targetColor = this._color.clone()

    this._buildTank()
  }

  _buildTank() {
    const base = new THREE.Mesh(
      new THREE.CylinderGeometry(TANK_RADIUS + 0.3, TANK_RADIUS + 0.45, 0.4, 16),
      new THREE.MeshStandardMaterial({ color: 0x34363c, roughness: 0.65, metalness: 0.3 })
    )
    base.position.y = 0.2
    base.castShadow = true
    base.receiveShadow = true
    this.group.add(base)

    const frameMat = new THREE.MeshStandardMaterial({ color: 0x9a9aa2, roughness: 0.4, metalness: 0.6 })
    const rings = []
    for (const y of [BASE_Y + 0.1, BASE_Y + TANK_HEIGHT]) {
      const ring = new THREE.TorusGeometry(TANK_RADIUS + 0.1, 0.06, 8, 20)
      ring.rotateX(Math.PI / 2)
      ring.translate(0, y, 0)
      rings.push(ring)
    }
    const struts = []
    for (let i = 0; i < 4; i++) {
      const a = (i / 4) * Math.PI * 2 + Math.PI / 4
      const s = new THREE.CylinderGeometry(0.06, 0.06, TANK_HEIGHT, 6)
      s.translate(Math.cos(a) * (TANK_RADIUS + 0.1), BASE_Y + TANK_HEIGHT / 2, Math.sin(a) * (TANK_RADIUS + 0.1))
      struts.push(s)
    }
    const frameGeo = BufferGeometryUtils.mergeGeometries([...rings, ...struts])
    rings.forEach((g) => g.dispose())
    struts.forEach((g) => g.dispose())
    const frame = new THREE.Mesh(frameGeo, frameMat)
    frame.castShadow = true
    this.group.add(frame)

    // Glass shell — an open-ended cylinder, so the goo inside is what actually reads as full
    // or empty rather than a painted level line.
    const glassGeo = new THREE.CylinderGeometry(TANK_RADIUS, TANK_RADIUS, TANK_HEIGHT, 24, 1, true)
    glassGeo.translate(0, BASE_Y + TANK_HEIGHT / 2, 0)
    this.glass = new THREE.Mesh(
      glassGeo,
      new THREE.MeshPhysicalMaterial({
        color: 0xdff3ff,
        transparent: true,
        opacity: 0.16,
        roughness: 0.05,
        metalness: 0,
        side: THREE.DoubleSide,
        depthWrite: false,
      })
    )
    this.group.add(this.glass)

    // The goo: a cylinder pivoted at its own base, so scaling its height alone is a fill
    // level rather than a fill that grows from the middle in both directions.
    const gooGeo = new THREE.CylinderGeometry(TANK_RADIUS * 0.92, TANK_RADIUS * 0.92, 1, 24)
    gooGeo.translate(0, 0.5, 0)
    this.gooMaterial = new THREE.MeshStandardMaterial({
      color: this._color,
      emissive: this._color,
      emissiveIntensity: 1,
      roughness: 0.35,
      metalness: 0,
      transparent: true,
      opacity: 0.94,
    })
    this.goo = new THREE.Mesh(gooGeo, this.gooMaterial)
    this.goo.position.y = BASE_Y
    this.goo.scale.y = 0.001
    this.group.add(this.goo)

    // Where a spend orb leaves from — the top of the tank.
    this.emitLocal = new THREE.Vector3(0, BASE_Y + TANK_HEIGHT + 0.2, 0)

    this.flag = null
    this._flagKey = null
  }

  /**
   * The "% left" flag above the tank. Rebuilt only when the rounded percentage or the pace
   * colour actually changes — `createLabel` bakes its text to a canvas once, the same
   * technique a project's name plate uses, so it is not something to redo every frame.
   */
  _updateFlag(remaining, ratio) {
    const pct = Math.round(remaining * 100)
    const color = paceColor(ratio)
    const key = `${pct}:${color}`
    if (this._flagKey === key) return
    this._flagKey = key

    if (this.flag) {
      this.group.remove(this.flag)
      this.flag.userData.dispose?.()
    }
    this.flag = createLabel(`${pct}% left`, color)
    // `createLabel` bakes a plate at opacity 0, hidden until whoever placed it fades it in —
    // a plot's own name plate does that on hover, but this flag has no such moment and is
    // meant to just always be there.
    this.flag.material.opacity = 1
    this.flag.visible = true
    this.flag.position.set(0, BASE_Y + TANK_HEIGHT + 0.75, 0)
    this.group.add(this.flag)
  }

  /** World position an orb should leave from. */
  emitWorld(out = new THREE.Vector3()) {
    this.group.updateWorldMatrix(true, false)
    return out.copy(this.emitLocal).applyMatrix4(this.group.matrixWorld)
  }

  /** The goo's current (animated) tint, for an orb to match without reaching into internals. */
  currentColor() {
    return this._color
  }

  /**
   * `remaining`: budget left ÷ budget, 0..1 — how full the tank should be. `ratio`: the burn
   * rate against the calendar (see `burnRatio`), which drives the traffic-light colour on
   * both the goo and the flag (see `paceColor`).
   */
  setUsage(remaining, ratio = 1) {
    this._targetFraction = THREE.MathUtils.clamp(remaining, 0, 1)
    this._targetColor.set(paceColor(ratio))
    this._updateFlag(this._targetFraction, ratio)
  }

  update(dt, elapsed, night) {
    const ease = Math.min(1, dt * 1.6)
    this._fraction += (this._targetFraction - this._fraction) * ease
    this._color.lerp(this._targetColor, ease)

    this.goo.scale.y = Math.max(0.001, this._fraction * GOO_MAX_HEIGHT)
    this.gooMaterial.color.copy(this._color)
    this.gooMaterial.emissive.copy(this._color)
    this.gooMaterial.emissiveIntensity = 0.85 + Math.sin(elapsed * 1.8) * 0.12 + night * 0.7
  }

  dispose() {
    // The flag's texture is only released by its own `userData.dispose`, not by the generic
    // mesh traversal below.
    this.flag?.userData.dispose?.()
    this.group.traverse((o) => {
      if (o.isMesh) {
        o.geometry.dispose()
        o.material.dispose()
      }
    })
    this.scene.remove(this.group)
  }
}
